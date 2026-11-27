begin;
do $test$
declare
  cutoff bigint := (select max(balance) from mighty_private.virtual_leaderboard_profiles);
  last_page jsonb;
begin
  assert not has_table_privilege('authenticated','mighty_private.chip_rank_profiles','SELECT');
  -- Place 19 distinct balances above the fixed profiles.
  insert into mighty_private.virtual_leaderboard_profiles(nickname,balance)
    select '순위검증' || n, cutoff+n from generate_series(1,19) n;
  set local role anon;
  last_page := public.mighty_chip_leaderboard(999);
  assert last_page->>'total'='20' and last_page->>'page'='4';
  assert last_page->'items'->4->>'rank'='20' and last_page->'items'->4->>'tied'='false';
  reset role;

  insert into mighty_private.virtual_leaderboard_profiles(nickname,balance)
    values ('경계동점1',cutoff),('경계동점2',cutoff);
  set local role authenticated;
  last_page := public.mighty_chip_leaderboard(999);
  assert last_page->>'total'='20' and last_page->>'page'='4';
  assert jsonb_array_length(last_page->'items')=5;
  assert last_page->'items'->4->>'rank'='20' and last_page->'items'->4->>'tied'='true';
  assert public.mighty_chip_leaderboard(4)=last_page;
  reset role;
end;
$test$;
rollback;
