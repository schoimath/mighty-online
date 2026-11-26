-- A room UUID follows the table across hands and PeerJS host changes. The
-- six-character invitation code alone never authorizes a chat operation.
create table mighty_private.chat_rooms (
  id uuid primary key,
  room text not null check (room ~ '^[A-Z0-9]{6}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  controller_id uuid,
  controller_digest bytea not null,
  term integer not null default 1,
  successors jsonb not null default '[]',
  lease_until timestamptz not null default clock_timestamp() + interval '25 seconds',
  message_count bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  last_message_at timestamptz
);
create table mighty_private.chat_messages (
  room_id uuid not null references mighty_private.chat_rooms(id) on delete cascade,
  seq bigint not null,
  request_id uuid not null,
  seat smallint not null check (seat between -1 and 4),
  nickname text not null check (length(nickname) between 1 and 16),
  body text not null check (length(body) between 1 and 280),
  sent_at timestamptz not null default clock_timestamp(),
  primary key (room_id,seq),
  unique (room_id,request_id)
);
-- The host can register a deal ID before issuing its idempotent start request.
-- An uncommitted offer is never counted as a played hand. A different host
-- cannot reserve another account's hand identifier in that account's namespace.
create table mighty_private.chat_hand_links (
  host_id uuid not null references auth.users(id) on delete cascade,
  hand_id uuid not null,
  room_id uuid not null references mighty_private.chat_rooms(id) on delete cascade,
  primary key (host_id,hand_id)
);
create index mighty_chat_room_hands on mighty_private.chat_hand_links(room_id,hand_id);
alter table mighty_private.chat_rooms enable row level security;
alter table mighty_private.chat_messages enable row level security;
alter table mighty_private.chat_hand_links enable row level security;
revoke all on mighty_private.chat_rooms,mighty_private.chat_messages,mighty_private.chat_hand_links from public,anon,authenticated,service_role;

create function mighty_private.chat_digest(credential text) returns bytea
language plpgsql immutable set search_path='' as $$
begin
  if credential is null or credential !~ '^[0-9a-f]{64}$' then
    raise exception '방 연결을 확인해 주세요.' using errcode='42501';
  end if;
  return sha256(convert_to(credential,'UTF8'));
end;
$$;

-- Taking a row lock serializes handoff, append and roster updates, including
-- operations that raced with the moment ownership changed.
create function mighty_private.chat_controller(room_id uuid,credential text,expected_term integer)
returns mighty_private.chat_rooms language plpgsql set search_path='' as $$
declare r mighty_private.chat_rooms;
begin
  select * into r from mighty_private.chat_rooms c where c.id=room_id for update;
  if r.id is null or r.term is distinct from expected_term
      or r.controller_digest<>mighty_private.chat_digest(credential)
      or (r.controller_id is not null and r.controller_id is distinct from auth.uid()) then
    raise exception '방 연결을 확인해 주세요.' using errcode='42501';
  end if;
  return r;
end;
$$;
create function public.mighty_room_chat_open(p_room_id uuid,p_room text,p_credential text) returns integer
language plpgsql security definer set search_path='' as $$
declare r mighty_private.chat_rooms; actor uuid:=auth.uid(); digest bytea:=mighty_private.chat_digest(p_credential);
begin
  if p_room_id is null or p_room is null or p_room !~ '^[A-Z0-9]{6}$' then
    raise exception '방 정보를 확인해 주세요.' using errcode='22023';
  end if;
  select * into r from mighty_private.chat_rooms where id=p_room_id;
  if not found then
    perform mighty_private.require_verified(actor);
    insert into mighty_private.chat_rooms(id,room,owner_id,controller_id,controller_digest)
      values(p_room_id,p_room,actor,actor,digest) on conflict(id) do nothing;
    select * into r from mighty_private.chat_rooms where id=p_room_id;
  end if;
  if r.room<>p_room or r.controller_digest<>digest or
      (r.controller_id is not null and r.controller_id is distinct from actor) then
    raise exception '방 연결을 확인해 주세요.' using errcode='42501';
  end if;
  return r.term;
end;
$$;

create function public.mighty_room_chat_successors(p_room_id uuid,p_credential text,p_term integer,p_successors jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare r mighty_private.chat_rooms; candidate jsonb;
begin
  r:=mighty_private.chat_controller(p_room_id,p_credential,p_term);
  if jsonb_typeof(p_successors) is distinct from 'array' or jsonb_array_length(p_successors)>128 then
    raise exception '후임 목록을 확인해 주세요.' using errcode='22023';
  end if;
  for candidate in select value from jsonb_array_elements(p_successors) loop
    if jsonb_typeof(candidate) is distinct from 'object' or not (candidate ? 'accountId')
        or coalesce(candidate->>'digest','') !~ '^[0-9a-f]{64}$'
        or candidate->>'digest'=encode(r.controller_digest,'hex')
        or ((candidate->>'accountId') is not null and (candidate->>'accountId') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
        or (candidate - 'accountId' - 'digest') <> '{}'::jsonb then
      raise exception '후임 정보를 확인해 주세요.' using errcode='22023';
    end if;
  end loop;
  if (select count(distinct value->>'digest') from jsonb_array_elements(p_successors))<>jsonb_array_length(p_successors) then
    raise exception '후임 정보가 중복되었습니다.' using errcode='22023';
  end if;
  update mighty_private.chat_rooms set successors=p_successors,lease_until=clock_timestamp()+interval '25 seconds' where id=r.id;
end;
$$;
create function mighty_private.chat_promote(room_id uuid,candidate jsonb) returns integer
language sql set search_path='' as $$
  update mighty_private.chat_rooms set controller_digest=decode(candidate->>'digest','hex'),
    controller_id=(candidate->>'accountId')::uuid,term=term+1,
    successors=(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(successors) where value->>'digest'<>candidate->>'digest'),
    lease_until=clock_timestamp()+interval '25 seconds' where id=room_id returning term;
$$;
create function public.mighty_room_chat_transfer(p_room_id uuid,p_credential text,p_term integer,p_digest text)
returns integer language plpgsql security definer set search_path='' as $$
declare r mighty_private.chat_rooms; candidate jsonb;
begin
  r:=mighty_private.chat_controller(p_room_id,p_credential,p_term);
  select value into candidate from jsonb_array_elements(r.successors) where value->>'digest'=p_digest;
  if candidate is null then raise exception '승인된 후임을 확인해 주세요.' using errcode='42501'; end if;
  return mighty_private.chat_promote(r.id,candidate);
end;
$$;
create function public.mighty_room_chat_claim(p_room_id uuid,p_credential text,p_term integer)
returns integer language plpgsql security definer set search_path='' as $$
declare r mighty_private.chat_rooms; candidate jsonb; digest bytea:=mighty_private.chat_digest(p_credential);
begin
  select * into r from mighty_private.chat_rooms where id=p_room_id for update;
  if r.id is null or p_term is null or p_term<1 or p_term>r.term then return 0; end if;
  if r.controller_digest=digest and (r.controller_id is null or r.controller_id=auth.uid()) then return r.term; end if;
  if r.lease_until>clock_timestamp() then return 0; end if;
  select value into candidate from jsonb_array_elements(r.successors) where value->>'digest'=encode(digest,'hex')
    and ((value->>'accountId') is null or (value->>'accountId')::uuid=auth.uid());
  if candidate is null then return 0; end if;
  return mighty_private.chat_promote(r.id,candidate);
end;
$$;
create function public.mighty_room_chat_append(p_room_id uuid,p_credential text,p_term integer,p_request uuid,p_seat integer,p_name text,p_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r mighty_private.chat_rooms; m mighty_private.chat_messages;
begin
  r:=mighty_private.chat_controller(p_room_id,p_credential,p_term);
  if p_request is null or p_seat is null or p_seat not between -1 and 4 or
     length(trim(coalesce(p_name,''))) not between 1 and 16 or length(trim(coalesce(p_text,''))) not between 1 and 280 then
    raise exception '채팅 내용과 이름을 확인해 주세요.' using errcode='22023';
  end if;
  select * into m from mighty_private.chat_messages where room_id=r.id and request_id=p_request;
  if not found then
    insert into mighty_private.chat_messages(room_id,seq,request_id,seat,nickname,body)
      values(r.id,r.message_count+1,p_request,p_seat,trim(p_name),trim(p_text)) returning * into m;
    update mighty_private.chat_rooms set message_count=m.seq,last_message_at=m.sent_at where id=r.id;
  elsif m.seat<>p_seat or m.nickname<>trim(p_name) or m.body<>trim(p_text) then
    raise exception '이미 처리된 채팅 요청입니다.' using errcode='22023';
  end if;
  return jsonb_build_object('id',m.seq,'time',floor(extract(epoch from m.sent_at)*1000)::bigint,'name',m.nickname,'text',m.body,'seat',m.seat,'replayed',m.seq<=r.message_count);
end;
$$;
create function public.mighty_room_chat_link_hand(p_room_id uuid,p_credential text,p_term integer,p_hand uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r mighty_private.chat_rooms; actor uuid:=auth.uid();
begin
  r:=mighty_private.chat_controller(p_room_id,p_credential,p_term);
  perform mighty_private.require_verified(actor);
  if p_hand is null or exists(select 1 from mighty_private.hands h where h.id=p_hand and (h.host_id<>actor or h.room<>r.room)) then
    raise exception '해당 방의 대국을 확인해 주세요.' using errcode='22023';
  end if;
  insert into mighty_private.chat_hand_links(host_id,hand_id,room_id) values(actor,p_hand,p_room_id) on conflict do nothing;
  if not exists(select 1 from mighty_private.chat_hand_links where host_id=actor and hand_id=p_hand and room_id=r.id) then
    raise exception '이미 다른 방에 연결된 대국입니다.' using errcode='22023';
  end if;
end;
$$;

-- Deal-host and room-code matching keep the same table together after handoff.
create view mighty_private.room_deal_history as
  select h.id,h.room,coalesce(r.owner_id,h.host_id) as owner_id,r.id as room_id,h.created_at,h.settled
    from mighty_private.hands h left join mighty_private.chat_hand_links l on l.hand_id=h.id and l.host_id=h.host_id
    left join mighty_private.chat_rooms r on r.id=l.room_id and r.room=h.room;
revoke all on mighty_private.room_deal_history from public,anon,authenticated,service_role;
create or replace function public.mighty_admin_rooms(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare skip_rows bigint;
begin
  perform mighty_private.check_admin();
  skip_rows:=mighty_private.admin_page_offset(p_page);
  return (with deals as (
    select room,owner_id,room_id,count(*) as hands,count(*) filter(where not settled) as active,
      min(created_at) as first_at,max(created_at) as last_at from mighty_private.room_deal_history group by room,owner_id,room_id
  ), rooms as (
    select coalesce(r.room,d.room) as room,coalesce(r.owner_id,d.owner_id) as "hostId",r.id as "roomId",
      coalesce(d.hands,0) as "handCount",coalesce(d.active,0) as "activeCount",coalesce(r.message_count,0) as "chatCount",
      d.first_at as "firstHandAt",d.last_at as "lastHandAt",coalesce(r.created_at,d.first_at) as "createdAt",
      greatest(d.last_at,r.last_message_at,r.created_at) as "lastActivityAt"
    from deals d full join mighty_private.chat_rooms r on d.room_id=r.id
    where d.hands is not null or r.message_count>0
  ), page_rooms as (
    select * from rooms order by "lastActivityAt" desc,room,"hostId","roomId" limit 20 offset skip_rows
  ), items as (
    select p.*,u.email,u.raw_user_meta_data->>'nickname' as nickname from page_rooms p left join auth.users u on u.id=p."hostId"
  )
  select jsonb_build_object('page',p_page,'pageSize',20,'total',(select count(*) from rooms),
    'items',coalesce(jsonb_agg(to_jsonb(i) order by i."lastActivityAt" desc,i.room,i."hostId",i."roomId"),'[]'::jsonb)) from items i);
end;
$$;

create function public.mighty_admin_room_session_hands(p_room text,p_host_id uuid,p_room_id uuid,p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare skip_rows bigint;
begin
  perform mighty_private.check_admin();
  skip_rows:=mighty_private.admin_page_offset(p_page);
  if p_room is null or p_room !~ '^[A-Z0-9]{6}$' or p_host_id is null then
    raise exception '방 정보를 확인해 주세요.' using errcode='22023';
  end if;
  return (with matches as (
    select h.id,h.created_at from mighty_private.room_deal_history h where h.room=p_room and h.owner_id=p_host_id and h.room_id is not distinct from p_room_id
  ), page_hands as (
    select * from matches order by created_at desc,id desc limit 20 offset skip_rows
  ), totals as (select count(*) as count from matches), items as (
    select h.id,h.created_at as "createdAt",
      t.count-skip_rows-row_number() over(order by h.created_at desc,h.id desc)+1 as "handNumber",
      h.settled,h.state#>>'{round,phase}' as phase,h.state->'names' as names,
      cardinality(array_remove(h.seats,null::uuid)) as "humanCount",
      h.state#>'{round,bid,points}' as contract,h.state#>'{round,result,points}' as points,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id',e.id,'userId',e.user_id,'email',u.email,
        'nickname',coalesce(nullif(u.raw_user_meta_data->>'nickname',''),h.state->'names'->>(array_position(h.seats,e.user_id)-1)),
        'delta',e.delta,'balanceAfter',e.balance_after,'at',e.booked_at) order by e.id)
        from mighty_private.chip_entries e left join auth.users u on u.id=e.user_id
        where e.hand_id=h.id),'[]'::jsonb) as entries
    from page_hands p join mighty_private.hands h on h.id=p.id cross join totals t
  )
  select jsonb_build_object('page',p_page,'pageSize',20,'total',(select count from totals),
    'items',coalesce(jsonb_agg(to_jsonb(i) order by i."createdAt" desc,i.id desc),'[]'::jsonb)) from items i);
end;
$$;

create function public.mighty_admin_room_chat(p_room text,p_host_id uuid,p_room_id uuid,p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare skip_rows bigint;
begin
  perform mighty_private.check_admin();
  skip_rows:=2*mighty_private.admin_page_offset(p_page);
  return (with room as (
    select r.id,r.message_count from mighty_private.chat_rooms r where r.id=p_room_id and r.owner_id=p_host_id and r.room=p_room
  ), items as (
    select m.seq as id,m.seat,m.nickname as name,m.body as text,floor(extract(epoch from m.sent_at)*1000)::bigint as time
    from mighty_private.chat_messages m join room r on r.id=m.room_id order by m.seq desc limit 40 offset skip_rows
  )
  select jsonb_build_object('page',p_page,'pageSize',40,'total',coalesce((select message_count from room),0),
    'items',coalesce(jsonb_agg(to_jsonb(i) order by i.id desc),'[]'::jsonb)) from items i);
end;
$$;
revoke all on function mighty_private.chat_digest(text),mighty_private.chat_controller(uuid,text,integer),mighty_private.chat_promote(uuid,jsonb),
  public.mighty_room_chat_open(uuid,text,text),public.mighty_room_chat_append(uuid,text,integer,uuid,integer,text,text),
  public.mighty_room_chat_successors(uuid,text,integer,jsonb),public.mighty_room_chat_transfer(uuid,text,integer,text),
  public.mighty_room_chat_claim(uuid,text,integer),public.mighty_room_chat_link_hand(uuid,text,integer,uuid),
  public.mighty_admin_room_session_hands(text,uuid,uuid,integer),public.mighty_admin_room_chat(text,uuid,uuid,integer)
  from public,anon,authenticated,service_role;
-- These functions require the current room's high-entropy credential.
grant execute on function public.mighty_room_chat_open(uuid,text,text),public.mighty_room_chat_append(uuid,text,integer,uuid,integer,text,text),
  public.mighty_room_chat_successors(uuid,text,integer,jsonb),public.mighty_room_chat_transfer(uuid,text,integer,text),
  public.mighty_room_chat_claim(uuid,text,integer) to anon,authenticated;
grant execute on function public.mighty_room_chat_link_hand(uuid,text,integer,uuid) to authenticated;
-- check_admin() inside each reporting function verifies the administrator,
-- active Auth session AND installation key before accessing any data.
grant execute on function public.mighty_admin_room_session_hands(text,uuid,uuid,integer),public.mighty_admin_room_chat(text,uuid,uuid,integer) to authenticated;

-- Only the authoritative game service supplies p_actor after verifying its JWT.
create function public.mighty_hand_room_controller(p_hand_id uuid,p_credential text,p_term bigint,p_actor uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from mighty_private.hands h join mighty_private.chat_hand_links l on l.hand_id=h.id and l.host_id=h.host_id
    join mighty_private.chat_rooms r on r.id=l.room_id and r.room=h.room
    where h.id=p_hand_id and r.term=p_term and p_credential ~ '^[0-9a-f]{64}$'
      and r.controller_digest=sha256(convert_to(p_credential,'UTF8')) and r.controller_id is not distinct from p_actor);
$$;
revoke all on function public.mighty_hand_room_controller(uuid,text,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.mighty_hand_room_controller(uuid,text,bigint,uuid) to service_role;
