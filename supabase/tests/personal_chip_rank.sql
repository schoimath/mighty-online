begin;
do $test$
declare
  actor uuid := gen_random_uuid();
  other_member uuid := gen_random_uuid();
  unranked uuid := gen_random_uuid();
  wallet jsonb;
begin
  insert into auth.users (id,email,email_confirmed_at) values
    (actor,actor::text || '@example.invalid',now()),
    (other_member,other_member::text || '@example.invalid',now()),
    (unranked,unranked::text || '@example.invalid',now());
  update mighty_private.wallets set balance = 10 where user_id in (actor,other_member);
  update auth.users set deleted_at = now() where id=unranked;
  assert not has_function_privilege('anon','public.chip_wallet()','EXECUTE');

  perform set_config('request.jwt.claim.sub',actor::text,true);
  set local role authenticated;
  assert public.chip_wallet() = '{"balance":10,"recoveryDate":null,"rank":21,"tied":true}';
  reset role;
  -- The overnight refill moves the caller ahead of the other 10-chip member.
  update mighty_private.wallets set balance = 0, recover_on = current_date - 1 where user_id = actor;
  set local role authenticated;
  assert public.chip_wallet() = '{"balance":100,"recoveryDate":null,"rank":21,"tied":false}';
  perform set_config('request.jwt.claim.sub',other_member::text,true);
  assert public.chip_wallet() = '{"balance":10,"recoveryDate":null,"rank":22,"tied":false}';
  reset role;
  update mighty_private.wallets set balance=1248 where user_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  set local role authenticated;
  wallet := public.chip_wallet();
  assert wallet->>'rank' = public.mighty_chip_leaderboard()->'items'->0->>'rank';
  assert wallet->'tied' = 'true'::jsonb and wallet->>'rank'='1';
  perform set_config('request.jwt.claim.sub',unranked::text,true);
  assert public.chip_wallet()->'rank' = 'null'::jsonb;
  reset role;
end;
$test$;
rollback;
