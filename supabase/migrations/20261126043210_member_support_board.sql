create table mighty_private.support_threads (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 100),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  answered boolean not null default false
);
create index support_threads_owner_updated on mighty_private.support_threads(owner_id,updated_at desc,id);
create index support_threads_updated on mighty_private.support_threads(updated_at desc,id);
create table mighty_private.support_messages (
  id uuid primary key,
  thread_id uuid not null references mighty_private.support_threads(id) on delete cascade,
  ordinal bigint generated always as identity,
  is_admin boolean not null,
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp()
);
create index support_messages_thread on mighty_private.support_messages(thread_id,ordinal);
create table mighty_private.support_mail_outbox (
  message_id uuid primary key references mighty_private.support_messages(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
alter table mighty_private.support_threads enable row level security;
alter table mighty_private.support_messages enable row level security;
alter table mighty_private.support_mail_outbox enable row level security;
revoke all on mighty_private.support_threads, mighty_private.support_messages, mighty_private.support_mail_outbox
  from public, anon, authenticated, service_role;
revoke all on sequence mighty_private.support_messages_ordinal_seq from public, anon, authenticated, service_role;

-- All posting functions obtain the thread lock before inserting a message.
create function mighty_private.support_after_message() returns trigger
language plpgsql set search_path = '' as $$
begin
  update mighty_private.support_threads set updated_at=new.created_at,answered=new.is_admin where id=new.thread_id;
  if not new.is_admin then
    insert into mighty_private.support_mail_outbox(message_id) values(new.id);
  end if;
  return new;
end;
$$;
revoke all on function mighty_private.support_after_message() from public, anon, authenticated, service_role;
create trigger support_after_insert after insert on mighty_private.support_messages
  for each row execute function mighty_private.support_after_message();

-- Null owner scope is only passed by the installation-checked admin entry points.
create function mighty_private.support_list(p_owner uuid,p_page integer) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if p_page is null or p_page < 1 then raise exception '페이지 번호를 확인해 주세요.' using errcode='22023'; end if;
  return (with recent as (
    select t.* from mighty_private.support_threads t where p_owner is null or t.owner_id=p_owner
      order by t.updated_at desc,t.id limit 20 offset (p_page::bigint-1)*20
  )
  select jsonb_build_object('page',p_page,'pageSize',20,
    'total',(select count(*) from mighty_private.support_threads t where p_owner is null or t.owner_id=p_owner),
    'items',coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'answered',r.answered,
      'createdAt',r.created_at,'updatedAt',r.updated_at) || case when p_owner is null then
      jsonb_build_object('email',u.email,'nickname',u.raw_user_meta_data->>'nickname') else '{}'::jsonb end
      order by r.updated_at desc,r.id),'[]'::jsonb))
    from recent r left join auth.users u on p_owner is null and u.id=r.owner_id);
end;
$$;
create function mighty_private.support_detail(p_owner uuid,p_thread uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object('id',t.id,'title',t.title,'answered',t.answered,'createdAt',t.created_at,
    'updatedAt',t.updated_at,'messages',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,
    'isAdmin',m.is_admin,'body',m.body,'createdAt',m.created_at) order by m.ordinal),'[]'::jsonb)
    from mighty_private.support_messages m where m.thread_id=t.id)) ||
    case when p_owner is null then jsonb_build_object('email',u.email,'nickname',u.raw_user_meta_data->>'nickname')
    else '{}'::jsonb end into result from mighty_private.support_threads t
    left join auth.users u on p_owner is null and t.owner_id=u.id
    where t.id=p_thread and (p_owner is null or t.owner_id=p_owner);
  if result is null then raise exception '문의를 찾을 수 없습니다.' using errcode='P0001'; end if;
  return result;
end;
$$;

create function mighty_private.support_post(p_owner uuid,p_thread uuid,p_message uuid,p_body text) returns jsonb
language plpgsql set search_path = '' as $$
declare content text := regexp_replace(coalesce(p_body,''),'^[[:space:]]+|[[:space:]]+$','','g');
begin
  if p_message is null or length(content) not between 1 and 4000 then
    raise exception '내용을 1~4,000자로 입력해 주세요.' using errcode='22023';
  end if;
  perform 1 from mighty_private.support_threads t where t.id=p_thread and (p_owner is null or t.owner_id=p_owner) for update;
  if not found then raise exception '문의를 찾을 수 없습니다.' using errcode='P0001'; end if;
  insert into mighty_private.support_messages(id,thread_id,is_admin,body) values(p_message,p_thread,p_owner is null,content)
    on conflict(id) do nothing;
  if not found and not exists(select 1 from mighty_private.support_messages m
      where m.id=p_message and m.thread_id=p_thread and m.is_admin=(p_owner is null) and m.body=content) then
    raise exception '이미 처리된 요청입니다. 문의 내용을 다시 확인해 주세요.' using errcode='P0001';
  end if;
  return mighty_private.support_detail(p_owner,p_thread);
end;
$$;

create function public.mighty_support_list(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  perform mighty_private.require_verified(actor);
  return mighty_private.support_list(actor,p_page);
end;
$$;
create function public.mighty_support_thread(p_thread uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  perform mighty_private.require_verified(actor);
  return mighty_private.support_detail(actor,p_thread);
end;
$$;
create function public.mighty_support_create(p_thread uuid,p_title text,p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); subject text := regexp_replace(coalesce(p_title,''),'^[[:space:]]+|[[:space:]]+$','','g');
begin
  perform mighty_private.require_verified(actor);
  if p_thread is null or length(subject) not between 1 and 100 then
    raise exception '제목을 1~100자로 입력해 주세요.' using errcode='22023';
  end if;
  insert into mighty_private.support_threads(id,owner_id,title) values(p_thread,actor,subject) on conflict(id) do nothing;
  if not found and not exists(select 1 from mighty_private.support_threads where id=p_thread and owner_id=actor and title=subject) then
    raise exception '이미 처리된 요청입니다. 문의 목록을 확인해 주세요.' using errcode='P0001';
  end if;
  return mighty_private.support_post(actor,p_thread,p_thread,p_body);
end;
$$;
create function public.mighty_support_reply(p_thread uuid,p_message uuid,p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  perform mighty_private.require_verified(actor);
  return mighty_private.support_post(actor,p_thread,p_message,p_body);
end;
$$;
create function public.mighty_admin_support_list(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform mighty_private.check_admin();
  return mighty_private.support_list(null,p_page);
end;
$$;
create function public.mighty_admin_support_thread(p_thread uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform mighty_private.check_admin();
  return mighty_private.support_detail(null,p_thread);
end;
$$;
create function public.mighty_admin_support_reply(p_thread uuid,p_message uuid,p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform mighty_private.check_admin();
  return mighty_private.support_post(null,p_thread,p_message,p_body);
end;
$$;

revoke all on function mighty_private.support_list(uuid,integer), mighty_private.support_detail(uuid,uuid),
  mighty_private.support_post(uuid,uuid,uuid,text),
  public.mighty_support_list(integer), public.mighty_support_thread(uuid), public.mighty_support_create(uuid,text,text),
  public.mighty_support_reply(uuid,uuid,text), public.mighty_admin_support_list(integer),
  public.mighty_admin_support_thread(uuid), public.mighty_admin_support_reply(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.mighty_support_list(integer), public.mighty_support_thread(uuid), public.mighty_support_create(uuid,text,text),
  public.mighty_support_reply(uuid,uuid,text), public.mighty_admin_support_list(integer),
  public.mighty_admin_support_thread(uuid), public.mighty_admin_support_reply(uuid,uuid,text) to authenticated;
