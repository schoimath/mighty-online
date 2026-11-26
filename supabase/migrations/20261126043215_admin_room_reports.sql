create index mighty_room_hand_history on mighty_private.hands(room,host_id,created_at desc,id desc);
create index mighty_hand_chip_history on mighty_private.chip_entries(hand_id,id) where hand_id is not null;

-- Use the same verified local installation and active administrator session as
-- the other reports. A room code that was later assigned to a different host
-- must not mix those two hosts' records.
create function public.mighty_admin_rooms(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare skip_rows bigint := mighty_private.admin_page_offset(p_page);
begin
  return (with rooms as (
    select h.room,h.host_id as "hostId",count(*) as "handCount",
      count(*) filter (where not h.settled) as "activeCount",
      min(h.created_at) as "firstHandAt",max(h.created_at) as "lastHandAt"
    from mighty_private.hands h group by h.room,h.host_id
  ), page_rooms as (
    select * from rooms order by "lastHandAt" desc,room,"hostId" limit 20 offset skip_rows
  ), items as (
    select r.*,u.email,u.raw_user_meta_data->>'nickname' as nickname
    from page_rooms r left join auth.users u on u.id=r."hostId"
  )
  select jsonb_build_object('page',p_page,'pageSize',20,'total',(select count(*) from rooms),
    'items',coalesce(jsonb_agg(to_jsonb(i) order by i."lastHandAt" desc,i.room,i."hostId"),'[]'::jsonb))
  from items i);
end;
$$;

-- Page by hand so a hand and all its account entries always appear together.
create function public.mighty_admin_room_hands(p_room text,p_host_id uuid,p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare skip_rows bigint := mighty_private.admin_page_offset(p_page);
begin
  if p_room is null or p_room !~ '^[A-Z0-9]{6}$' or p_host_id is null then
    raise exception '방 정보를 확인해 주세요.' using errcode='22023';
  end if;
  return (with matches as (
    select h.id,h.created_at from mighty_private.hands h where h.room=p_room and h.host_id=p_host_id
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

-- Grants, recoveries and manual adjustments do not belong to a room.
create function public.mighty_admin_account_entries(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare skip_rows bigint := mighty_private.admin_page_offset(p_page);
begin
  return (with page_rows as (
    select e.id,e.user_id as "userId",u.email,u.raw_user_meta_data->>'nickname' as nickname,
      e.kind,e.delta,e.balance_after as "balanceAfter",e.booked_at as at,e.admin_reason as reason
    from mighty_private.chip_entries e left join auth.users u on u.id=e.user_id
    where e.hand_id is null order by e.id desc limit 20 offset skip_rows)
  select jsonb_build_object('page',p_page,'pageSize',20,
    'total',(select count(*) from mighty_private.chip_entries where hand_id is null),
    'items',coalesce(jsonb_agg(to_jsonb(p) order by p.id desc),'[]'::jsonb)) from page_rows p);
end;
$$;

revoke all on function public.mighty_admin_rooms(integer), public.mighty_admin_room_hands(text,uuid,integer),
  public.mighty_admin_account_entries(integer) from public,anon,authenticated,service_role;
grant execute on function public.mighty_admin_rooms(integer), public.mighty_admin_room_hands(text,uuid,integer),
  public.mighty_admin_account_entries(integer) to authenticated;
