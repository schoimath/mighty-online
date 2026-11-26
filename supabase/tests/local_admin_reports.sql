-- Isolate the synthetic user, session and installation in one rolled-back transaction.
begin;
do $test$
declare
  fixture uuid := gen_random_uuid();
  login_id uuid := gen_random_uuid();
  test_key text := replace(gen_random_uuid()::text,'-','') || 'fixture-key';
  test_mail text := fixture::text || '@example.invalid';
  data jsonb;
begin
  insert into auth.users(id,email,email_confirmed_at,created_at) values(fixture,test_mail,now(),now());
  insert into auth.sessions(id,user_id,created_at) values(login_id,fixture,now());
  perform set_config('request.jwt.claims',jsonb_build_object('sub',fixture,'session_id',login_id,'role','authenticated')::text,true);
  perform set_config('request.headers',jsonb_build_object('x-mighty-admin-key',test_key)::text,true);
  set local role authenticated;
  begin
    perform public.mighty_admin_overview();
    raise exception 'unregistered account accepted';
  exception when insufficient_privilege then null; end;
  reset role;

  insert into mighty_private.admin_installations(user_id,key_digest)
  values(fixture,sha256(convert_to(test_key,'UTF8')));
  set local role authenticated;
  data := public.mighty_admin_members(test_mail,1);
  assert (data->>'total')::int=1 and data#>>'{items,0,email}'=test_mail;
  assert (data#>>'{items,0,balance}')::int=1000;
  assert public.mighty_admin_members(test_mail,2)->'items'='[]'::jsonb;
  assert public.mighty_admin_ledger(1,fixture)#>>'{items,0,kind}'='welcome';
  assert (public.mighty_admin_logins(1,fixture)->>'total')::int=1;
  assert public.mighty_admin_hands(1) ? 'items';
  assert (public.mighty_admin_overview()->>'verified')::int >= 1;
  perform set_config('request.headers','{}',true);
  begin
    perform public.mighty_admin_ledger();
    raise exception 'missing local installation key accepted';
  exception when insufficient_privilege then null; end;
  reset role;
  delete from auth.sessions where id=login_id;
  perform set_config('request.headers',jsonb_build_object('x-mighty-admin-key',test_key)::text,true);
  set local role authenticated;
  begin
    perform public.mighty_admin_logins();
    raise exception 'revoked login session accepted';
  exception when insufficient_privilege then null; end;
  reset role;
  assert (select count(*)=1 from mighty_private.login_events where session_id=login_id);
  assert not has_function_privilege('anon','public.mighty_admin_overview()','execute');
end;
$test$;
select 'ok - local installation and active administrator session, account search, history and pagination' as checks;
rollback;
