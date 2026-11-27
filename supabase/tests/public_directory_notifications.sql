-- Run on an isolated database with Realtime (or its send/messages test double).
begin isolation level repeatable read;
create temporary view directory_notice_count as
select count(*) as total,
  count(*) filter (where event = 'changed' and private = false and payload - 'id' = '{}'::jsonb) as safe
from realtime.messages where topic = 'mighty-public-directory';

do $test$
declare
  member uuid := gen_random_uuid(); room uuid := gen_random_uuid(); game uuid := gen_random_uuid();
  summary jsonb := '{"phase":"waiting","hostName":"방장","seats":["방장",null,null,null,null],"humanCount":1,"spectatorCount":0,"reservationCount":0,"roundNumber":1,"roundLimit":10}';
  state jsonb := jsonb_build_object('controlKey',repeat('c',64),'controlTerm',1,'chatSeq',0);
  digest text := repeat('b',64);
  initial_total bigint; initial_safe bigint;
begin
  select total, safe into initial_total, initial_safe from directory_notice_count;
  assert not has_function_privilege('anon','mighty_private.notify_public_directory()','execute');
  assert not has_table_privilege('anon','mighty_private.directory_slots','select');
  insert into auth.users(id,email,email_confirmed_at) values(member,member::text||'@example.invalid',now());

  perform public.mighty_lobby_commit(1,0,room,state,summary,member,member);
  assert (select total = initial_total + 1 from directory_notice_count), 'first occupant';
  perform public.mighty_lobby_commit(1,1,room,state,summary,member,member);
  update mighty_private.directory_slots d set summary = d.summary || '{"humanCount":1}'::jsonb where slot=5;
  assert (select total = initial_total + 1 from directory_notice_count), 'heartbeat and private room are silent';

  summary := summary || '{"spectatorCount":1}';
  perform public.mighty_lobby_commit(1,2,room,state,summary,member,member);
  summary := summary || '{"seats":["방장","다음",null,null,null],"spectatorCount":0,"humanCount":2}';
  perform public.mighty_lobby_commit(1,3,room,state,summary,member,member);
  assert (select total = initial_total + 3 from directory_notice_count), 'observer enters and takes a seat';

  summary := summary || '{"phase":"playing"}';
  state := state || jsonb_build_object('offer',jsonb_build_object('status','starting','manifest',digest,'spec',
    jsonb_build_object('handId',game,'host',member,'seats',jsonb_build_array(member,null,null,null,null))));
  perform public.mighty_lobby_commit(1,4,room,state,summary,member,member,null,jsonb_build_object('id',game,'hostId',member));
  insert into mighty_private.hands(id,room,host_id,seats,manifest,state)
    values(game,'PUB001',member,array[member,null,null,null,null],digest,'{}');
  update mighty_private.hands set settled=false, revision=revision+1 where id=game;
  assert (select total = initial_total + 5 from directory_notice_count), 'visible hand starts, ordinary card moves are silent';
  update mighty_private.directory_slots set expires_at=statement_timestamp()-interval '1 minute' where slot=1;
  assert public.mighty_directory_list()->0->>'phase'='settling';
  update mighty_private.hands set settled=true where id=game;
  assert public.mighty_directory_list()->0->>'phase'='empty';
  perform public.mighty_lobby_commit(1,5,room,null,null,member,null);
  assert (select total = initial_total + 8 and safe = initial_safe + 8 from directory_notice_count),
    'expiry, unattended settlement and release notify without public row data';
end;
$test$;
rollback;
