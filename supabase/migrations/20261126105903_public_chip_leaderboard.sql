-- The public projection contains ranking data only. The wallet and account
-- tables stay private, including for clients that page through the entire list.
create function mighty_private.chip_leaderboard(p_page integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  with members as materialized (
    select w.user_id, w.balance
    from mighty_private.wallets w join auth.users u on u.id = w.user_id
    where u.email_confirmed_at is not null and coalesce(u.email,'') <> '' and u.deleted_at is null
  ), bounds as (
    select count(*) as total,
      least(greatest(coalesce(p_page,1),1), greatest(1,(count(*)+4)/5)) as page
    from members
  ), page_rows as (
    select user_id, balance, rank() over (order by balance desc) as rank,
      count(*) over (partition by balance) > 1 as tied
    from members
    order by balance desc, user_id
    limit 5 offset (select (page-1)*5 from bounds)
  )
  select jsonb_build_object('page',page,'pageSize',5,'total',total,'items',coalesce((
    select jsonb_agg(jsonb_build_object('rank',r.rank,'tied',r.tied,
      'nickname',mighty_private.community_nickname(r.user_id),'balance',r.balance::text)
      order by r.balance desc, r.user_id) from page_rows r
  ),'[]'::jsonb)) from bounds;
$$;

-- Bind the private function at creation time, so callers do not need USAGE
-- on the private schema. The API wrapper itself uses the caller's privileges.
create function public.mighty_chip_leaderboard(p_page integer default 1)
returns jsonb language sql stable security invoker set search_path = ''
return mighty_private.chip_leaderboard(p_page);

revoke all on function mighty_private.chip_leaderboard(integer), public.mighty_chip_leaderboard(integer)
  from public, anon, authenticated, service_role;
grant execute on function mighty_private.chip_leaderboard(integer), public.mighty_chip_leaderboard(integer)
  to anon, authenticated;
