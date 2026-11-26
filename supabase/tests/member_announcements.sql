begin;
do $test$
declare
  operator uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  changed uuid := gen_random_uuid();
  unconfirmed uuid := gen_random_uuid();
  late uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid();
  announcement uuid := gen_random_uuid();
  local_key text := repeat('z',43);
  item jsonb;
begin
  insert into auth.users(id,email,email_confirmed_at,created_at) values
    (operator,operator::text || '@example.invalid',now(),now()),
    (member,member::text || '@example.invalid',now(),now()),
    (changed,changed::text || '@example.invalid',now(),now()),
    (unconfirmed,unconfirmed::text || '@example.invalid',null,now());
  insert into auth.sessions(id,user_id,created_at) values(session_id,operator,now());
  insert into mighty_private.admin_installations(user_id,key_digest)
    values(operator,sha256(convert_to(local_key,'UTF8')));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',operator,'session_id',session_id,'role','authenticated')::text,true);
  perform set_config('request.headers','{}',true);
  set local role authenticated;
  begin
    perform public.mighty_admin_mail_preview(announcement,'title','body');
    raise exception 'unregistered machine could create a campaign';
  exception when insufficient_privilege then null; end;
  perform set_config('request.headers',jsonb_build_object('x-mighty-admin-key',local_key)::text,true);
  item := public.mighty_admin_mail_preview(announcement,'title','body');
  assert (item->>'total')::int >= 3 and item->>'submittedAt' is null and item->>'body'='body';
  assert public.mighty_admin_mail_preview(announcement,'title','body') = item;
  begin
    perform public.mighty_admin_mail_preview(announcement,'different title','body');
    raise exception 'immutable draft contents were replaced';
  exception when unique_violation then null; end;
  reset role;
  assert not exists(select 1 from mighty_private.announcement_targets where announcement_id=announcement and member_id=unconfirmed);
  assert not exists(select 1 from mighty_private.mail_delivery where source_id=announcement);
  -- Only the three synthetic addresses can possibly enter this test campaign's outbox.
  delete from mighty_private.announcement_targets where announcement_id=announcement and member_id not in(operator,member,changed);
  insert into auth.users(id,email,email_confirmed_at,created_at) values(late,late::text || '@example.invalid',now(),now());
  update auth.users set email='new-' || changed::text || '@example.invalid' where id=changed;
  set local role authenticated;
  item := public.mighty_admin_mail_send(announcement);
  assert (item->>'total')::int=3 and (item->>'queued')::int=2 and item->>'submittedAt' is not null;
  assert public.mighty_admin_mail_send(announcement) = item;
  assert public.mighty_admin_mail_status(announcement) = item;
  assert public.mighty_admin_mail_history(1)#>>'{items,0,id}'=announcement::text;
  assert (public.mighty_admin_mail_history(2)->'items')='[]'::jsonb;
  reset role;
  update mighty_private.mail_delivery set status=case when recipient=operator::text || '@example.invalid' then 'sent' else 'failed' end
    where source_id=announcement;
  set local role authenticated;
  item := public.mighty_admin_mail_retry(announcement);
  assert (item->>'sent')::int=1 and (item->>'queued')::int=1 and (item->>'failed')::int=0;
  reset role;
  update mighty_private.mail_delivery set status='uncertain' where source_id=announcement and status='queued';
  set local role authenticated;
  assert (public.mighty_admin_mail_retry(announcement)->>'uncertain')::int=1;
  reset role;
  assert (select count(*)=2 from mighty_private.mail_delivery where source_id=announcement);
  assert not has_function_privilege('anon','public.mighty_admin_mail_send(uuid)','execute');
end;
$test$;
rollback;
