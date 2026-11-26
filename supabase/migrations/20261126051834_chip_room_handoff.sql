-- The original dealt roster and wallet ownership never change. Keep only the
-- controller terms needed to prove which former host seats now belong to AI.
create table mighty_private.chat_retired_controllers (
  room_id uuid not null references mighty_private.chat_rooms(id) on delete cascade,
  term integer not null,
  account_id uuid,
  primary key(room_id,term)
);
alter table mighty_private.chat_retired_controllers enable row level security;
revoke all on mighty_private.chat_retired_controllers from public,anon,authenticated,service_role;
alter table mighty_private.chat_hand_links add column start_term integer not null default 1;
create function mighty_private.chat_record_handoff() returns trigger language plpgsql set search_path='' as $$
begin
  insert into mighty_private.chat_retired_controllers(room_id,term,account_id) values(old.id,old.term,old.controller_id);
  return new;
end;
$$;
create trigger mighty_chat_record_handoff after update of term on mighty_private.chat_rooms
for each row when (new.term>old.term) execute function mighty_private.chat_record_handoff();
create function mighty_private.chat_deal_term() returns trigger language plpgsql set search_path='' as $$
begin
  select term into strict new.start_term from mighty_private.chat_rooms where id=new.room_id;
  return new;
end;
$$;
create trigger mighty_chat_deal_term before insert on mighty_private.chat_hand_links
for each row execute function mighty_private.chat_deal_term();

-- The game service, after validating any optional user token with Auth,
-- calls this service-only RPC for both the initial read and every CAS write.
-- A handoff cannot race a write after the capability has been revoked.
create function public.mighty_chip_room_control(p_hand uuid,p_credential text,p_term bigint,p_actor uuid,p_legacy boolean,
  p_revision integer default null,p_state jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h mighty_private.hands; r mighty_private.chat_rooms; since_term integer; seats jsonb:='[]'; result jsonb;
begin
  select * into h from mighty_private.hands where id=p_hand;
  if h.id is null then return null; end if;
  select c.* into r from mighty_private.chat_hand_links l join mighty_private.chat_rooms c on c.id=l.room_id and c.room=h.room
    where l.hand_id=h.id and l.host_id=h.host_id for share of c;
  if p_legacy is true then
    if p_actor is null or h.host_id<>p_actor or (r.id is not null and r.controller_id is distinct from p_actor) then
      raise exception '방장 권한을 확인해 주세요.' using errcode='42501';
    end if;
  else
    if r.id is null or r.controller_id is distinct from p_actor or r.term is distinct from p_term or
        r.controller_digest<>mighty_private.chat_digest(p_credential) then
      raise exception '방장 권한을 확인해 주세요.' using errcode='42501';
    end if;
    select l.start_term into since_term from mighty_private.chat_hand_links l where l.host_id=h.host_id and l.hand_id=h.id;
    select coalesce(jsonb_agg(idx order by idx),'[]'::jsonb) into seats from (
      select distinct array_position(h.seats,t.account_id)-1 as idx from mighty_private.chat_retired_controllers t
      where t.room_id=r.id and t.term>=since_term and t.term<r.term and t.account_id is not null
        and t.account_id is distinct from p_actor and t.account_id=any(h.seats)
    ) eligible;
  end if;
  if p_state is not null then
    if p_revision is null or p_state#>>'{round,phase}'='result' then
      raise exception '대국 변경을 확인해 주세요.' using errcode='22023';
    end if;
    result:=public.chips_update_hand(p_hand,p_revision,p_state,null);
  else result:=public.chips_read_hand(p_hand); end if;
  return jsonb_build_object('hand',result,'departedSeats',seats);
end;
$$;
revoke all on function public.mighty_chip_room_control(uuid,text,bigint,uuid,boolean,integer,jsonb),
  mighty_private.chat_record_handoff(),mighty_private.chat_deal_term() from public,anon,authenticated,service_role;
grant execute on function public.mighty_chip_room_control(uuid,text,bigint,uuid,boolean,integer,jsonb) to service_role;
