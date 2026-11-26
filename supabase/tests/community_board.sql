begin;
set local plpgsql.check_asserts=on;
do $test$
declare member uuid:=gen_random_uuid(); admin_id uuid:=gen_random_uuid(); session_id uuid:=gen_random_uuid();
  request_id uuid:=gen_random_uuid(); note uuid:=gen_random_uuid(); post uuid; comment uuid; details jsonb;
  device text:=replace(gen_random_uuid()::text,'-','')||'fixture-key';
begin
  insert into auth.users(id,email,email_confirmed_at,created_at,raw_user_meta_data) values
    (member,member||'@example.invalid',now(),now(),'{"nickname":"한 회원"}'),
    (admin_id,admin_id||'@example.invalid',now(),now(),'{}');
  insert into auth.sessions(id,user_id,created_at) values(session_id,admin_id,now());
  insert into mighty_private.admin_installations values(admin_id,sha256(convert_to(device,'UTF8')));
  assert not has_function_privilege('anon','public.mighty_community_create(uuid,text,text)','execute');
  assert not has_table_privilege('anon','mighty_private.community_posts','select');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member)::text,true);
  set local role authenticated;
  perform public.mighty_support_create(request_id,'Private','PRIVATE BODY');
  details:=public.mighty_community_create(request_id,'Public','PUBLIC BODY');
  post:=(details->>'id')::uuid;
  assert post<>request_id and details->>'nickname'='한 회원';
  assert public.mighty_community_create(request_id,'Public','PUBLIC BODY')->>'id'=post::text;
  perform public.mighty_support_create(post,'Another private thread','private');
  details:=public.mighty_community_comment(post,note,'first comment');
  comment:=(details->'comments'->0->>'id')::uuid;
  perform public.mighty_community_comment(post,note,'first comment');
  begin
    perform public.mighty_admin_community_visibility(post,true);
    raise exception 'non-admin hid post';
  exception when insufficient_privilege then null; end;
  reset role;
  set local role anon;
  details:=public.mighty_community_thread(post);
  assert details->>'body'='PUBLIC BODY' and details->>'total'='1';
  assert strpos(details::text,member::text)=0 and strpos(details::text,'@example.invalid')=0;
  assert strpos(public.mighty_community_list()::text,request_id::text)=0;
  begin perform public.mighty_community_thread(request_id); raise exception 'private ID visible in public';
    exception when raise_exception then if sqlerrm='private ID visible in public' then raise; end if; end;
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'session_id',session_id)::text,true);
  perform set_config('request.headers',jsonb_build_object('x-mighty-admin-key',device)::text,true);
  perform public.mighty_admin_community_visibility(post,true,comment);
  assert public.mighty_community_thread(post)->>'total'='0';
  assert (public.mighty_admin_community_thread(post)->'comments'->0->>'hidden')::boolean;
  perform public.mighty_admin_community_visibility(post,true);
  assert not (public.mighty_community_list()->'items' @> jsonb_build_array(jsonb_build_object('id',post)));
  begin perform public.mighty_community_thread(post); raise exception 'hidden post visible';
    exception when raise_exception then if sqlerrm='hidden post visible' then raise; end if; end;
  begin perform public.mighty_community_comment(post,gen_random_uuid(),'another'); raise exception 'hidden post accepted comment';
    exception when raise_exception then if sqlerrm='hidden post accepted comment' then raise; end if; end;
  perform public.mighty_admin_community_visibility(post,false);
  perform public.mighty_admin_community_visibility(post,false,comment);
  assert public.mighty_community_thread(post)->>'total'='1';
  reset role;
  assert (select count(*) from mighty_private.mail_delivery where source_id=post and recipient=admin_id||'@example.invalid'
    and subject='[마이티 온라인] 새 문의가 도착했습니다')=1;
  assert (select count(*) from mighty_private.mail_delivery where source_id<>post and recipient=admin_id||'@example.invalid'
    and subject='[마이티 온라인] 자유게시판 새 글')=1;
  assert not exists(select 1 from mighty_private.mail_delivery where source_id=comment);
end;
$test$;
rollback;
