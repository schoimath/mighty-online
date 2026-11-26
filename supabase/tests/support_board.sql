begin;
set local plpgsql.check_asserts = on;
do $test$
declare
  member uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid();
  thread uuid := gen_random_uuid();
  reply_id uuid := gen_random_uuid();
  extra_id uuid := gen_random_uuid();
  device text := replace(gen_random_uuid()::text,'-','')||'fixture-key';
  result jsonb;
begin
  insert into auth.users(id,email,email_confirmed_at,created_at) values
    (member,member||'@example.invalid',now(),now()),(other,other||'@example.invalid',now(),now()),
    (admin_id,admin_id||'@example.invalid',now(),now());
  insert into auth.sessions(id,user_id,created_at) values(session_id,admin_id,now());
  insert into mighty_private.admin_installations values(admin_id,sha256(convert_to(device,'UTF8')));
  assert not has_function_privilege('anon','public.mighty_support_create(uuid,text,text)','execute');
  assert not has_table_privilege('authenticated','mighty_private.support_messages','select');
  assert not has_table_privilege('authenticated','mighty_private.support_mail_outbox','insert');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member)::text,true);
  set local role authenticated;
  begin
    perform public.mighty_support_create(thread,'test',E' \n ');
    raise exception 'empty message accepted';
  exception when invalid_parameter_value then null; end;
  result := public.mighty_support_create(thread,' my thread ',' question ');
  assert result->>'title'='my thread' and result->'messages'->0->>'body'='question';
  assert not result?'email' and not (result->>'answered')::boolean;
  perform public.mighty_support_create(thread,'my thread','question');
  begin
    perform public.mighty_support_create(thread,'my thread','different');
    raise exception 'reused id modified content';
  exception when raise_exception then if sqlerrm='reused id modified content' then raise; end if; end;
  assert (public.mighty_support_list()->>'total')::int=1;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other)::text,true);
  assert (public.mighty_support_list()->>'total')::int=0;
  begin
    perform public.mighty_support_thread(thread);
    raise exception 'cross-account read';
  exception when raise_exception then if sqlerrm='cross-account read' then raise; end if; end;
  begin
    perform public.mighty_support_reply(thread,gen_random_uuid(),'cross-account');
    raise exception 'cross-account write';
  exception when raise_exception then if sqlerrm='cross-account write' then raise; end if; end;
  begin
    perform public.mighty_admin_support_thread(thread);
    raise exception 'unregistered admin';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'session_id',session_id)::text,true);
  begin
    perform public.mighty_admin_support_reply(thread,reply_id,'reply');
    raise exception 'device key missing';
  exception when insufficient_privilege then null; end;
  perform set_config('request.headers',jsonb_build_object('x-mighty-admin-key',device)::text,true);
  assert (public.mighty_admin_support_list()->'items') @> jsonb_build_array(jsonb_build_object('id',thread,'email',member||'@example.invalid'));
  result := public.mighty_admin_support_reply(thread,reply_id,'reply');
  assert (result->>'answered')::boolean and (result->'messages'->1->>'isAdmin')::boolean;
  perform public.mighty_admin_support_reply(thread,reply_id,'reply');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member)::text,true);
  result := public.mighty_support_reply(thread,extra_id,'follow-up');
  assert not (result->>'answered')::boolean and jsonb_array_length(result->'messages')=3;
  assert result->'messages'->2->>'body'='follow-up';
  reset role;
  assert (select count(*) from mighty_private.support_mail_outbox where message_id in(thread,reply_id,extra_id))=2;
  assert not exists(select 1 from mighty_private.support_mail_outbox where message_id=reply_id);
end;
$test$;
rollback;
