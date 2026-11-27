-- One persistent revision per table prevents a delayed browser operation from
-- recreating a closed room or writing into its successor.
create table mighty_private.public_lobbies (
  slot smallint primary key references mighty_private.directory_slots(slot) check (slot between 1 and 4),
  revision bigint not null default 0,
  room_id uuid unique references mighty_private.chat_rooms(id) on delete set null,
  state jsonb
);
insert into mighty_private.public_lobbies(slot) select generate_series(1,4);
alter table mighty_private.public_lobbies enable row level security;
revoke all on mighty_private.public_lobbies from public,anon,authenticated,service_role;

-- Old tabs may continue a live table or finish settling its hand. Only the
-- lobby service can assign the next archive to one of the four public slots.
create function mighty_private.public_directory_gate() returns trigger
language plpgsql security definer set search_path='' as $$
declare lobby mighty_private.public_lobbies;
begin
  select * into lobby from mighty_private.public_lobbies where slot=new.slot;
  if not found or new.room_id is null or new.room_id=lobby.room_id then return new; end if;
  if old.room_id is distinct from new.room_id or
     (new.expires_at>clock_timestamp() and old.expires_at<=clock_timestamp() and
      not mighty_private.directory_unsettled(old.room_id)) then
    raise exception '공개 테이블이 업데이트되었습니다. 새로고침 후 입장해 주세요.' using errcode='P0001';
  end if;
  return new;
end;
$$;
create trigger mighty_public_directory_gate before update of room_id,expires_at on mighty_private.directory_slots
for each row when (new.slot<=4) execute function mighty_private.public_directory_gate();

create function public.mighty_lobby_read(p_slot integer) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('revision',l.revision,'state',case when l.room_id=d.room_id then l.state end,
    'roomId',l.room_id,'legacy',l.room_id is null and d.room_id is not null and
      (coalesce(d.expires_at>statement_timestamp(),false) or mighty_private.directory_unsettled(d.room_id))) ||
    coalesce((select jsonb_build_object('chipRevision',h.revision)
      from mighty_private.hands h join mighty_private.chat_hand_links k on k.hand_id=h.id and k.host_id=h.host_id
      where h.id=(l.state#>>'{session,chipHandId}')::uuid and k.room_id=l.room_id),'{}'::jsonb)
  from mighty_private.public_lobbies l join mighty_private.directory_slots d using(slot) where l.slot=p_slot;
$$;

create function public.mighty_lobby_commit(p_slot integer,p_revision bigint,p_room_id uuid,p_state jsonb,
  p_summary jsonb,p_owner uuid,p_controller uuid,p_message jsonb default null,p_hand jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  d mighty_private.directory_slots; l mighty_private.public_lobbies; r mighty_private.chat_rooms;
  room_code text:='PUB00'||p_slot; brief jsonb; msg_seq bigint; sent timestamptz;
  hand_id uuid; hand_host uuid;
begin
  select * into strict d from mighty_private.directory_slots where slot=p_slot for update;
  select * into strict l from mighty_private.public_lobbies where slot=p_slot;
  if l.revision is distinct from p_revision then
    return jsonb_build_object('applied',false,'revision',l.revision,'roomId',l.room_id);
  end if;
  if l.room_id is null and d.room_id is not null and
     (d.expires_at>clock_timestamp() or mighty_private.directory_unsettled(d.room_id)) then
    raise exception '기존 테이블이 진행 중입니다.' using errcode='P0001';
  end if;
  if p_room_id is null or (l.room_id is not null and l.room_id<>p_room_id) then
    raise exception '이미 닫힌 테이블입니다.' using errcode='P0002';
  end if;
  if p_state is null then
    if l.room_id is null or mighty_private.directory_unsettled(l.room_id) then
      raise exception '아직 닫을 수 없는 테이블입니다.' using errcode='P0001';
    end if;
    update mighty_private.public_lobbies set room_id=null,state=null,revision=revision+1 where slot=p_slot;
    update mighty_private.directory_slots set room_id=null,expires_at=null,summary='{}' where slot=p_slot;
    return jsonb_build_object('applied',true,'revision',l.revision+1,'roomId',null);
  end if;
  if jsonb_typeof(p_state) is distinct from 'object' or jsonb_typeof(p_summary) is distinct from 'object'
     or coalesce(p_summary->>'phase','') not in ('waiting','playing','finished')
     or jsonb_typeof(p_summary->'seats') is distinct from 'array' or jsonb_array_length(p_summary->'seats')<>5
     or exists(select 1 from jsonb_array_elements(p_summary->'seats') s where jsonb_typeof(s) not in ('null','string')
          or length(s #>> '{}')>16) then
    raise exception '테이블 표시 정보를 확인해 주세요.' using errcode='22023';
  end if;
  -- Keep the public directory a projection, even if a future caller supplies
  -- its entire checkpoint as the summary by mistake.
  brief:=jsonb_build_object('phase',p_summary->>'phase','hostName',left(p_summary->>'hostName',16),
    'humanCount',(p_summary->>'humanCount')::int,'spectatorCount',(p_summary->>'spectatorCount')::int,
    'reservationCount',(p_summary->>'reservationCount')::int,'roundNumber',(p_summary->>'roundNumber')::int,
    'roundLimit',(p_summary->>'roundLimit')::int,'seats',p_summary->'seats');
  if l.room_id is null then
    perform mighty_private.require_verified(p_owner);
    if p_owner is distinct from p_controller or (p_state->>'controlTerm')::int is distinct from 1 then
      raise exception '첫 방장을 확인해 주세요.' using errcode='22023';
    end if;
    insert into mighty_private.chat_rooms(id,room,owner_id,controller_id,controller_digest,directory_slot,directory_name)
      values(p_room_id,room_code,p_owner,p_controller,mighty_private.chat_digest(p_state->>'controlKey'),p_slot,
             mighty_private.directory_name(p_slot)) returning * into r;
  else
    select * into strict r from mighty_private.chat_rooms where id=l.room_id for update;
    if r.controller_digest<>mighty_private.chat_digest(p_state->>'controlKey') or
       (p_state->>'controlTerm')::int is distinct from r.term+(r.controller_id is distinct from p_controller)::int then
      raise exception '테이블 방장이 변경되었습니다.' using errcode='40001';
    end if;
    if r.controller_id is distinct from p_controller then
      update mighty_private.chat_rooms set controller_id=p_controller,term=term+1 where id=r.id;
    end if;
  end if;
  if p_message is not null then
    msg_seq:=(p_message->>'seq')::bigint;
    if msg_seq is distinct from r.message_count+1 or msg_seq is distinct from (p_state->>'chatSeq')::bigint then
      raise exception '채팅 순서가 변경되었습니다.' using errcode='22023';
    end if;
    sent:=to_timestamp((p_message->>'time')::double precision/1000);
    insert into mighty_private.chat_messages(room_id,seq,request_id,seat,nickname,body,sent_at)
      values(r.id,msg_seq,(p_message->>'requestId')::uuid,(p_message->>'seat')::smallint,
        p_message->>'name',p_message->>'text',sent);
    update mighty_private.chat_rooms set message_count=msg_seq,last_message_at=sent where id=r.id;
  end if;
  if p_hand is not null then
    hand_id:=(p_hand->>'id')::uuid;
    hand_host:=(p_hand->>'hostId')::uuid;
    if hand_host is distinct from p_controller or hand_host is null then
      raise exception '판을 시작할 방장을 확인해 주세요.' using errcode='22023';
    end if;
    insert into mighty_private.chat_hand_links as link(host_id,hand_id,room_id) values(hand_host,hand_id,r.id)
      on conflict on constraint chat_hand_links_pkey do nothing;
    if not exists(select 1 from mighty_private.chat_hand_links x
        where x.room_id=r.id and x.hand_id=(p_hand->>'id')::uuid and x.host_id=hand_host) then
      raise exception '이미 사용 중인 대국 번호입니다.' using errcode='23505';
    end if;
  end if;
  update mighty_private.public_lobbies set room_id=r.id,state=p_state,revision=revision+1 where slot=p_slot;
  -- Ownership stays with the checkpoint until an explicit CAS closes it.
  -- Advertise live occupants only while their browsers are still checking in.
  update mighty_private.directory_slots set room_id=r.id,expires_at=clock_timestamp()+interval '2 minutes',summary=brief where slot=p_slot;
  return jsonb_build_object('applied',true,'revision',l.revision+1,'roomId',r.id);
end;
$$;

create or replace function public.mighty_directory_list() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_agg(
    case when d.room_id is not null and d.expires_at>statement_timestamp() then
      (d.summary - 'watchHandId' - 'liveHandId' - 'serverLobby') ||
      case when d.summary->>'phase'='playing' and live.id is not null then jsonb_build_object('liveHandId',live.id)
           else '{}'::jsonb end
    when live.id is not null then jsonb_build_object('phase','settling','watchHandId',live.id)
    else jsonb_build_object('phase','empty') end ||
    case when l.slot is not null and (l.room_id=d.room_id or
        (live.id is null and (d.expires_at is null or d.expires_at<=statement_timestamp()))) then '{"serverLobby":true}'::jsonb
      else '{}'::jsonb end ||
    jsonb_build_object('slot',d.slot,'code','PUB00'||d.slot,'name',mighty_private.directory_name(d.slot)) order by d.slot)
  from mighty_private.directory_slots d left join mighty_private.public_lobbies l using(slot)
  left join lateral (
    select h.id from mighty_private.hands h join mighty_private.chat_hand_links k on k.hand_id=h.id and k.host_id=h.host_id
    where h.room='PUB00'||d.slot and not h.settled and k.room_id=d.room_id
  ) live on true where d.slot between 1 and 4;
$$;

revoke all on function mighty_private.public_directory_gate(),public.mighty_lobby_read(integer),
  public.mighty_lobby_commit(integer,bigint,uuid,jsonb,jsonb,uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.mighty_lobby_read(integer),
  public.mighty_lobby_commit(integer,bigint,uuid,jsonb,jsonb,uuid,uuid,jsonb,jsonb) to service_role;

-- The older chip endpoint still accepts room codes. At the ledger boundary,
-- pin a public game's creation to the exact offer approved in this lobby.
-- Existing hand retries return their existing snapshot before this trigger.
create function mighty_private.public_hand_gate() returns trigger
language plpgsql security definer set search_path='' as $$
declare d mighty_private.directory_slots; l mighty_private.public_lobbies; offer jsonb;
begin
  select * into strict d from mighty_private.directory_slots where slot=right(new.room,1)::int for share;
  select * into l from mighty_private.public_lobbies where slot=d.slot;
  if not found then return new; end if;
  if d.room_id is null or d.expires_at is null or d.expires_at<=clock_timestamp() or
     not exists(select 1 from mighty_private.chat_hand_links k
       where k.room_id=d.room_id and k.host_id=new.host_id and k.hand_id=new.id) then
    raise exception '테이블에서 승인한 대국을 확인해 주세요.' using errcode='42501';
  end if;
  if l.room_id is not null then
    offer:=l.state->'offer';
    if d.room_id<>l.room_id or offer->>'status' is distinct from 'starting'
       or offer#>>'{spec,handId}' is distinct from new.id::text
       or offer#>>'{spec,host}' is distinct from new.host_id::text
       or offer#>'{spec,seats}' is distinct from to_jsonb(new.seats)
       or offer->>'manifest' is distinct from new.manifest then
      raise exception '승인한 공개 테이블 대국과 일치하지 않습니다.' using errcode='42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger mighty_public_hand_gate before insert on mighty_private.hands
for each row when (new.room ~ '^PUB00[1-4]$') execute function mighty_private.public_hand_gate();
revoke all on function mighty_private.public_hand_gate() from public,anon,authenticated,service_role;

-- Peer-controlled tables use the original chip control proofs. A server room
-- additionally pins a pace/clock change to its committed, still-pending effect.
alter function public.mighty_chip_room_control(uuid,text,bigint,uuid,boolean,integer,jsonb) set schema mighty_private;
revoke all on function mighty_private.mighty_chip_room_control(uuid,text,bigint,uuid,boolean,integer,jsonb)
  from public,anon,authenticated,service_role;
create function public.mighty_chip_room_control(p_hand uuid,p_credential text,p_term bigint,p_actor uuid,p_legacy boolean,
  p_revision integer default null,p_state jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if p_legacy and exists (
    select 1 from mighty_private.hands h join mighty_private.chat_hand_links k on k.hand_id=h.id and k.host_id=h.host_id
    join mighty_private.public_lobbies l on l.room_id=k.room_id where h.id=p_hand
  ) then raise exception '공개 테이블에서 방장 설정을 변경해 주세요.' using errcode='42501'; end if;
  return mighty_private.mighty_chip_room_control(p_hand,p_credential,p_term,p_actor,p_legacy,p_revision,p_state);
end;
$$;

create function public.mighty_lobby_hand_control(p_hand uuid,p_credential text,p_term bigint,p_actor uuid,p_effect uuid,
  p_revision integer default null,p_state jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d mighty_private.directory_slots; l mighty_private.public_lobbies;
begin
  select s.* into d from mighty_private.hands h join mighty_private.directory_slots s on h.room='PUB00'||s.slot
    where h.id=p_hand and s.slot<=4 for share of s;
  select * into l from mighty_private.public_lobbies where slot=d.slot and room_id=d.room_id;
  if l.room_id is null or not exists (
    select 1 from jsonb_array_elements(l.state->'effects') e
    where e->>'op'='setting' and e->>'handId'=p_hand::text and e->>'id'=p_effect::text
  ) then
    raise exception '이미 처리된 테이블 설정입니다.' using errcode='P0001',detail='stale_lobby_effect';
  end if;
  return mighty_private.mighty_chip_room_control(p_hand,p_credential,p_term,p_actor,false,p_revision,p_state);
end;
$$;
revoke all on function public.mighty_lobby_hand_control(uuid,text,bigint,uuid,uuid,integer,jsonb),
  public.mighty_chip_room_control(uuid,text,bigint,uuid,boolean,integer,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.mighty_lobby_hand_control(uuid,text,bigint,uuid,uuid,integer,jsonb),
  public.mighty_chip_room_control(uuid,text,bigint,uuid,boolean,integer,jsonb) to service_role;
