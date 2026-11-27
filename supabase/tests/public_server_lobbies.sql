begin;
do $test$
declare
  a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); room uuid:=gen_random_uuid();
  legacy uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); game uuid:=gen_random_uuid();
  message uuid:=gen_random_uuid(); effect uuid:=gen_random_uuid(); proof text:=repeat('c',64); digest text:=repeat('b',64);
  state jsonb:=jsonb_build_object('controlKey',proof,'controlTerm',1,'chatSeq',0);
  summary jsonb:='{"phase":"waiting","hostName":"방장","seats":["방장",null,null,null,null],"humanCount":1,"spectatorCount":0,"reservationCount":0,"roundNumber":1,"roundLimit":10}';
  offer jsonb; receipt jsonb; list jsonb;
begin
  insert into auth.users(id,email,email_confirmed_at) select id,id::text||'@example.invalid',now() from unnest(array[a,b]) id;
  assert not has_table_privilege('service_role','mighty_private.public_lobbies','select');
  assert not has_function_privilege('anon','public.mighty_lobby_read(integer)','execute');
  assert not has_function_privilege('authenticated','public.mighty_lobby_commit(integer,bigint,uuid,jsonb,jsonb,uuid,uuid,jsonb,jsonb)','execute');
  -- Seed one still-live routed table exactly as an upgrade finds it.
  delete from mighty_private.public_lobbies where slot=2;
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',a)::text,true);
  assert (public.mighty_directory_open_routed(legacy,proof,'PUB002',2,null,'계속 중')->>'claimed')::boolean;
  begin
    perform public.mighty_directory_open_routed(other,proof,'PUB001',1,null,'예전 탭');
    raise exception 'legacy creation accepted' using errcode='XX000';
  exception when raise_exception then assert sqlerrm like '%새로고침%'; end;
  assert (public.mighty_directory_open(other,proof,'SECRET',null,'비공개','방장')->>'claimed')::boolean;
  reset role;
  insert into mighty_private.public_lobbies(slot) values(2);
  set local role anon;
  list:=public.mighty_directory_list();
  assert jsonb_array_length(list)=4 and list->0->>'serverLobby'='true' and not (list->1 ? 'serverLobby')
    and list->1 ? 'signalRoute';
  reset role;
  set local role service_role;
  assert public.mighty_lobby_read(2)->>'legacy'='true';
  begin
    perform public.mighty_lobby_commit(2,0,room,state,summary,a,a);
    raise exception 'live legacy table replaced' using errcode='XX000';
  exception when raise_exception then assert sqlerrm like '%기존%'; end;
  assert public.mighty_lobby_read(1)='{"revision":0,"roomId":null,"state":null,"legacy":false}';
  receipt:=public.mighty_lobby_commit(1,0,room,state,summary||state,a,a);
  assert receipt=jsonb_build_object('applied',true,'revision',1,'roomId',room);
  assert public.mighty_lobby_commit(1,0,gen_random_uuid(),state,summary,b,b)->>'applied'='false';
  assert public.mighty_lobby_read(1)->'state'=state;
  reset role;
  assert (select count(*)=1 from mighty_private.chat_rooms where directory_slot=1);
  list:=public.mighty_directory_list();
  assert list->0->>'serverLobby'='true' and list->0->'seats'=summary->'seats'
    and position(proof in list::text)=0 and not (list->0 ? 'signalRoute');
  set local role service_role;
  state:=state||'{"chatSeq":1}';
  receipt:=public.mighty_lobby_commit(1,1,room,state,summary,a,a,
    jsonb_build_object('seq',1,'requestId',message,'seat',0,'name','방장','text','안녕','time',1700000001000));
  assert receipt->>'revision'='2';
  offer:=jsonb_build_object('status','starting','manifest',digest,'spec',
    jsonb_build_object('handId',game,'host',a,'seats',jsonb_build_array(a,b,null,null,null)));
  state:=state||jsonb_build_object('offer',offer);
  receipt:=public.mighty_lobby_commit(1,2,room,state,summary,a,a,null,jsonb_build_object('id',game,'hostId',a));
  assert receipt->>'revision'='3';
  reset role;
  assert (select message_count=1 from mighty_private.chat_rooms where directory_slot=1);
  assert (select body='안녕' and seq=1 and sent_at=to_timestamp(1700000001)
    from mighty_private.chat_messages where request_id=message);
  begin
    insert into mighty_private.hands(id,room,host_id,seats,manifest,state)
      values(game,'PUB001',a,array[a,b,null,null,null],repeat('f',64),'{}');
    raise exception 'wrong manifest accepted' using errcode='XX000';
  exception when insufficient_privilege then null; end;
  insert into mighty_private.hands(id,room,host_id,seats,manifest,state)
    values(game,'PUB001',a,array[a,b,null,null,null],digest,'{}');
  set local role service_role;
  begin
    perform public.mighty_lobby_commit(1,3,room,null,null,a,null);
    raise exception 'premature close accepted' using errcode='XX000';
  exception when raise_exception then assert sqlerrm like '%닫을%'; end;
  state:=state||jsonb_build_object('controlTerm',2,'session',jsonb_build_object('chipHandId',game),
    'effects',jsonb_build_array(jsonb_build_object('op','setting','id',effect,'handId',game,'key','pace','value','fast')));
  perform public.mighty_lobby_commit(1,3,room,state,summary||'{"phase":"playing"}',a,b);
  assert public.mighty_chip_room_control(game,proof,2,b,false)->'departedSeats'='[0]';
  begin perform public.mighty_chip_room_control(game,null,null,a,true);
    raise exception 'peer setting accepted on server table' using errcode='XX000';
  exception when insufficient_privilege then null; end;
  assert public.mighty_lobby_read(1)->>'chipRevision'='0';
  assert public.mighty_lobby_hand_control(game,proof,2,b,effect,0,jsonb_build_object('manifest',digest,'pace','fast'))
    #>>'{hand,revision}'='1';
  assert public.mighty_lobby_read(1)->>'chipRevision'='1';
  state:=state||'{"effects":[]}';
  perform public.mighty_lobby_commit(1,4,room,state,summary||'{"phase":"playing"}',a,b);
  begin perform public.mighty_lobby_hand_control(game,proof,2,b,effect,1,jsonb_build_object('manifest',digest,'pace','slow'));
    raise exception 'stale setting was replayed' using errcode='XX000';
  exception when raise_exception then assert sqlerrm like '%이미 처리%'; end;
  begin perform public.mighty_chip_room_control(game,proof,1,a,false);
    raise exception 'former host retained control' using errcode='XX000';
  exception when insufficient_privilege then null; end;
  reset role;
  assert public.mighty_directory_list()->0->>'liveHandId'=game::text;
  -- A vanished browser eventually drops off the home page. An outstanding
  -- hand is still available to visitors and stays bound to this edition.
  update mighty_private.directory_slots set expires_at=clock_timestamp()-interval '1 minute' where slot=1;
  list:=public.mighty_directory_list();
  assert list->0->>'phase'='settling' and list->0->>'serverLobby'='true' and list->0->>'watchHandId'=game::text;
  update mighty_private.hands set settled=true where id=game;
  list:=public.mighty_directory_list();
  assert list->0->>'phase'='empty' and list->0->>'serverLobby'='true' and not (list->0 ? 'seats');
  set local role service_role;
  assert public.mighty_lobby_commit(1,5,room,null,null,a,null)->>'applied'='true';
  assert public.mighty_lobby_read(1)='{"revision":6,"roomId":null,"state":null,"legacy":false}';
  assert public.mighty_lobby_commit(1,3,room,state,summary,a,b)->>'applied'='false';
  reset role;
  assert (select body='안녕' from mighty_private.chat_messages where request_id=message);
  update mighty_private.directory_slots set expires_at=clock_timestamp()-interval '1 minute' where slot=2;
  assert public.mighty_lobby_read(2)->>'legacy'='false';
  assert public.mighty_directory_list()->1->>'serverLobby'='true';
  begin
    perform public.mighty_directory_refresh(legacy,proof,1,summary);
    raise exception 'old host revived an expired room' using errcode='XX000';
  exception when raise_exception then assert sqlerrm like '%새로고침%'; end;
  perform public.mighty_lobby_commit(2,0,gen_random_uuid(),state||'{"controlTerm":1}',summary,b,b);
end;
$test$;
rollback;
