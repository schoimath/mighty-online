begin;
do $test$
declare
  founder uuid:=gen_random_uuid(); next_host uuid:=gen_random_uuid(); admin uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid();
  a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); h1 uuid:=gen_random_uuid(); h2 uuid:=gen_random_uuid(); old_hand uuid:=gen_random_uuid();
  req uuid:=gen_random_uuid(); code text:=upper(substr(md5(a::text),1,6)); receipt jsonb; info jsonb; archives jsonb;
  first_key text:=repeat('a',64); next_key text:=repeat('b',64); observer_key text:=repeat('c',64); spare_key text:=repeat('d',64); key text:=repeat('t',43);
  list jsonb:=jsonb_build_array(jsonb_build_object('accountId',next_host,'digest',encode(sha256(convert_to(next_key,'UTF8')),'hex')),
    jsonb_build_object('accountId',null,'digest',encode(sha256(convert_to(observer_key,'UTF8')),'hex')),
    jsonb_build_object('accountId',null,'digest',encode(sha256(convert_to(spare_key,'UTF8')),'hex')));
begin
  insert into auth.users(id,email,email_confirmed_at) select id,id::text||'@example.invalid',now() from unnest(array[founder,next_host,admin]) id;
  insert into auth.sessions(id,user_id,created_at) values(sid,admin,now());
  insert into mighty_private.admin_installations(user_id,key_digest) values(admin,sha256(convert_to(key,'UTF8')));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',founder)::text,true);
  set local role authenticated;
  assert public.mighty_room_chat_open(a,code,first_key)=1;
  assert public.mighty_room_chat_open(a,code,first_key)=1;
  assert public.mighty_room_chat_open(b,code,next_key)=1;
  receipt:=public.mighty_room_chat_append(a,first_key,1,req,0,'방장',' 첫 번째 ');
  assert receipt->>'id'='1' and receipt->>'text'='첫 번째' and receipt->>'replayed'='false';
  info:=public.mighty_room_chat_append(a,first_key,1,req,0,'방장','첫 번째');
  assert info->>'replayed'='true' and info->>'time'=receipt->>'time';
  begin
    perform public.mighty_room_chat_append(a,first_key,1,req,0,'방장','different');
    raise exception 'conflicting replay authorized';
  exception when invalid_parameter_value then null; end;
  perform public.mighty_room_chat_append(b,next_key,1,req,0,'같은 이름','별도 방');
  perform public.mighty_room_chat_link_hand(a,first_key,1,h1);
  perform public.mighty_room_chat_successors(a,first_key,1,list);
  begin perform public.mighty_admin_room_chat(code,founder,a);
    raise exception 'founder read archive'; exception when insufficient_privilege then null; end;
  begin perform public.mighty_admin_room_session_hands(code,founder,a);
    raise exception 'founder read hands report'; exception when insufficient_privilege then null; end;
  -- Knowing the invitation code and room UUID is insufficient even for a logged-in member.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',next_host)::text,true);
  begin perform public.mighty_room_chat_append(a,first_key,1,gen_random_uuid(),0,'name','test');
    raise exception 'wrong account relayed'; exception when insufficient_privilege then null; end;
  begin perform public.mighty_room_chat_open(a,code,next_key);
    raise exception 'candidate opened before elected'; exception when insufficient_privilege then null; end;
  assert public.mighty_room_chat_claim(a,next_key,1)=0;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',founder)::text,true);
  assert public.mighty_room_chat_transfer(a,first_key,1,encode(sha256(convert_to(next_key,'UTF8')),'hex'))=2;
  begin perform public.mighty_room_chat_append(a,first_key,1,gen_random_uuid(),0,'name','test');
    raise exception 'outgoing host still relays'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',next_host)::text,true);
  assert public.mighty_room_chat_claim(a,next_key,1)=2 and public.mighty_room_chat_open(a,code,next_key)=2;
  assert public.mighty_room_chat_append(a,next_key,2,gen_random_uuid(),1,'후임','두 번째')->>'id'='2';
  perform public.mighty_room_chat_link_hand(a,next_key,2,h2);
  reset role;
  insert into mighty_private.hands(id,room,host_id,seats,manifest,state,settled)
    select deal,code,player,array[player,null,null,null,null],repeat('a',64),'{}',true
    from (values (h1,founder),(h2,next_host),(old_hand,founder)) s(deal,player);
  set local role service_role;
  assert public.mighty_hand_room_controller(h1,next_key,2,next_host);
  assert not public.mighty_hand_room_controller(h1,first_key,1,founder);
  assert not public.mighty_hand_room_controller(h1,next_key,2,founder);
  assert not public.mighty_hand_room_controller(old_hand,next_key,2,next_host);
  reset role;
  update mighty_private.chat_rooms set lease_until=clock_timestamp()-interval '1 second' where id=a;
  set local role anon;
  perform set_config('request.jwt.claims','{}',true);
  assert public.mighty_room_chat_claim(a,observer_key,1)=3;
  assert public.mighty_room_chat_claim(a,spare_key,1)=0;
  assert public.mighty_room_chat_open(a,code,observer_key)=3;
  assert public.mighty_room_chat_append(a,observer_key,3,gen_random_uuid(),-1,'손님','관전 채팅')->>'id'='3';
  begin perform public.mighty_room_chat_open(gen_random_uuid(),code,spare_key);
    raise exception 'anonymous created an archive'; exception when insufficient_privilege then null; end;
  reset role;
  assert not has_function_privilege('anon','public.mighty_admin_room_chat(text,uuid,uuid,integer)','execute');
  assert not has_function_privilege('authenticated','public.mighty_hand_room_controller(uuid,text,bigint,uuid)','execute');
  assert not has_table_privilege('authenticated','mighty_private.chat_messages','select');
  assert not has_function_privilege('anon','mighty_private.chat_promote(uuid,jsonb)','execute');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'session_id',sid)::text,true);
  perform set_config('request.headers',jsonb_build_object('x-mighty-admin-key',key)::text,true);
  set local role authenticated;
  archives:=public.mighty_admin_rooms();
  assert exists(select 1 from jsonb_array_elements(archives->'items') i where i->>'roomId'=a::text and i->>'handCount'='2' and i->>'chatCount'='3');
  assert exists(select 1 from jsonb_array_elements(archives->'items') i where i->>'roomId'=b::text and i->>'handCount'='0' and i->>'chatCount'='1');
  assert public.mighty_admin_room_session_hands(code,founder,a)->>'total'='2';
  assert public.mighty_admin_room_session_hands(code,founder,b)->>'total'='0';
  assert public.mighty_admin_room_session_hands(code,founder,null)->>'total'='1';
  assert public.mighty_admin_room_chat(code,next_host,a)->>'total'='0';
  assert public.mighty_admin_room_chat(code,founder,null)->>'total'='0';
  info:=public.mighty_admin_room_chat(code,founder,a);
  assert info->>'total'='3' and info#>>'{items,0,seat}'='-1' and info#>>'{items,2,text}'='첫 번째';
  assert info::text not like '%'||observer_key||'%';
  perform set_config('request.headers','{}',true);
  begin perform public.mighty_admin_room_chat(code,founder,a);
    raise exception 'administrator without local verification read archive'; exception when insufficient_privilege then null; end;
end;
$test$;
rollback;
