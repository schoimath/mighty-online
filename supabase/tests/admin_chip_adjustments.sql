-- Roll back both test accounts, the test hand, sessions, wallets and ledger rows.
begin;
set local plpgsql.check_asserts = on;
select '1..1';
do $test$
declare
  actor uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  pending uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid();
  req uuid := gen_random_uuid();
  deal uuid := gen_random_uuid();
  device_key text := replace(gen_random_uuid()::text,'-','') || 'fixture-key';
  korean_today date := (now() at time zone 'Asia/Seoul')::date;
  before_entries bigint;
  first_receipt jsonb;
  debit_receipt jsonb;
  report jsonb;
  settled jsonb;
  state_json jsonb := jsonb_build_object('manifest',repeat('a',64),'dueAt',0);
begin
  insert into auth.users(id,email,email_confirmed_at,created_at)
  values(actor,actor::text||'@example.invalid',now(),now()),
        (member,member::text||'@example.invalid',now(),now()),
        (pending,pending::text||'@example.invalid',null,now());
  insert into auth.sessions(id,user_id,created_at) values(session_id,actor,now());
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub',actor,'session_id',session_id,'role','authenticated')::text,true);
  perform set_config('request.headers',jsonb_build_object('x-mighty-admin-key',device_key)::text,true);
  assert not has_function_privilege('anon','public.mighty_admin_adjust(uuid,integer,text,uuid)','execute');
  set local role authenticated;
  begin
    perform public.mighty_admin_adjust(member,5,'권한 검사',req);
    raise exception 'unregistered account could adjust a wallet';
  exception when insufficient_privilege then null; end;
  reset role;
  insert into mighty_private.admin_installations(user_id,key_digest) values(actor,sha256(convert_to(device_key,'UTF8')));
  set local role authenticated;
  perform set_config('request.headers','{}',true);
  begin
    perform public.mighty_admin_adjust(member,5,'설치 키 검사',req);
    raise exception 'missing local key accepted';
  exception when insufficient_privilege then null; end;
  perform set_config('request.headers',jsonb_build_object('x-mighty-admin-key',device_key)::text,true);
  begin
    perform public.mighty_admin_adjust(member,0,'수량 검사',gen_random_uuid());
    raise exception 'zero delta accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.mighty_admin_adjust(member,1,E' \n\t',gen_random_uuid());
    raise exception 'blank reason accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.mighty_admin_adjust(member,1,repeat('가',201),gen_random_uuid());
    raise exception 'oversize reason accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.mighty_admin_adjust(pending,1,'미인증 회원 검사',gen_random_uuid());
    raise exception 'unconfirmed target accepted';
  exception when no_data_found then null; end;

  first_receipt := public.mighty_admin_adjust(member,250,'  행사 지급  ',req);
  assert (first_receipt->>'balanceAfter')::int=1250 and first_receipt ? 'entryId';
  debit_receipt := public.mighty_admin_adjust(member,-1500,'행사 정정',gen_random_uuid());
  assert (debit_receipt->>'balanceAfter')::int=-250;
  assert public.mighty_admin_adjust(member,250,'행사 지급',req)=first_receipt, 'retry must return the original receipt';
  begin
    perform public.mighty_admin_adjust(actor,250,'행사 지급',req);
    raise exception 'same receipt for different target';
  exception when unique_violation then null; end;
  begin
    perform public.mighty_admin_adjust(member,250,'다른 사유',req);
    raise exception 'same receipt for different reason';
  exception when unique_violation then null; end;
  report := public.mighty_admin_ledger(1,member);
  assert (report->>'total')::int=3 and report#>>'{items,0,kind}'='admin_adjustment';
  assert report#>>'{items,0,reason}'='행사 정정' and (report#>>'{items,0,delta}')::int=-1500;
  assert report#>>'{items,1,reason}'='행사 지급' and (report#>>'{items,1,delta}')::int=250;
  assert report#>>'{items,2,kind}'='welcome';
  reset role;
  assert (select count(*)=1 from mighty_private.chip_entries
    where admin_request_id=req and user_id=member and admin_actor_id=actor and admin_reason='행사 지급');
  assert (select balance=-250 and recover_on=korean_today+1 from mighty_private.wallets where user_id=member);
  set local role authenticated;
  perform public.mighty_admin_adjust(member,250,'잔액 0 검사',gen_random_uuid());
  reset role;
  assert (select balance=0 and recover_on=korean_today+1 from mighty_private.wallets where user_id=member);
  update mighty_private.wallets set recover_on=korean_today where user_id=member;
  set local role authenticated;
  assert (public.mighty_admin_adjust(member,7,'자정 이후 지급',gen_random_uuid())->>'balanceAfter')::int=107;
  reset role;
  assert (select balance=107 and recover_on is null from mighty_private.wallets where user_id=member);
  assert (select count(*)=1 from mighty_private.chip_entries
    where user_id=member and kind='recovery' and balance_after=100 and delta=100);

  -- A later settlement is based on the current wallet and leaves its owner's adjustment in the ledger.
  insert into mighty_private.hands(id,room,host_id,seats,manifest,state,revision)
    values(deal,upper(left(replace(deal::text,'-',''),6)),member,array[member,null,null,null,null]::uuid[],
           state_json->>'manifest',state_json,0);
  update mighty_private.wallets set active_hand=deal where user_id=member;
  set local role authenticated;
  perform public.mighty_admin_adjust(member,-207,'진행 중 대국의 정정',gen_random_uuid());
  reset role;
  assert (select active_hand=deal and balance=-100 and recover_on=korean_today+1
    from mighty_private.wallets where user_id=member);
  update mighty_private.wallets set recover_on=korean_today where user_id=member;
  set local role service_role;
  settled := public.chips_update_hand(deal,0,state_json,'[25,-25,0,0,0]');
  assert (settled->>'settled')::boolean;
  assert (public.chips_update_hand(deal,0,state_json,'[25,-25,0,0,0]')->>'applied')::boolean=false;
  reset role;
  assert (select balance=125 and recover_on is null and active_hand is null
    from mighty_private.wallets where user_id=member);
  assert (select count(*)=1 from mighty_private.chip_entries
    where user_id=member and kind='settlement' and hand_id=deal and balance_after=125);
  assert (select count(*)=1 from mighty_private.chip_entries
    where user_id=member and kind='recovery' and delta=200 and balance_after=100);
  select count(*) into before_entries from mighty_private.chip_entries where user_id=member;
  delete from auth.sessions where id=session_id;
  set local role authenticated;
  begin
    perform public.mighty_admin_adjust(member,250,'행사 지급',req);
    raise exception 'revoked session could retrieve a receipt';
  exception when insufficient_privilege then null; end;
  reset role;
  assert (select count(*)=before_entries from mighty_private.chip_entries where user_id=member);
  assert (select sum(delta)=125 from mighty_private.chip_entries where user_id=member);
end;
$test$;
select 'ok 1 - authorized audited adjustments, exact retries, active hand and Seoul recovery';
rollback;
