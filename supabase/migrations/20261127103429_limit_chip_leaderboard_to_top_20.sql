create view mighty_private.chip_rank_profiles with (security_invoker=true) as
  select w.user_id, w.balance, null::text as virtual_name
  from mighty_private.wallets w join auth.users u on u.id=w.user_id
  where u.email_confirmed_at is not null and coalesce(u.email,'') <> '' and u.deleted_at is null
  union all
  select null::uuid, v.balance, v.nickname from mighty_private.virtual_leaderboard_profiles v;
revoke all on mighty_private.chip_rank_profiles from public, anon, authenticated, service_role;

create or replace function mighty_private.chip_leaderboard(p_page integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  with candidates as (
    -- Rank everyone tied at the boundary before limiting the visible rows.
    select * from mighty_private.chip_rank_profiles order by balance desc fetch first 20 rows with ties
  ), standings as materialized (
    select user_id, balance, virtual_name, rank() over (order by balance desc) as rank,
      count(*) over (partition by balance) > 1 as tied
    from candidates order by balance desc, user_id nulls last, virtual_name limit 20
  ), bounds as (
    select count(*) as total,
      least(greatest(coalesce(p_page,1),1), greatest(1,(count(*)+4)/5)) as page
    from standings
  ), page_rows as (
    select *
    from standings
    order by balance desc, user_id nulls last, virtual_name
    limit 5 offset (select (page-1)*5 from bounds)
  )
  select jsonb_build_object('page',page,'pageSize',5,'total',total,'items',coalesce((
    select jsonb_agg(jsonb_build_object('rank',r.rank,'tied',r.tied,'isVirtual',r.virtual_name is not null,
      'nickname',coalesce(r.virtual_name,mighty_private.community_nickname(r.user_id)),'balance',r.balance::text)
      order by r.balance desc, r.user_id nulls last, r.virtual_name) from page_rows r
  ),'[]'::jsonb)) from bounds;
$$;
