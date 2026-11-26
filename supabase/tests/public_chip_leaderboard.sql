begin;
do $test$
declare
  member uuid;
  balances bigint[] := array[1500,1000,1000,1000,1000,1000,0,-10,4000,5000];
  first_page jsonb; last_page jsonb;
begin
  assert public.mighty_chip_leaderboard()->'items' = '[]'::jsonb;
  for i in 1..array_length(balances,1) loop
    member := gen_random_uuid();
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
      values(member,member::text||'@example.invalid',now(),
        jsonb_build_object('nickname',case when i=1 then 'private@example.invalid' else '회원'||i end));
    update mighty_private.wallets set balance=balances[i],
      recover_on=case when balances[i]<=0 then current_date+1 end where user_id=member;
    if i=9 then update auth.users set deleted_at=now() where id=member; end if;
    if i=10 then update auth.users set email_confirmed_at=null where id=member; end if;
  end loop;
  assert not has_schema_privilege('anon','mighty_private','USAGE');
  assert not has_table_privilege('anon','mighty_private.wallets','SELECT');
  set local role anon;
  first_page := public.mighty_chip_leaderboard();
  last_page := public.mighty_chip_leaderboard(999);
  assert first_page->>'total'='8' and jsonb_array_length(first_page->'items')=5 and last_page->>'page'='2';
  assert first_page->'items'->0 = '{"rank":1,"tied":false,"nickname":"플레이어","balance":"1500"}';
  assert first_page->'items'->1->>'rank'='2' and first_page->'items'->4->>'tied'='true';
  assert last_page->'items'->0->>'rank'='2' and last_page->'items'->0->>'tied'='true';
  assert last_page->'items'->1->>'rank'='7' and last_page->'items'->1->>'balance'='0';
  assert last_page->'items'->2->>'rank'='8' and last_page->'items'->2->>'balance'='-10';
  assert public.mighty_chip_leaderboard(0)=first_page;
  set local role authenticated;
  assert public.mighty_chip_leaderboard(2)=last_page;
  reset role;
end;
$test$;
rollback;
