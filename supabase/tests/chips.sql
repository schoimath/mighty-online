-- Run on a local migrated database with psql -v ON_ERROR_STOP=1 -f <this file>.
-- All test users and financial entries roll back. The two TAP lines also let
-- Supabase's pg_prove runner report the script as a single integration check.
begin;
set local plpgsql.check_asserts = on;
select '1..1';
do $test$
declare
  alice uuid := gen_random_uuid();
  bob uuid := gen_random_uuid();
  carol uuid := gen_random_uuid();
  first_hand uuid := gen_random_uuid();
  next_hand uuid := gen_random_uuid();
  manifest text := repeat('a',64);
  initial jsonb := jsonb_build_object('manifest',manifest,'dueAt',0,'phase','bid');
  seats jsonb := jsonb_build_array(alice,bob,null,null,null);
  spectator_host_seats jsonb := jsonb_build_array(null,bob,null,null,null);
  korean_today date := (now() at time zone 'Asia/Seoul')::date;
  result jsonb;
  detail text;
begin
  insert into auth.users(id,email,email_confirmed_at) values
    (alice,alice||'@example.test',null),(bob,bob||'@example.test',now()),(carol,carol||'@example.test',now());
  assert not exists(select 1 from mighty_private.wallets where user_id=alice), 'unverified grant';
  perform set_config('request.jwt.claim.sub',alice::text,true);
  set local role authenticated;
  begin
    perform public.chip_wallet();
    raise exception 'unverified account got wallet' using errcode='XX000';
  exception when insufficient_privilege then null; end;
  assert not has_function_privilege(current_user,'public.chips_read_hand(uuid)','execute'), 'raw hand granted to player';
  assert not has_function_privilege(current_user,'public.chips_update_hand(uuid,integer,jsonb,jsonb)','execute'), 'settlement granted to player';
  assert not has_schema_privilege(current_user,'mighty_private','usage'), 'private schema exposed';
  reset role;
  assert not has_function_privilege('anon','public.chip_wallet()','execute'), 'anon wallet exposed';
  update auth.users set email_confirmed_at=now() where id=alice;
  update auth.users set email_confirmed_at=now() where id=alice;
  set local role authenticated;
  assert public.chip_wallet() = '{"balance":1000,"recoveryDate":null}'::jsonb, 'initial balance';
  assert public.chips_ready(first_hand,'ABC234',0,manifest);
  reset role;
  assert (select count(*)=1 from mighty_private.chip_entries where user_id=alice and kind='welcome');
  -- Seed a low positive balance for a legitimate -12 settlement below.
  update mighty_private.wallets set balance=5 where user_id=alice;
  set local role service_role;
  begin
    perform public.chips_start_hand(first_hand,'ABC234',alice,seats,initial);
    raise exception 'started without Bob' using errcode='XX000';
  exception when raise_exception then
    get stacked diagnostics detail=pg_exception_detail;
    assert detail='approval_required';
  end;
  assert public.chips_read_hand(first_hand) is null, 'failed start persisted';
  reset role;
  assert (select active_hand is null from mighty_private.wallets where user_id=alice);
  perform set_config('request.jwt.claim.sub',bob::text,true);
  set local role authenticated;
  perform public.chips_ready(first_hand,'ABC234',1,manifest);
  reset role;
  set local role service_role;
  begin
    perform public.chips_start_hand(first_hand,'ABC234',alice,seats,initial||jsonb_build_object('manifest',repeat('b',64)));
    raise exception 'consent reused on different terms' using errcode='XX000';
  exception when raise_exception then
    get stacked diagnostics detail=pg_exception_detail;
    assert detail='approval_required';
  end;
  result := public.chips_start_hand(first_hand,'ABC234',alice,seats,initial);
  assert (result->>'revision')::int=0 and result->'state'=initial and result->'seats'=seats;
  assert result=public.chips_start_hand(first_hand,'ABC234',alice,seats,initial||'{"random":123}'), 'retried start re-dealt';
  assert first_hand=any(public.chips_due_hands(100));
  reset role;
  set local role authenticated;
  assert public.chips_active_hand()=first_hand;
  begin
    perform public.chips_ready(next_hand,'DEF567',1,manifest);
    raise exception 'second hand admitted concurrently' using errcode='XX000';
  exception when raise_exception then
    get stacked diagnostics detail=pg_exception_detail;
    assert detail='active_hand';
  end;
  reset role;
  set local role service_role;
  result := public.chips_update_hand(first_hand,0,initial||'{"phase":"play"}');
  assert result->'applied'='true'::jsonb and (result->>'revision')::int=1;
  result := public.chips_update_hand(first_hand,0,initial,'[-12,12,0,0,0]');
  assert result->'applied'='false'::jsonb and result->'settled'='false'::jsonb, 'stale settlement won';
  begin
    perform public.chips_update_hand(first_hand,1,initial,'[-12,13,0,0,0]');
    raise exception 'accepted invalid deltas' using errcode='XX000';
  exception when raise_exception then null; end;
  result := public.chips_update_hand(first_hand,1,initial||'{"phase":"result"}','[-12,12,0,0,0]');
  assert result->'applied'='true'::jsonb and result->'settled'='true'::jsonb;
  result := public.chips_update_hand(first_hand,2,initial,'[-12,12,0,0,0]');
  assert result->'applied'='false'::jsonb;
  reset role;
  assert (select count(*)=2 from mighty_private.chip_entries where hand_id=first_hand), 'duplicate settlement';
  assert (select balance=1012 and active_hand is null from mighty_private.wallets where user_id=bob);
  perform set_config('request.jwt.claim.sub',alice::text,true);
  set local role authenticated;
  assert public.chip_wallet()=jsonb_build_object('balance',-7,'recoveryDate',korean_today+1), 'negative balance or KST date';
  assert public.chips_active_hand() is null;
  begin
    perform public.chips_ready(next_hand,'DEF567',0,manifest);
    raise exception 'broke player admitted' using errcode='XX000';
  exception when raise_exception then
    get stacked diagnostics detail=pg_exception_detail;
    assert detail='insufficient_chips';
  end;
  perform public.chips_ready(next_hand,'DEF567',-1,manifest);
  perform set_config('request.jwt.claim.sub',bob::text,true);
  perform public.chips_ready(next_hand,'DEF567',1,manifest);
  reset role;
  set local role service_role;
  perform public.chips_start_hand(next_hand,'DEF567',alice,spectator_host_seats,initial);
  reset role;
  assert (select active_hand is null from mighty_private.wallets where user_id=alice), 'spectator host locked';
  set local role service_role;
  perform public.chips_update_hand(next_hand,0,initial,'[0,0,0,0,0]');
  reset role;
  assert not exists(select 1 from mighty_private.chip_entries where hand_id=next_hand and user_id=alice);
  -- Move the fixture's due date to today as if Seoul midnight just passed.
  update mighty_private.wallets set recover_on=korean_today where user_id=alice;
  update mighty_private.wallets set balance=0, recover_on=korean_today where user_id=carol;
  perform set_config('request.jwt.claim.sub',alice::text,true);
  set local role authenticated;
  assert public.chip_wallet() = '{"balance":100,"recoveryDate":null}'::jsonb, 'negative did not reset to exactly 100';
  reset role;
  set local role service_role;
  perform public.chips_recover_due();
  perform public.chips_recover_due();
  reset role;
  assert (select balance=100 and recover_on is null from mighty_private.wallets where user_id=carol), 'zero balance not recovered';
  assert (select count(*)=1 and sum(delta)=107 from mighty_private.chip_entries where user_id=alice and kind='recovery');
  assert (select count(*)=1 and sum(delta)=100 from mighty_private.chip_entries where user_id=carol and kind='recovery');
end;
$test$;
select 'ok 1 - verified wallets, consent, private access, atomic deals and Seoul recovery';
rollback;
