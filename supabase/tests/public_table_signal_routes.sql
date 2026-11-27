begin;
-- Exercise the legacy directory before its public slots switch to server control.
do $$ begin
  if to_regclass('mighty_private.public_lobbies') is not null then
    delete from mighty_private.public_lobbies;
  end if;
end $$;
do $test$
declare
  founder uuid:=gen_random_uuid(); challenger uuid:=gen_random_uuid(); first_room uuid:=gen_random_uuid();
  next_room uuid:=gen_random_uuid(); other_room uuid:=gen_random_uuid(); legacy_room uuid:=gen_random_uuid();
  key text:=repeat('a',64); other_key text:=repeat('b',64); route text; result jsonb; expiry timestamptz; started timestamptz;
  good jsonb:='{"phase":"waiting","hostName":"관전 방장","humanCount":0,"spectatorCount":1,"reservationCount":0,"roundNumber":1,"roundLimit":10}';
begin
  assert not has_function_privilege('anon','public.mighty_directory_open_routed(uuid,text,text,integer,text,text)','execute');
  assert has_function_privilege('authenticated','public.mighty_directory_open_routed(uuid,text,text,integer,text,text)','execute');
  insert into auth.users(id,email,email_confirmed_at) values
    (founder,founder::text||'@example.invalid',now()),(challenger,challenger::text||'@example.invalid',now());
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',founder)::text,true);
  started:=clock_timestamp();
  result:=public.mighty_directory_open_routed(first_room,key,'PUB001',1,null,'처음');
  route:=result->>'signalRoute';
  assert route ~ '^[0-9a-f]{32}$' and (result->>'claimed')::boolean;
  assert route<>replace(first_room::text,'-','');
  reset role;
  select s.expires_at into expiry from mighty_private.directory_slots s where slot=1;
  assert expiry between started+interval '25 seconds' and clock_timestamp()+interval '25 seconds';
  set local role authenticated;
  perform public.mighty_directory_refresh(first_room,key,1,good||jsonb_build_object('signalRoute',route));
  reset role;
  select s.expires_at into expiry from mighty_private.directory_slots s where slot=1;
  assert expiry>started+interval '1 minute';
  set local role authenticated;
  assert public.mighty_directory_open_routed(first_room,key,'PUB001',1,null,'재시도')=result;
  reset role;
  assert (select expires_at from mighty_private.directory_slots where slot=1)=expiry;
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',challenger)::text,true);
  assert public.mighty_directory_open_routed(other_room,other_key,'PUB001',1,null,'입장')=
    jsonb_build_object('claimed',false,'code','PUB001','slot',1,'signalRoute',route);
  begin
    perform public.mighty_directory_open_routed(first_room,other_key,'PUB001',1,null,'타인');
    raise exception 'changed an existing archive using another account';
  exception when insufficient_privilege then null; end;
  set local role anon;
  assert public.mighty_directory_list()->0->>'signalRoute'=route;
  -- A different instance can claim a timed-out slot while its old browser
  -- still exists. The old controller can no longer advertise into the new room.
  reset role;
  update mighty_private.directory_slots set expires_at=clock_timestamp()-interval '1 second' where slot=1;
  set local role authenticated;
  result:=public.mighty_directory_open_routed(next_room,other_key,'PUB001',1,null,'다음');
  assert (result->>'claimed')::boolean and result->>'signalRoute'<>route;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',founder)::text,true);
  begin
    perform public.mighty_directory_refresh(first_room,key,1,good||jsonb_build_object('signalRoute',route));
    raise exception 'stale controller overrode its replacement';
  exception when no_data_found then null; end;
  assert public.mighty_directory_list()->0->'signalRoute'=result->'signalRoute';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',challenger)::text,true);
  perform public.mighty_directory_refresh(next_room,other_key,1,good||jsonb_build_object('signalRoute',route));
  assert not (public.mighty_directory_list()->0 ? 'signalRoute');
  perform public.mighty_directory_refresh(next_room,other_key,1,good||jsonb_build_object('signalRoute',result->>'signalRoute'));
  assert not (public.mighty_directory_list()->0 ? 'signalRoute');
  perform public.mighty_directory_close(next_room,other_key,1);
  result:=public.mighty_directory_open_routed(other_room,other_key,'PUB001',1,null,'다음');
  perform public.mighty_directory_refresh(other_room,other_key,1,good);
  assert not (public.mighty_directory_list()->0 ? 'signalRoute');
  perform public.mighty_directory_close(other_room,other_key,1);
  -- A new client can enter a room founded by an older client at its fixed code.
  perform public.mighty_directory_open(legacy_room,other_key,'PUB001',1,null,'기존');
  result:=public.mighty_directory_open_routed(gen_random_uuid(),key,'PUB001',1,null,'입장');
  assert result='{"claimed":false,"code":"PUB001","slot":1}'::jsonb;
  perform public.mighty_directory_refresh(legacy_room,other_key,1,good||jsonb_build_object('signalRoute',route));
  assert not (public.mighty_directory_list()->0 ? 'signalRoute');
end;
$test$;
rollback;
