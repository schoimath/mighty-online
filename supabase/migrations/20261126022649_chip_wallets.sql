-- Only the explicitly granted RPCs are exposed through PostgREST.
create schema mighty_private;
revoke all on schema mighty_private from public, anon, authenticated, service_role;

create table mighty_private.hands (
  id uuid primary key,
  room text not null check (room ~ '^[A-Z0-9]{6}$'),
  host_id uuid not null,
  seats uuid[] not null check (cardinality(seats) = 5),
  manifest text not null check (manifest ~ '^[0-9a-f]{64}$'),
  state jsonb not null,
  revision integer not null default 0,
  settled boolean not null default false,
  due_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index mighty_one_hand_per_room on mighty_private.hands(room) where not settled;
create index mighty_hands_due on mighty_private.hands(due_at) where not settled;

-- A hand can still settle against its original account ID if its login is deleted.
create table mighty_private.wallets (
  user_id uuid primary key,
  balance bigint not null,
  recover_on date,
  active_hand uuid references mighty_private.hands(id),
  check ((balance <= 0) = (recover_on is not null))
);
create index mighty_wallets_due on mighty_private.wallets(recover_on) where recover_on is not null;
create table mighty_private.chip_entries (
  id bigint generated always as identity primary key,
  user_id uuid not null references mighty_private.wallets(user_id),
  kind text not null check (kind in ('welcome','recovery','settlement')),
  hand_id uuid references mighty_private.hands(id),
  delta bigint not null,
  balance_after bigint not null,
  booked_at timestamptz not null default now(),
  check ((kind = 'settlement') = (hand_id is not null)),
  unique (user_id, hand_id)
);
create unique index mighty_one_welcome on mighty_private.chip_entries(user_id) where kind = 'welcome';

-- A newer seat approval replaces an older one. It binds the deal, room, seat
-- and the service's digest over participants, rules and opening conditions.
create table mighty_private.approvals (
  user_id uuid primary key references mighty_private.wallets(user_id),
  hand_id uuid not null, room text not null,
  seat integer not null check (seat between -1 and 4),
  manifest text not null, expires_at timestamptz not null
);
alter table mighty_private.hands enable row level security;
alter table mighty_private.wallets enable row level security;
alter table mighty_private.chip_entries enable row level security;
alter table mighty_private.approvals enable row level security;

create function mighty_private.confirmed_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  with granted as (
    insert into mighty_private.wallets(user_id,balance) values(new.id,1000)
    on conflict (user_id) do nothing returning user_id,balance
  )
  insert into mighty_private.chip_entries(user_id,kind,delta,balance_after)
    select user_id,'welcome',balance,balance from granted;
  return new;
end;
$$;
create trigger mighty_confirmed_wallet after insert or update of email_confirmed_at, email
on auth.users for each row when (new.email_confirmed_at is not null and coalesce(new.email,'') <> '')
execute function mighty_private.confirmed_account();
with granted as (
  insert into mighty_private.wallets(user_id,balance)
    select id,1000 from auth.users where email_confirmed_at is not null and coalesce(email,'') <> ''
    on conflict (user_id) do nothing returning user_id,balance
)
insert into mighty_private.chip_entries(user_id,kind,delta,balance_after)
  select user_id,'welcome',balance,balance from granted;

create function mighty_private.require_verified(p_user uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null
                and coalesce(email,'') <> '') then
    raise exception '이메일 인증을 완료한 계정으로 로그인해 주세요.' using errcode='42501';
  end if;
end;
$$;

-- Recheck a locked wallet at Korean midnight, both on the daily job and on
-- demand. A missed invocation cannot leave an account waiting until tomorrow.
create function mighty_private.recover(p_user uuid) returns integer
language plpgsql set search_path = '' as $$
declare
  previous record;
  recovered integer := 0;
begin
  for previous in select w.user_id,w.balance from mighty_private.wallets w
    where w.recover_on <= (now() at time zone 'Asia/Seoul')::date
      and (p_user is null or w.user_id=p_user) order by w.user_id for update
  loop
    update mighty_private.wallets set balance=100,recover_on=null where user_id=previous.user_id;
    insert into mighty_private.chip_entries(user_id,kind,delta,balance_after)
      values(previous.user_id,'recovery',100-previous.balance,100);
    recovered := recovered+1;
  end loop;
  return recovered;
end;
$$;
create function public.chips_recover_due() returns integer
language sql security definer set search_path = '' as $$
  select mighty_private.recover(null);
$$;

create function public.chip_wallet() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
begin
  perform mighty_private.require_verified(actor);
  perform mighty_private.recover(actor);
  return (select jsonb_build_object('balance',balance,'recoveryDate',recover_on)
          from mighty_private.wallets where user_id=actor);
end;
$$;

create function public.chips_ready(p_hand uuid,p_room text,p_seat integer,p_manifest text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  wallet mighty_private.wallets;
begin
  perform mighty_private.require_verified(actor);
  if p_hand is null or p_room is null or p_room !~ '^[A-Z0-9]{6}$' or
     p_seat is null or p_seat not between -1 and 4 or p_manifest is null or p_manifest !~ '^[0-9a-f]{64}$' then
    raise exception '참가할 방과 자리를 다시 확인해 주세요.';
  end if;
  select * into strict wallet from mighty_private.wallets where user_id=actor for update;
  if p_seat >= 0 then
    perform mighty_private.recover(actor);
    if (select balance from mighty_private.wallets where user_id=actor) <= 0 then
      raise exception '칩이 0 이하입니다. 관전하거나 무료로 연습할 수 있습니다.' using detail='insufficient_chips';
    end if;
    if wallet.active_hand is not null and wallet.active_hand<>p_hand then
      raise exception '이미 다른 판에 참가 중입니다.' using detail='active_hand';
    end if;
  end if;
  insert into mighty_private.approvals(user_id,hand_id,room,seat,manifest,expires_at)
    values(actor,p_hand,p_room,p_seat,p_manifest,now()+interval '5 minutes')
  on conflict (user_id) do update set hand_id=excluded.hand_id,room=excluded.room,
    seat=excluded.seat,manifest=excluded.manifest,expires_at=excluded.expires_at;
  return true;
end;
$$;

create function public.chips_active_hand() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
begin
  perform mighty_private.require_verified(actor);
  return (select active_hand from mighty_private.wallets where user_id=actor);
end;
$$;

create function mighty_private.hand_json(h mighty_private.hands) returns jsonb
language sql immutable strict set search_path = '' as $$
  select jsonb_build_object('hand',h.id,'room',h.room,'host',h.host_id,'seats',h.seats,
                            'state',h.state,'revision',h.revision,'settled',h.settled);
$$;
create function public.chips_read_hand(p_hand uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select mighty_private.hand_json(h) from mighty_private.hands h where h.id=p_hand;
$$;
create function public.chips_due_hands(p_limit integer) returns uuid[]
language sql security definer set search_path = '' as $$
  select array(select id from mighty_private.hands where not settled and due_at <= now()
               order by due_at,id limit greatest(0,least(p_limit,100)));
$$;

create function public.chips_start_hand(p_hand uuid,p_room text,p_host uuid,p_seats jsonb,p_state jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  hand_row mighty_private.hands;
  ordered_seats uuid[];
  actor uuid;
  seat_index integer;
  manifest_hash text := p_state->>'manifest';
  wallet mighty_private.wallets;
begin
  if p_hand is null or p_host is null or p_room is null or p_room !~ '^[A-Z0-9]{6}$' or
     manifest_hash is null or manifest_hash !~ '^[0-9a-f]{64}$' or
     jsonb_typeof(p_seats) is distinct from 'array' then raise exception '유효하지 않은 판 정보입니다.'; end if;
  if jsonb_array_length(p_seats) <> 5 or exists(select 1 from jsonb_array_elements(p_seats) e
      where jsonb_typeof(e) not in ('null','string')) then raise exception '다섯 자리를 확인해 주세요.'; end if;
  ordered_seats := array(select value::uuid from jsonb_array_elements_text(p_seats) with ordinality s(value,position)
                         order by position);
  if (select count(v)=0 or count(v)<>count(distinct v) from unnest(ordered_seats) v) then
    raise exception '실제 참가자와 중복된 자리를 확인해 주세요.';
  end if;
  -- Serialize starts and retries for a room before acquiring participant locks.
  -- Competing rooms lock their shared participants in the same UUID order.
  perform pg_advisory_xact_lock(hashtextextended('mighty-room-' || p_room,0));
  select * into hand_row from mighty_private.hands where id=p_hand;
  if found then
    if hand_row.host_id<>p_host or hand_row.room<>p_room or hand_row.seats is distinct from ordered_seats
       or hand_row.manifest<>manifest_hash then raise exception '이미 다른 판에 사용한 식별자입니다.'; end if;
    return mighty_private.hand_json(hand_row);
  end if;
  for actor in select distinct v from unnest(array_append(ordered_seats,p_host)) v where v is not null order by v
  loop
    perform mighty_private.require_verified(actor);
    select * into strict wallet from mighty_private.wallets where user_id=actor for update;
    seat_index := coalesce(array_position(ordered_seats,actor)-1,-1);
    if seat_index >= 0 then
      perform mighty_private.recover(actor);
      if (select balance from mighty_private.wallets where user_id=actor) <= 0 then
        raise exception '참가자의 칩 잔액이 0 이하입니다.' using detail='insufficient_chips';
      end if;
      if wallet.active_hand is not null then
        raise exception '이미 다른 판에 참가 중입니다.' using detail='active_hand';
      end if;
    end if;
    if not exists (select 1 from mighty_private.approvals a where a.user_id=actor and a.hand_id=p_hand
      and a.room=p_room and a.seat=seat_index and a.manifest=manifest_hash and a.expires_at > now()) then
      raise exception '참가 동의를 다시 확인해 주세요.' using detail='approval_required';
    end if;
  end loop;
  insert into mighty_private.hands(id,room,host_id,seats,manifest,state,due_at)
    values(p_hand,p_room,p_host,ordered_seats,manifest_hash,p_state,
           coalesce(to_timestamp((p_state->>'dueAt')::double precision/1000),now()+interval '1 minute'))
    returning * into hand_row;
  update mighty_private.wallets set active_hand=p_hand where user_id=any(ordered_seats);
  delete from mighty_private.approvals where hand_id=p_hand and user_id=any(array_append(ordered_seats,p_host));
  return mighty_private.hand_json(hand_row);
end;
$$;

create function public.chips_update_hand(p_hand uuid,p_revision integer,p_state jsonb,p_deltas jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  hand_row mighty_private.hands;
  deltas integer[];
  new_balance bigint;
  entry record;
begin
  select * into strict hand_row from mighty_private.hands where id=p_hand for update;
  if hand_row.settled or p_revision is distinct from hand_row.revision then
    return mighty_private.hand_json(hand_row) || jsonb_build_object('applied',false);
  end if;
  if jsonb_typeof(p_state) is distinct from 'object' or
     (p_state->>'manifest') is distinct from hand_row.manifest then raise exception '잘못된 판 상태입니다.'; end if;
  if p_deltas is not null then
    if jsonb_typeof(p_deltas) <> 'array' or jsonb_array_length(p_deltas)<>5 or
       exists(select 1 from jsonb_array_elements(p_deltas) d where jsonb_typeof(d) <> 'number'
                or d::text !~ '^-?[0-9]+$') then raise exception '다섯 자리의 점수를 확인해 주세요.'; end if;
    deltas := array(select value::integer from jsonb_array_elements_text(p_deltas) with ordinality d(value,position)
                    order by position);
    if (select sum(delta) from unnest(deltas) delta) <> 0 then raise exception '정산의 합계가 맞지 않습니다.'; end if;
    for entry in select uid,deltas[position::integer] delta from unnest(hand_row.seats) with ordinality s(uid,position)
                  where uid is not null order by uid
    loop
      update mighty_private.wallets set balance=balance+entry.delta,active_hand=null,
        recover_on=case when balance+entry.delta<=0 then (now() at time zone 'Asia/Seoul')::date+1 end
        where user_id=entry.uid and active_hand=p_hand returning balance into strict new_balance;
      insert into mighty_private.chip_entries(user_id,kind,hand_id,delta,balance_after)
        values(entry.uid,'settlement',p_hand,entry.delta,new_balance);
    end loop;
  end if;
  update mighty_private.hands set state=p_state,revision=revision+1,settled=p_deltas is not null,
    due_at=case when p_deltas is null then
      coalesce(to_timestamp((p_state->>'dueAt')::double precision/1000),now()+interval '1 minute') end
    where id=p_hand returning * into hand_row;
  return mighty_private.hand_json(hand_row) || jsonb_build_object('applied',true);
end;
$$;

revoke all on all tables in schema mighty_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema mighty_private from public, anon, authenticated, service_role;
revoke all on all functions in schema mighty_private from public, anon, authenticated, service_role;
revoke all on function public.chip_wallet(), public.chips_ready(uuid,text,integer,text), public.chips_active_hand(),
  public.chips_start_hand(uuid,text,uuid,jsonb,jsonb), public.chips_read_hand(uuid),
  public.chips_update_hand(uuid,integer,jsonb,jsonb), public.chips_due_hands(integer), public.chips_recover_due()
  from public, anon, authenticated, service_role;
grant execute on function public.chip_wallet(), public.chips_ready(uuid,text,integer,text), public.chips_active_hand()
  to authenticated;
grant execute on function public.chips_start_hand(uuid,text,uuid,jsonb,jsonb), public.chips_read_hand(uuid),
  public.chips_update_hand(uuid,integer,jsonb,jsonb), public.chips_due_hands(integer), public.chips_recover_due()
  to service_role;
