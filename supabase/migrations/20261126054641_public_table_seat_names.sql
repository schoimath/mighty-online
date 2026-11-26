-- Only current human occupants of public seats are published. An older
-- controller omits this field, clearing names that may already have moved.
create or replace function public.mighty_directory_refresh(p_room_id uuid,p_credential text,p_term integer,p_summary jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare d mighty_private.directory_slots; brief jsonb; seats jsonb;
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
    if p_summary ? 'seats' then
      seats:=p_summary->'seats';
      if jsonb_typeof(seats) is distinct from 'array' then
        raise exception '자리별 닉네임을 확인해 주세요.' using errcode='22023';
      end if;
      if jsonb_array_length(seats)<>5 or exists(
        select 1 from jsonb_array_elements(seats) item
        where item<>'null'::jsonb and (jsonb_typeof(item)<>'string'
          or length(item #>> '{}')>16 or btrim(item #>> '{}')='')
      ) or (select count(*) from jsonb_array_elements(seats) item where item<>'null'::jsonb)<>(brief->>'humanCount')::integer then
        raise exception '자리별 닉네임을 확인해 주세요.' using errcode='22023';
      end if;
      brief:=brief||jsonb_build_object('seats',seats);
    end if;
  end if;
  update mighty_private.directory_slots set expires_at=clock_timestamp()+interval '2 minutes',summary=brief where slot=d.slot;
end;
$$;
