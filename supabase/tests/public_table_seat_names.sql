begin;
-- Exercise the legacy directory before its public slots switch to server control.
do $$ begin
  if to_regclass('mighty_private.public_lobbies') is not null then
    delete from mighty_private.public_lobbies;
  end if;
end $$;
do $test$
declare
  who uuid:=gen_random_uuid(); public_id uuid:=gen_random_uuid(); private_id uuid:=gen_random_uuid();
  key text:=repeat('a',64); seats jsonb:='[null,"같은 이름",null,"같은 이름",null]';
  summary jsonb:='{"phase":"playing","hostName":"관전 방장","humanCount":2,"reservationCount":1,"spectatorCount":3,"roundNumber":4,"roundLimit":20}';
  old_summary jsonb; exposed jsonb; bad jsonb;
begin
  insert into auth.users(id,email,email_confirmed_at) values(who,who::text||'@example.invalid',now());
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',who)::text,true);
  perform public.mighty_directory_open(public_id,key,'PUB001',1,null,'처음');
  assert not (public.mighty_directory_list()->0 ? 'seats'); -- no roster has been published
  perform public.mighty_directory_refresh(public_id,key,1,summary||jsonb_build_object('seats',seats,
    'email','private@example.invalid','controller',key,'id',who,'observers','private'));
  set local role anon;
  exposed:=public.mighty_directory_list()->0;
  assert exposed=summary||jsonb_build_object('code','PUB001','slot',1,'name','스페이드 테이블','seats',seats);
  set local role authenticated;
  for bad in select value from jsonb_array_elements('[
    null,{},[],[null,null,null,null,null],[" ",null,"유효",null,null],[{"name":"숨김","id":"private"},null,"유효",null,null],
    [true,null,"유효",null,null],["12345678901234567",null,"유효",null,null]
  ]') loop
    begin
      perform public.mighty_directory_refresh(public_id,key,1,summary||jsonb_build_object('seats',bad));
      raise exception 'accepted invalid seats'; exception when invalid_parameter_value then null;
    end;
  end loop;
  assert public.mighty_directory_list()->0=exposed;
  -- A legacy elected host starts publishing counts only. Previous names
  -- must disappear on its first summary, even if humanCount stayed equal.
  old_summary:=summary||'{"hostName":"새 방장"}'::jsonb;
  perform public.mighty_directory_refresh(public_id,key,1,old_summary);
  assert public.mighty_directory_list()->0=old_summary||jsonb_build_object('code','PUB001','slot',1,'name','스페이드 테이블');
  perform public.mighty_directory_refresh(public_id,key,1,summary||'{"humanCount":0,"seats":[null,null,null,null,null]}'::jsonb);
  assert public.mighty_directory_list()->0->'seats'='[null,null,null,null,null]'::jsonb;
  perform public.mighty_directory_open(private_id,key,'SECRE4',null,'비공개','비공개 방장');
  perform public.mighty_directory_refresh(private_id,key,1,summary||'{"seats":["초대방 참가자","둘",null,null,null]}'::jsonb);
  assert position('초대방 참가자' in public.mighty_directory_list()::text)=0;
  perform public.mighty_directory_close(public_id,key,1);
  assert not (public.mighty_directory_list()->0 ? 'seats');
end;
$test$;
rollback;
