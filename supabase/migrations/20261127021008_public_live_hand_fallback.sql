-- A still-open public table can offer a read-only view of its game if the
-- host connection fails. Use the hand linked to this particular room archive.
create or replace function public.mighty_directory_list() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_agg(
    case when d.room_id is not null and d.expires_at > statement_timestamp() then
      (d.summary - 'watchHandId' - 'liveHandId') ||
      case when d.summary->>'phase' = 'playing' and live.id is not null
        then jsonb_build_object('liveHandId', live.id)
        else '{}'::jsonb end
    when live.id is not null then jsonb_build_object('phase','settling','watchHandId',live.id)
    else jsonb_build_object('phase','empty') end ||
    jsonb_build_object('slot',d.slot,'code','PUB00'||d.slot,'name',mighty_private.directory_name(d.slot))
    order by d.slot)
  from mighty_private.directory_slots d
  left join lateral (
    select h.id
    from mighty_private.hands h
    join mighty_private.chat_hand_links l on l.hand_id = h.id and l.host_id = h.host_id
    where h.room = 'PUB00'||d.slot and not h.settled and l.room_id = d.room_id
  ) live on true
  where d.slot between 1 and 4;
$$;
