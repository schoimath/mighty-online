create table mighty_private.admin_installations (
  user_id uuid not null references auth.users(id) on delete cascade,
  key_digest bytea not null check (octet_length(key_digest) = 32),
  primary key (user_id, key_digest)
);
create table mighty_private.login_events (
  id bigint generated always as identity primary key,
  session_id uuid not null unique,
  user_id uuid not null,
  signed_in_at timestamptz not null
);
create index mighty_login_history on mighty_private.login_events(signed_in_at desc, id desc);
create index mighty_member_login_history on mighty_private.login_events(user_id, signed_in_at desc, id desc);
alter table mighty_private.admin_installations enable row level security;
alter table mighty_private.login_events enable row level security;
revoke all on mighty_private.admin_installations, mighty_private.login_events from public, anon, authenticated, service_role;
revoke all on sequence mighty_private.login_events_id_seq from public, anon, authenticated, service_role;

-- Record the creation of a login session once. Token refreshes update the same session.
create function mighty_private.record_login_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into mighty_private.login_events(session_id,user_id,signed_in_at)
  values(new.id,new.user_id,coalesce(new.created_at,now()))
  on conflict (session_id) do nothing;
  return new;
end;
$$;
revoke all on function mighty_private.record_login_event() from public, anon, authenticated, service_role;
create trigger mighty_record_signin after insert on auth.sessions
for each row execute function mighty_private.record_login_event();
insert into mighty_private.login_events(session_id,user_id,signed_in_at)
select id,user_id,created_at from auth.sessions where created_at is not null
on conflict (session_id) do nothing;

create function mighty_private.check_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  local_key text := nullif(current_setting('request.headers',true),'')::jsonb ->> 'x-mighty-admin-key';
begin
  if local_key is null or length(local_key) <> 43 or not exists (
    select 1 from mighty_private.admin_installations a
      join auth.users u on u.id=a.user_id
      join auth.sessions s on s.user_id=u.id and s.id::text=(auth.jwt()->>'session_id')
    where a.user_id=auth.uid() and u.email_confirmed_at is not null and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now())
      and (s.not_after is null or s.not_after > now())
      and a.key_digest=sha256(convert_to(local_key,'UTF8'))
  ) then raise exception '관리자 계정과 등록된 컴퓨터를 확인해 주세요.' using errcode='42501'; end if;
end;
$$;
revoke all on function mighty_private.check_admin() from public, anon, authenticated, service_role;

create function mighty_private.admin_page_offset(p_page integer) returns bigint
language plpgsql stable set search_path = '' as $$
begin
  perform mighty_private.check_admin();
  if p_page is null or p_page < 1 then raise exception '페이지 번호를 확인해 주세요.' using errcode='22023'; end if;
  return (p_page::bigint-1)*20;
end;
$$;
revoke all on function mighty_private.admin_page_offset(integer) from public, anon, authenticated, service_role;

create function public.mighty_admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform mighty_private.check_admin();
  return jsonb_build_object(
    'members',(select count(*) from auth.users where deleted_at is null),
    'verified',(select count(*) from auth.users where email_confirmed_at is not null and deleted_at is null),
    'activeHands',(select count(*) from mighty_private.hands where not settled),
    'settledHands',(select count(*) from mighty_private.hands where settled),
    'totalChips',(select coalesce(sum(balance),0) from mighty_private.wallets));
end;
$$;
create function public.mighty_admin_members(p_query text default '',p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  skip_rows bigint := mighty_private.admin_page_offset(p_page);
  needle text := lower(btrim(coalesce(p_query,'')));
begin
  if length(needle)>200 then raise exception '검색어가 너무 깁니다.' using errcode='22023'; end if;
  return (with members as (
    select u.id,u.email,coalesce(u.raw_user_meta_data->>'nickname','') as nickname,
      u.email_confirmed_at is not null as confirmed,w.balance,u.created_at as "createdAt",
      u.last_sign_in_at as "lastSignInAt"
    from auth.users u left join mighty_private.wallets w on w.user_id=u.id
    where u.deleted_at is null and (needle='' or strpos(lower(u.email),needle)>0
      or strpos(lower(coalesce(u.raw_user_meta_data->>'nickname','')),needle)>0)
  ), page_rows as (select * from members order by "createdAt" desc,id limit 20 offset skip_rows)
  select jsonb_build_object('page',p_page,'pageSize',20,'total',(select count(*) from members),
    'items',coalesce((select jsonb_agg(to_jsonb(p) order by p."createdAt" desc,p.id) from page_rows p),'[]'::jsonb)));
end;
$$;

create function public.mighty_admin_hands(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare skip_rows bigint := mighty_private.admin_page_offset(p_page);
begin
  return (with page_rows as (
    select h.id,h.room,h.settled,h.created_at as "createdAt",h.state#>>'{round,phase}' as phase,
      h.state->'names' as names,cardinality(array_remove(h.seats,null::uuid)) as "humanCount",
      h.state#>'{round,bid,points}' as contract,h.state#>'{round,result,points}' as points
    from mighty_private.hands h order by h.created_at desc,h.id limit 20 offset skip_rows)
  select jsonb_build_object('page',p_page,'pageSize',20,'total',(select count(*) from mighty_private.hands),
    'items',coalesce((select jsonb_agg(to_jsonb(p) order by p."createdAt" desc,p.id) from page_rows p),'[]'::jsonb)));
end;
$$;

create function public.mighty_admin_ledger(p_page integer default 1,p_user_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare skip_rows bigint := mighty_private.admin_page_offset(p_page);
begin
  return (with page_rows as (
    select e.id,e.user_id as "userId",u.email,u.raw_user_meta_data->>'nickname' as nickname,
      e.kind,e.delta,e.balance_after as "balanceAfter",e.booked_at as at,h.room,
      case e.kind when 'welcome' then '이메일 인증 가입 지급' when 'recovery' then '다음 날 잔액 복구'
                  when 'settlement' then '대국 점수 정산' end as reason
    from mighty_private.chip_entries e left join auth.users u on u.id=e.user_id
    left join mighty_private.hands h on h.id=e.hand_id
    where p_user_id is null or e.user_id=p_user_id order by e.id desc limit 20 offset skip_rows)
  select jsonb_build_object('page',p_page,'pageSize',20,
    'total',(select count(*) from mighty_private.chip_entries where p_user_id is null or user_id=p_user_id),
    'items',coalesce((select jsonb_agg(to_jsonb(p) order by p.id desc) from page_rows p),'[]'::jsonb)));
end;
$$;

create function public.mighty_admin_logins(p_page integer default 1,p_user_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare skip_rows bigint := mighty_private.admin_page_offset(p_page);
begin
  return (with page_rows as (
    select e.id,e.user_id as "userId",u.email,u.raw_user_meta_data->>'nickname' as nickname,e.signed_in_at as at
    from mighty_private.login_events e left join auth.users u on u.id=e.user_id
    where p_user_id is null or e.user_id=p_user_id order by e.signed_in_at desc,e.id desc limit 20 offset skip_rows)
  select jsonb_build_object('page',p_page,'pageSize',20,
    'total',(select count(*) from mighty_private.login_events where p_user_id is null or user_id=p_user_id),
    'items',coalesce((select jsonb_agg(to_jsonb(p) order by p.at desc,p.id desc) from page_rows p),'[]'::jsonb)));
end;
$$;

revoke all on function public.mighty_admin_overview(),public.mighty_admin_members(text,integer),
 public.mighty_admin_hands(integer),public.mighty_admin_ledger(integer,uuid),public.mighty_admin_logins(integer,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.mighty_admin_overview(),public.mighty_admin_members(text,integer),
 public.mighty_admin_hands(integer),public.mighty_admin_ledger(integer,uuid),public.mighty_admin_logins(integer,uuid)
 to authenticated;
