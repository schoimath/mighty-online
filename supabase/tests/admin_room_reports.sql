begin;
do $test$
declare
  host uuid := gen_random_uuid();
  guest uuid := gen_random_uuid();
  login_id uuid := gen_random_uuid();
  install_key text := repeat('r',43);
  code text := upper(substr(md5(host::text),1,6));
  deal uuid;
  before_rooms integer;
  before_account_entries integer;
  room_report jsonb;
  detail jsonb;
begin
  insert into auth.users(id,email,email_confirmed_at,created_at)
    values(host,host::text||'@example.invalid',now(),now()),(guest,guest::text||'@example.invalid',now(),now());
  insert into auth.sessions(id,user_id,created_at) values(login_id,host,now());
  insert into mighty_private.admin_installations(user_id,key_digest) values(host,sha256(convert_to(install_key,'UTF8')));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',host,'session_id',login_id,'role','authenticated')::text,true);
  perform set_config('request.headers',jsonb_build_object('x-mighty-admin-key',install_key)::text,true);
  before_rooms := (public.mighty_admin_rooms(1)->>'total')::integer;
  before_account_entries := (public.mighty_admin_account_entries(1)->>'total')::integer;
  for n in 1..22 loop
    deal := gen_random_uuid();
    insert into mighty_private.hands(id,room,host_id,seats,manifest,state,settled,created_at)
      values(deal,code,host,array[host,guest,null,null,null],repeat('a',64),
        '{"names":["가","나","다","라","마"],"round":{"phase":"play","hands":["private"]}}',n<22,now()+n*interval '1 minute');
    if n<22 then
      insert into mighty_private.chip_entries(user_id,kind,hand_id,delta,balance_after)
        values(host,'settlement',deal,1,1000+n),(guest,'settlement',deal,-1,1000-n);
    end if;
  end loop;
  insert into mighty_private.hands(id,room,host_id,seats,manifest,state,settled)
    values(gen_random_uuid(),code,guest,array[guest,null,null,null,null],repeat('b',64),'{}',true);
  set local role authenticated;
  room_report := public.mighty_admin_rooms(1);
  assert (room_report->>'total')::integer=before_rooms+2;
  assert exists(select 1 from jsonb_array_elements(room_report->'items') r
    where r->>'room'=code and r->>'hostId'=host::text and r->>'handCount'='22' and r->>'activeCount'='1');
  detail := public.mighty_admin_room_hands(code,host,1);
  assert (detail->>'total')::integer=22 and jsonb_array_length(detail->'items')=20;
  assert detail#>>'{items,0,handNumber}'='22' and detail#>'{items,0,entries}'='[]'::jsonb;
  assert jsonb_array_length(detail#>'{items,1,entries}')=2 and detail::text not like '%private%';
  detail := public.mighty_admin_room_hands(code,host,2);
  assert jsonb_array_length(detail->'items')=2 and detail#>>'{items,1,handNumber}'='1';
  assert detail#>>'{items,1,entries,0,userId}'=host::text and detail#>>'{items,1,entries,0,balanceAfter}'='1001';
  assert public.mighty_admin_room_hands(code,guest)->>'total'='1';
  assert public.mighty_admin_room_hands(code,gen_random_uuid())->>'total'='0';
  assert (public.mighty_admin_account_entries()->>'total')::integer=before_account_entries;
  assert (public.mighty_admin_ledger(1,host)->>'total')::integer=22;
  perform set_config('request.headers','{}',true);
  begin
    perform public.mighty_admin_room_hands(code,host);
    raise exception 'unauthorized room report';
  exception when insufficient_privilege then null; end;
  begin
    perform public.mighty_admin_rooms();
    raise exception 'unauthorized room list';
  exception when insufficient_privilege then null; end;
  begin
    perform public.mighty_admin_account_entries();
    raise exception 'unauthorized transaction report';
  exception when insufficient_privilege then null; end;
  reset role;
  assert not has_function_privilege('anon','public.mighty_admin_rooms(integer)','execute');
end;
$test$;
rollback;
