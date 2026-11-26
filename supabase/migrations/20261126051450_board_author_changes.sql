-- Keep idempotency keys after deletion. Scrub the author's text, while keeping
-- replies by other people accessible until those authors remove them as well.
alter table mighty_private.community_posts add column revision integer not null default 0, add column deleted boolean not null default false;
alter table mighty_private.community_comments add column revision integer not null default 0, add column deleted boolean not null default false,
  add constraint deleted_community_comment_is_hidden check (not deleted or hidden);
alter table mighty_private.support_messages add column revision integer not null default 0, add column deleted boolean not null default false;

create function mighty_private.visible_community_posts(p_admin boolean)
returns setof mighty_private.community_posts language sql stable set search_path='' as $$
  select p.* from mighty_private.community_posts p
  where (p_admin or not p.hidden) and (not p.deleted or exists(
    select 1 from mighty_private.community_comments c where c.post_id=p.id and not c.deleted and (p_admin or not c.hidden)));
$$;

create or replace function mighty_private.community_list(p_admin boolean,p_page integer) returns jsonb
language plpgsql stable set search_path='' as $$
begin
  if p_page is null or p_page<1 then raise exception '페이지 번호를 확인해 주세요.' using errcode='22023'; end if;
  return (with page_rows as (select p.id,p.nickname,p.title,p.created_at as "createdAt",p.hidden,
      (select count(*) from mighty_private.community_comments c where c.post_id=p.id and not c.deleted and (p_admin or not c.hidden)) as "commentCount"
      from mighty_private.visible_community_posts(p_admin) p order by p.created_at desc,p.id limit 20 offset (p_page::bigint-1)*20)
    select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(r) order by r."createdAt" desc,r.id),'[]'::jsonb),
      'page',p_page,'pageSize',20,'total',(select count(*) from mighty_private.visible_community_posts(p_admin)))
    from page_rows r);
end;
$$;

create or replace function mighty_private.community_thread(p_admin boolean,p_post uuid,p_page integer) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb; actor uuid:=auth.uid();
begin
  if p_page is null or p_page<1 then raise exception '페이지 번호를 확인해 주세요.' using errcode='22023'; end if;
  select jsonb_build_object('id',p.id,'title',p.title,'body',p.body,'nickname',p.nickname,'createdAt',p.created_at,
    'hidden',p.hidden,'mine',coalesce(actor=p.owner_id,false) and not p.deleted,'deleted',p.deleted,'revision',p.revision,
    'comments',(select coalesce(jsonb_agg(to_jsonb(r) order by r."createdAt",r.id),'[]'::jsonb) from (
        select c.id,c.body,c.nickname,c.created_at as "createdAt",c.hidden,coalesce(actor=c.owner_id,false) as mine,c.revision
        from mighty_private.community_comments c where c.post_id=p.id and not c.deleted and (p_admin or not c.hidden)
        order by c.created_at,c.id limit 20 offset (p_page::bigint-1)*20
      ) r),'total',(select count(*) from mighty_private.community_comments c where c.post_id=p.id and not c.deleted and (p_admin or not c.hidden)),
    'page',p_page,'pageSize',20) into result from mighty_private.visible_community_posts(p_admin) p where p.id=p_post;
  if result is null then raise exception '게시글을 찾을 수 없습니다.' using errcode='P0001'; end if;
  return result;
end;
$$;

create view mighty_private.visible_support_threads with (security_invoker=true) as
select t.* from mighty_private.support_threads t where exists (
  select 1 from mighty_private.support_messages m where m.thread_id=t.id and not m.deleted
);
revoke all on mighty_private.visible_support_threads from public,anon,authenticated,service_role;

create or replace function mighty_private.support_list(p_owner uuid,p_page integer) returns jsonb
language plpgsql stable set search_path='' as $$
begin
  if p_page is null or p_page<1 then raise exception '페이지 번호를 확인해 주세요.' using errcode='22023'; end if;
  return (with recent as (
    select t.* from mighty_private.visible_support_threads t where p_owner is null or t.owner_id=p_owner
      order by t.updated_at desc,t.id limit 20 offset (p_page::bigint-1)*20
  )
  select jsonb_build_object('page',p_page,'pageSize',20,
    'total',(select count(*) from mighty_private.visible_support_threads t where p_owner is null or t.owner_id=p_owner),
    'items',coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'answered',r.answered,
      'createdAt',r.created_at,'updatedAt',r.updated_at) || case when p_owner is null then
      jsonb_build_object('email',u.email,'nickname',u.raw_user_meta_data->>'nickname') else '{}'::jsonb end
      order by r.updated_at desc,r.id),'[]'::jsonb)) from recent r left join auth.users u on p_owner is null and u.id=r.owner_id);
end;
$$;

create or replace function mighty_private.support_detail(p_owner uuid,p_thread uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb;
begin
  select jsonb_build_object('id',t.id,'title',t.title,'answered',t.answered,'createdAt',t.created_at,'deleted',first_message.deleted,
    'updatedAt',t.updated_at,'messages',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'deleted',m.deleted,'revision',m.revision,
    'isAdmin',m.is_admin,'body',m.body,'createdAt',m.created_at) order by m.ordinal),'[]'::jsonb)
    from mighty_private.support_messages m where m.thread_id=t.id and (not m.deleted or m.id=t.id))) ||
    case when p_owner is null then jsonb_build_object('email',u.email,'nickname',u.raw_user_meta_data->>'nickname')
    else '{}'::jsonb end into result from mighty_private.visible_support_threads t
    join mighty_private.support_messages first_message on first_message.id=t.id
    left join auth.users u on p_owner is null and t.owner_id=u.id
    where t.id=p_thread and (p_owner is null or t.owner_id=p_owner);
  if result is null then raise exception '문의를 찾을 수 없습니다.' using errcode='P0001'; end if;
  return result;
end;
$$;

-- The existing submission RPCs lock the parent row before adding a reply.
create function mighty_private.reject_closed_community_reply() returns trigger
language plpgsql set search_path='' as $$
begin
  if exists(select 1 from mighty_private.community_posts where id=new.post_id and deleted) then
    raise exception '삭제된 글에는 댓글을 작성할 수 없습니다.' using errcode='22023';
  end if;
  return new;
end;
$$;
create trigger community_check_open before insert on mighty_private.community_comments
  for each row execute function mighty_private.reject_closed_community_reply();
create function mighty_private.reject_closed_support_reply() returns trigger
language plpgsql set search_path='' as $$
begin
  if exists(select 1 from mighty_private.support_messages where id=new.thread_id and deleted) then
    raise exception '삭제된 문의에는 답글을 작성할 수 없습니다.' using errcode='22023';
  end if;
  return new;
end;
$$;
create trigger support_check_open before insert on mighty_private.support_messages for each row
  when (new.id<>new.thread_id) execute function mighty_private.reject_closed_support_reply();

-- Public wrappers derive the actor from the authenticated session. Hold the
-- parent lock through each mutation, including moderation and simultaneous replies.
create function public.mighty_community_change(p_post uuid,p_comment uuid,p_revision integer,p_delete boolean,p_title text,p_body text)
returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); post mighty_private.community_posts; note mighty_private.community_comments;
  heading text:=regexp_replace(coalesce(p_title,''),'^[[:space:]]+|[[:space:]]+$','','g');
  content text:=regexp_replace(coalesce(p_body,''),'^[[:space:]]+|[[:space:]]+$','','g');
begin
  perform mighty_private.require_verified(actor);
  if p_delete is null then raise exception '변경할 작업을 확인해 주세요.' using errcode='22023'; end if;
  select * into post from mighty_private.community_posts where id=p_post for update;
  if not found or (p_comment is null and post.owner_id<>actor) then raise exception '게시글을 찾을 수 없습니다.' using errcode='P0001'; end if;
  if p_comment is not null then
    select * into note from mighty_private.community_comments where id=p_comment and post_id=p_post and owner_id=actor for update;
    if not found then raise exception '댓글을 찾을 수 없습니다.' using errcode='P0001'; end if;
    if note.deleted and p_delete then return true; end if;
    if note.deleted or ((note.hidden or post.hidden) and not p_delete) or note.revision is distinct from p_revision then
      raise exception '댓글이 변경되었습니다. 새로고침해 주세요.' using errcode='P0001';
    end if;
    if not p_delete and length(content) not between 1 and 2000 then raise exception '댓글은 1~2,000자로 입력해 주세요.' using errcode='22023'; end if;
    update mighty_private.community_comments set body=case when p_delete then '삭제된 댓글' else content end,
      hidden=hidden or p_delete,deleted=p_delete,revision=revision+1 where id=note.id;
  else
    if post.deleted and p_delete then return true; end if;
    if post.deleted or (post.hidden and not p_delete) or post.revision is distinct from p_revision then
      raise exception '게시글이 변경되었습니다. 새로고침해 주세요.' using errcode='P0001';
    end if;
    if not p_delete and (length(heading) not between 1 and 100 or length(content) not between 1 and 4000) then
      raise exception '제목은 1~100자, 내용은 1~4,000자로 입력해 주세요.' using errcode='22023';
    end if;
    update mighty_private.community_posts set title=case when p_delete then '삭제된 게시글' else heading end,
      body=case when p_delete then '작성자가 삭제한 글입니다.' else content end,
      nickname=case when p_delete then '삭제됨' else nickname end,deleted=p_delete,revision=revision+1 where id=post.id;
  end if;
  return true;
end;
$$;

create function public.mighty_support_change(p_thread uuid,p_message uuid,p_revision integer,p_delete boolean,p_title text,p_body text)
returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); msg mighty_private.support_messages;
  heading text:=regexp_replace(coalesce(p_title,''),'^[[:space:]]+|[[:space:]]+$','','g');
  content text:=regexp_replace(coalesce(p_body,''),'^[[:space:]]+|[[:space:]]+$','','g');
begin
  perform mighty_private.require_verified(actor);
  if p_delete is null then raise exception '변경할 작업을 확인해 주세요.' using errcode='22023'; end if;
  perform 1 from mighty_private.support_threads where id=p_thread and owner_id=actor for update;
  if not found then raise exception '문의를 찾을 수 없습니다.' using errcode='P0001'; end if;
  select * into msg from mighty_private.support_messages where thread_id=p_thread and id=p_message and not is_admin for update;
  if not found then raise exception '작성한 문의를 찾을 수 없습니다.' using errcode='P0001'; end if;
  if msg.deleted and p_delete then return true; end if;
  if msg.deleted or msg.revision is distinct from p_revision then
    raise exception '문의가 변경되었습니다. 새로고침해 주세요.' using errcode='P0001';
  end if;
  if not p_delete and (length(content) not between 1 and 4000 or (p_message=p_thread and length(heading) not between 1 and 100)) then
    raise exception '제목은 1~100자, 내용은 1~4,000자로 입력해 주세요.' using errcode='22023';
  end if;
  update mighty_private.support_messages set deleted=p_delete,revision=revision+1,
    body=case when p_delete then '작성자가 삭제한 문의입니다.' else content end where id=msg.id;
  update mighty_private.support_threads set updated_at=clock_timestamp(),
    title=case when p_message<>p_thread then title when p_delete then '삭제된 문의' else heading end,
    answered=coalesce((select is_admin from mighty_private.support_messages where thread_id=p_thread and not deleted order by ordinal desc limit 1),false)
    where id=p_thread;
  return true;
end;
$$;

revoke all on function mighty_private.visible_community_posts(boolean),mighty_private.reject_closed_community_reply(),
  mighty_private.reject_closed_support_reply(),public.mighty_community_change(uuid,uuid,integer,boolean,text,text),
  public.mighty_support_change(uuid,uuid,integer,boolean,text,text) from public,anon,authenticated,service_role;
grant execute on function public.mighty_community_change(uuid,uuid,integer,boolean,text,text),
  public.mighty_support_change(uuid,uuid,integer,boolean,text,text) to authenticated;
