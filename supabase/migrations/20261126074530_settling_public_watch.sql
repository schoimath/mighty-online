-- The hand archive is linked before the deal starts. Its host, hand ID and
-- room code must all agree before it can hold a slot or be advertised.
create or replace function mighty_private.directory_unsettled(p_room_id uuid) returns boolean
language sql stable set search_path='' as $$
  select exists (
    select 1 from mighty_private.chat_rooms c
    join mighty_private.hands h on h.room=c.room and not h.settled
    join mighty_private.chat_hand_links l on l.room_id=c.id and l.hand_id=h.id and l.host_id=h.host_id
    where c.id=p_room_id
  );
$$;

create or replace function public.mighty_directory_list() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_agg(
    case when d.room_id is not null and d.expires_at>statement_timestamp() then d.summary - 'watchHandId'
      else coalesce((
        select jsonb_build_object('phase','settling','watchHandId',h.id)
        from mighty_private.hands h
        join mighty_private.chat_hand_links l on l.hand_id=h.id and l.host_id=h.host_id
        where h.room='PUB00'||d.slot and not h.settled and l.room_id=d.room_id
      ), '{"phase":"empty"}'::jsonb)
    end || jsonb_build_object('slot',d.slot,'code','PUB00'||d.slot,'name',mighty_private.directory_name(d.slot))
    order by d.slot)
  from mighty_private.directory_slots d where d.slot between 1 and 4;
$$;
