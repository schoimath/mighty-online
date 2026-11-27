begin;
do $test$
declare
  member uuid;
  balances bigint[] := array[1500,1000,1000,1000,1000,1000,0,-10,4000,5000];
  first_page jsonb; last_page jsonb; tied_page jsonb; listing jsonb;
begin
  assert (select array_agg(nickname order by balance desc) = array[
    'jun_92','한겜만','mellow','콩','JH','달수','0range','막차','mori','옆집형',
    'slowhand','진','bbang2','일단패스','tuna','감자전','min.j','오후반차','rookie7','소금'
  ] from mighty_private.virtual_leaderboard_profiles);
  assert not exists (select 1 from auth.users);
  assert not exists (select 1 from mighty_private.wallets);
  assert not exists (select 1 from mighty_private.chip_entries);
  first_page := public.mighty_chip_leaderboard();
  assert first_page->>'total'='20' and first_page->>'pageSize'='5';
  assert first_page->'items'->0 =
    '{"rank":1,"tied":false,"nickname":"jun_92","balance":"1248","isVirtual":true}';
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
  assert not has_table_privilege('anon','mighty_private.virtual_leaderboard_profiles','SELECT');
  assert not has_table_privilege('authenticated','mighty_private.virtual_leaderboard_profiles','UPDATE');
  set local role anon;
  first_page := public.mighty_chip_leaderboard();
  last_page := public.mighty_chip_leaderboard(999);
  assert first_page->>'total'='20' and jsonb_array_length(first_page->'items')=5 and last_page->>'page'='4';
  assert first_page->'items'->0 =
    '{"rank":1,"tied":false,"nickname":"플레이어","balance":"1500","isVirtual":false}';
  assert first_page->'items'->1->>'nickname'='jun_92';
  select jsonb_agg(item order by page, pos) into listing from generate_series(1,4) as pages(page)
    cross join lateral jsonb_array_elements(public.mighty_chip_leaderboard(page)->'items') with ordinality as rows(item,pos);
  assert (select count(*)=14 and count(distinct item->>'nickname')=14 from jsonb_array_elements(listing) item
    where (item->>'isVirtual')::boolean);
  assert (select count(*)=6 and count(distinct item->>'nickname')=6 from jsonb_array_elements(listing) item
    where not (item->>'isVirtual')::boolean);
  assert (select count(*)=6 and bool_and(item->>'rank'='15' and (item->>'tied')::boolean)
    from jsonb_array_elements(listing) item where item->>'balance'='1000');
  tied_page := public.mighty_chip_leaderboard(4);
  assert public.mighty_chip_leaderboard(3)->'items'->4->>'rank'='15';
  assert tied_page->'items'->0->>'rank'='15' and tied_page->'items'->4->>'nickname'='일단패스';
  assert not exists (select 1 from jsonb_array_elements(listing) item where (item->>'balance')::bigint<1000);
  assert public.mighty_chip_leaderboard(0)=first_page;
  set local role authenticated;
  assert public.mighty_chip_leaderboard(4)=tied_page and public.mighty_chip_leaderboard(6)=last_page;
  reset role;
end;
$test$;
rollback;
