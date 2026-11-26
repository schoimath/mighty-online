begin;
do $test$
declare
  founder uuid:=gen_random_uuid(); replacement uuid:=gen_random_uuid(); room uuid:=gen_random_uuid(); lost uuid:=gen_random_uuid();
  private_room uuid; first_private uuid; fresh uuid:=gen_random_uuid(); hand uuid:=gen_random_uuid();
  key1 text:=repeat('a',64); key2 text:=repeat('b',64);
  expected jsonb; rows jsonb; receipt jsonb; i integer;
begin
  insert into auth.users(id,email,email_confirmed_at) select id,id::text||'@example.invalid',now() from unnest(array[founder,replacement]) id;
  set local role anon;
  rows:=public.mighty_directory_list();
  assert jsonb_array_length(rows)=4 and rows->0->>'code'='PUB001' and rows->3->>'code'='PUB004';
  assert (select count(*)=4 from jsonb_array_elements(rows) r where r->>'phase'='empty');
  assert not has_function_privilege('anon','public.mighty_directory_open(uuid,text,text,integer,text,text)','execute');
  reset role;
  assert not has_table_privilege('authenticated','mighty_private.directory_slots','select');
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',founder)::text,true);
  receipt:=public.mighty_directory_open(room,key1,'PUB001',1,'제목','처음');
  assert receipt='{"claimed":true,"code":"PUB001","slot":1}'::jsonb;
  assert public.mighty_directory_open(room,key1,'PUB001',1,'제목','처음')=receipt;
  assert public.mighty_room_chat_open(room,'PUB001',key1)=1;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',replacement)::text,true);
  assert public.mighty_directory_open(lost,key2,'PUB001',1,'제목','후발')='{"claimed":false,"code":"PUB001","slot":1}'::jsonb;
  reset role;
  assert not exists(select 1 from mighty_private.chat_rooms where id=lost);
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',founder)::text,true);
  expected:='{"phase":"playing","hostName":"처음","humanCount":2,"reservationCount":1,"spectatorCount":3,"roundNumber":4,"roundLimit":20}';
  perform public.mighty_directory_refresh(room,key1,1,expected||'{"hand":["SA"],"key":"private"}'::jsonb);
  assert public.mighty_directory_list()->0=(expected||'{"slot":1,"code":"PUB001","name":"스페이드 테이블"}'::jsonb);
  for i in 1..6 loop
    private_room:=gen_random_uuid();
    if i=1 then first_private:=private_room; end if;
    receipt:=public.mighty_directory_open(private_room,key1,'PRIV0'||i,null,' 비밀방 ','주최자');
    assert receipt->>'claimed'='true' and (receipt->>'slot')::integer=4+i;
    perform public.mighty_directory_refresh(private_room,key1,1,null);
  end loop;
  begin
    perform public.mighty_directory_open(lost,key2,'PRIV07',null,'비밀방','후발');
    raise exception 'private capacity exceeded'; exception when raise_exception then
    assert sqlerrm like '%6개%';
  end;
  begin
    perform public.mighty_directory_open(lost,key2,'PUB002',null,'비밀방','후발');
    raise exception 'private stole public code'; exception when invalid_parameter_value then null;
  end;
  rows:=public.mighty_directory_list();
  assert jsonb_array_length(rows)=4 and position('비밀방' in rows::text)=0 and position('PRIV' in rows::text)=0;
  perform public.mighty_directory_close(first_private,key1,1);
  assert public.mighty_directory_open(fresh,key2,'PRIV01',null,'다음 비밀방','다음 방장')->>'slot'='5';
  begin
    perform public.mighty_directory_open(first_private,key1,'PRIV01',null,'비밀방','처음');
    raise exception 'released archive resurrected'; exception when no_data_found then null;
  end;
  perform public.mighty_directory_close(first_private,key1,1); -- late close of the former occupant
  perform public.mighty_directory_refresh(fresh,key2,1,null);
  perform public.mighty_room_chat_successors(room,key1,1,jsonb_build_array(jsonb_build_object('accountId',replacement,'digest',encode(sha256(convert_to(key2,'UTF8')),'hex'))));
  assert public.mighty_room_chat_transfer(room,key1,1,encode(sha256(convert_to(key2,'UTF8')),'hex'))=2;
  begin perform public.mighty_directory_close(room,key1,1);
    raise exception 'retired host closed successor'; exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',replacement)::text,true);
  perform public.mighty_directory_refresh(room,key2,2,expected||'{"hostName":"후임"}'::jsonb);
  assert public.mighty_directory_list()->0->>'hostName'='후임';
  perform public.mighty_room_chat_link_hand(room,key2,2,hand);
  reset role;
  insert into mighty_private.hands(id,room,host_id,seats,manifest,state) values
    (hand,'PUB001',replacement,array[replacement,null,null,null,null],repeat('a',64),'{}');
  update mighty_private.directory_slots set expires_at=clock_timestamp()-interval '1 second' where room_id=room;
  set local role authenticated;
  assert public.mighty_directory_list()->0->>'phase'='settling';
  begin perform public.mighty_directory_open(lost,key2,'PUB001',1,'제목','대기');
    raise exception 'pending deal was reused'; exception when raise_exception then
    assert sqlerrm like '%정산%';
  end;
  reset role;
  update mighty_private.hands set settled=true where id=hand;
  set local role authenticated;
  assert public.mighty_directory_list()->0->>'phase'='empty';
  assert public.mighty_directory_open(lost,key2,'PUB001',1,'제목','대기')->>'claimed'='true';
  begin perform public.mighty_directory_refresh(room,key2,2,expected);
    raise exception 'former host revived expired slot'; exception when no_data_found then null;
  end;
  perform public.mighty_directory_close(room,key2,2);
  assert public.mighty_directory_list()->0->>'hostName'='대기';
  perform public.mighty_directory_close(lost,key2,1);
  assert public.mighty_directory_list()->0->>'phase'='empty';
  reset role;
  assert (select directory_name='비밀방' from mighty_private.chat_rooms where id=first_private);
end;
$test$;
rollback;
