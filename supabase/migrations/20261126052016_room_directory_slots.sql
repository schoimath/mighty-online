-- The immutable archive id identifies a table across hands and host changes.
-- Slots are reusable. Their names in the archive survive release and code reuse.
alter table mighty_private.chat_rooms
  add column directory_slot smallint check (directory_slot between 1 and 10),
  add column directory_name text check (length(directory_name) between 1 and 32);

create table mighty_private.directory_slots (
  slot smallint primary key check (slot between 1 and 10),
  room_id uuid unique references mighty_private.chat_rooms(id) on delete set null,
  expires_at timestamptz,
  summary jsonb not null default '{}'
);
insert into mighty_private.directory_slots(slot) select generate_series(1,10);
alter table mighty_private.directory_slots enable row level security;
revoke all on mighty_private.directory_slots from public,anon,authenticated,service_role;

create function mighty_private.directory_name(p_slot integer) returns text
language sql immutable set search_path='' as $$
  select (array['스페이드 테이블','하트 테이블','다이아 테이블','클로버 테이블'])[p_slot];
$$;
create function mighty_private.directory_unsettled(p_room_id uuid) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from mighty_private.chat_hand_links l
    join mighty_private.hands h on h.id=l.hand_id and h.host_id=l.host_id
    where l.room_id=p_room_id and not h.settled);
$$;

create function public.mighty_directory_list() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_agg(
    case when d.room_id is not null and d.expires_at>statement_timestamp() then d.summary
      when mighty_private.directory_unsettled(d.room_id) then jsonb_build_object('phase','settling')
      else jsonb_build_object('phase','empty') end ||
    jsonb_build_object('slot',d.slot,'code','PUB00'||d.slot,'name',mighty_private.directory_name(d.slot))
    order by d.slot) from mighty_private.directory_slots d where d.slot<=4;
$$;

create function public.mighty_directory_open(p_room_id uuid,p_credential text,p_code text,p_slot integer,p_name text,p_host text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d mighty_private.directory_slots; previous_slot smallint; title text; current_term integer;
begin
  perform mighty_private.require_verified(auth.uid());
  if p_room_id is null or p_code is null or p_code !~ '^[A-Z0-9]{6}$'
      or (p_slot is not null and (p_slot not between 1 and 4 or p_code<>'PUB00'||p_slot))
      or (p_slot is null and p_code ~ '^PUB00[1-4]$')
      or length(btrim(coalesce(p_host,''))) not between 1 and 16
      or (p_slot is null and length(btrim(coalesce(p_name,''))) not between 1 and 32) then
    raise exception '방 이름과 번호를 확인해 주세요.' using errcode='22023';
  end if;
  -- The choice of a private slot, or the identity of a public slot's winner,
  -- is decided while holding these locks. No slot can acquire two archives.
  perform 1 from mighty_private.directory_slots s
    where (p_slot is null and s.slot>4) or s.slot=p_slot order by s.slot for update;
  select c.directory_slot into previous_slot from mighty_private.chat_rooms c where c.id=p_room_id;
  if previous_slot is not null then
    select * into d from mighty_private.directory_slots s where s.slot=previous_slot and s.room_id=p_room_id;
    if d.slot is null or d.expires_at is null or (p_slot is null and d.slot<=4)
       or (p_slot is not null and d.slot<>p_slot) then
      raise exception '이미 닫힌 방입니다.' using errcode='P0002';
    end if;
    perform public.mighty_room_chat_open(p_room_id,p_code,p_credential);
    return jsonb_build_object('claimed',true,'code',p_code,'slot',d.slot);
  end if;
  if p_slot is not null then
    select * into strict d from mighty_private.directory_slots s where s.slot=p_slot;
    if d.room_id is not null and d.expires_at>clock_timestamp() then
      return jsonb_build_object('claimed',false,'code',p_code,'slot',p_slot);
    end if;
    if mighty_private.directory_unsettled(d.room_id) then
      raise exception '이전 판의 칩을 정산하고 있습니다. 잠시 후 입장해 주세요.' using errcode='P0001';
    end if;
    title:=mighty_private.directory_name(p_slot);
  else
    if exists(select 1 from mighty_private.directory_slots s join mighty_private.chat_rooms c on c.id=s.room_id
      where s.slot>4 and c.room=p_code and (s.expires_at>clock_timestamp() or mighty_private.directory_unsettled(c.id))) then
      raise exception '이미 사용 중인 방 코드입니다.' using errcode='P0001';
    end if;
    select * into d from mighty_private.directory_slots s where s.slot>4
      and (s.room_id is null or ((s.expires_at is null or s.expires_at<=clock_timestamp()) and not mighty_private.directory_unsettled(s.room_id)))
      order by s.slot limit 1;
    if d.slot is null then
      raise exception '비공개 방 6개가 모두 열려 있습니다. 빈 방이 생기면 다시 시도해 주세요.' using errcode='P0001';
    end if;
    title:=btrim(p_name);
  end if;
  current_term:=public.mighty_room_chat_open(p_room_id,p_code,p_credential);
  perform mighty_private.chat_controller(p_room_id,p_credential,current_term);
  update mighty_private.chat_rooms set directory_slot=d.slot,directory_name=title where id=p_room_id and directory_slot is null;
  if not found then raise exception '이미 등록된 방입니다.' using errcode='P0001'; end if;
  update mighty_private.directory_slots set room_id=p_room_id,expires_at=clock_timestamp()+interval '2 minutes',
    summary=jsonb_build_object('phase','waiting','hostName',btrim(p_host),'humanCount',1,'spectatorCount',0,
      'reservationCount',0,'roundNumber',1,'roundLimit',null) where slot=d.slot;
  return jsonb_build_object('claimed',true,'code',p_code,'slot',d.slot);
end;
$$;

create function public.mighty_directory_refresh(p_room_id uuid,p_credential text,p_term integer,p_summary jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare d mighty_private.directory_slots; brief jsonb;
begin
  select * into d from mighty_private.directory_slots s where s.room_id=p_room_id for update;
  perform mighty_private.chat_controller(p_room_id,p_credential,p_term);
  if d.slot is null or d.expires_at is null then raise exception '이미 닫힌 방입니다.' using errcode='P0002'; end if;
  brief:=d.summary;
  if d.slot<=4 and p_summary is not null then
    if jsonb_typeof(p_summary) is distinct from 'object'
      or coalesce(p_summary->>'phase','') not in ('waiting','playing','finished')
      or length(btrim(coalesce(p_summary->>'hostName',''))) not between 1 and 16
      or coalesce(p_summary->>'humanCount','') !~ '^[0-5]$'
      or coalesce(p_summary->>'spectatorCount','') !~ '^[0-9]{1,6}$'
      or coalesce(p_summary->>'reservationCount','') !~ '^[0-9]{1,6}$'
      or coalesce(p_summary->>'roundNumber','') !~ '^[0-9]{1,8}$'
      or coalesce(p_summary->>'roundLimit','') not in ('','10','20') then
      raise exception '방 표시 정보를 확인해 주세요.' using errcode='22023';
    end if;
    -- A client snapshot may also contain private cards or connection data.
    -- Project exactly the public counters, even for an older client.
    brief:=jsonb_build_object('phase',p_summary->>'phase','hostName',btrim(p_summary->>'hostName'),
      'humanCount',(p_summary->>'humanCount')::integer,'spectatorCount',(p_summary->>'spectatorCount')::integer,
      'reservationCount',(p_summary->>'reservationCount')::integer,'roundNumber',(p_summary->>'roundNumber')::integer,
      'roundLimit',nullif(p_summary->>'roundLimit','')::integer);
  end if;
  update mighty_private.directory_slots set expires_at=clock_timestamp()+interval '2 minutes',summary=brief where slot=d.slot;
end;
$$;

create function public.mighty_directory_close(p_room_id uuid,p_credential text,p_term integer) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from mighty_private.directory_slots s where s.room_id=p_room_id for update;
  perform mighty_private.chat_controller(p_room_id,p_credential,p_term);
  update mighty_private.directory_slots set expires_at=null,summary='{}' where room_id=p_room_id;
end;
$$;

revoke all on function mighty_private.directory_name(integer),mighty_private.directory_unsettled(uuid) from public,anon,authenticated,service_role;
revoke all on function public.mighty_directory_list(),public.mighty_directory_open(uuid,text,text,integer,text,text),
  public.mighty_directory_refresh(uuid,text,integer,jsonb),public.mighty_directory_close(uuid,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.mighty_directory_list(),public.mighty_directory_refresh(uuid,text,integer,jsonb),
  public.mighty_directory_close(uuid,text,integer) to anon,authenticated;
grant execute on function public.mighty_directory_open(uuid,text,text,integer,text,text) to authenticated;
