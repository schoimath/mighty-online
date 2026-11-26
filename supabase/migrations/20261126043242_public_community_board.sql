create table mighty_private.community_posts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  nickname text not null,
  title text not null check (length(title) between 1 and 100),
  body text not null check (length(body) between 1 and 4000),
  hidden boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  unique(owner_id,request_id)
);
create index mighty_community_recent on mighty_private.community_posts(created_at desc,id);
create table mighty_private.community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references mighty_private.community_posts(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  nickname text not null,
  body text not null check (length(body) between 1 and 2000),
  hidden boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  unique(owner_id,request_id)
);
create index mighty_community_comments_order on mighty_private.community_comments(post_id,created_at,id);
alter table mighty_private.community_posts enable row level security;
alter table mighty_private.community_comments enable row level security;
revoke all on mighty_private.community_posts,mighty_private.community_comments from public,anon,authenticated,service_role;

create function mighty_private.notify_community_post() returns trigger language plpgsql set search_path='' as $$
declare recipient text;
begin
  for recipient in select distinct u.email from mighty_private.admin_installations a join auth.users u on u.id=a.user_id
    where u.email_confirmed_at is not null and u.deleted_at is null and u.email is not null
  loop
    perform mighty_private.enqueue_mail('support',new.id,recipient,'[마이티 온라인] 자유게시판 새 글',
      '자유게시판에 새 글이 등록됐습니다. 관리자 화면의 자유게시판에서 확인해 주세요.');
  end loop;
  return new;
end;
$$;
create trigger community_post_notify after insert on mighty_private.community_posts for each row execute function mighty_private.notify_community_post();

create function mighty_private.community_nickname(p_user uuid) returns text language sql stable set search_path='' as $$
  select case when nick='' or nick like '%@%' or nick ~* '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
    then '플레이어' else left(nick,16) end
  from (select trim(coalesce(raw_user_meta_data->>'nickname','')) as nick from auth.users where id=p_user) s;
$$;
create function mighty_private.community_list(p_admin boolean,p_page integer) returns jsonb
language plpgsql stable set search_path='' as $$
begin
  if p_page is null or p_page<1 then raise exception '페이지 번호를 확인해 주세요.' using errcode='22023'; end if;
  return (with page_rows as (select p.id,p.nickname,p.title,p.created_at as "createdAt",p.hidden,
      (select count(*) from mighty_private.community_comments c where c.post_id=p.id and (p_admin or not c.hidden)) as "commentCount"
      from mighty_private.community_posts p where p_admin or not p.hidden
      order by p.created_at desc,p.id limit 20 offset (p_page::bigint-1)*20)
    select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(r) order by r."createdAt" desc,r.id),'[]'::jsonb),
      'page',p_page,'pageSize',20,'total',(select count(*) from mighty_private.community_posts where p_admin or not hidden))
    from page_rows r);
end;
$$;
create function mighty_private.community_thread(p_admin boolean,p_post uuid,p_page integer) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb;
begin
  if p_page is null or p_page<1 then raise exception '페이지 번호를 확인해 주세요.' using errcode='22023'; end if;
  select jsonb_build_object('id',p.id,'title',p.title,'body',p.body,'nickname',p.nickname,'createdAt',p.created_at,'hidden',p.hidden,
    'comments',(select coalesce(jsonb_agg(to_jsonb(r) order by r."createdAt",r.id),'[]'::jsonb) from (
        select c.id,c.body,c.nickname,c.created_at as "createdAt",c.hidden from mighty_private.community_comments c
        where c.post_id=p.id and (p_admin or not c.hidden) order by c.created_at,c.id limit 20 offset (p_page::bigint-1)*20
      ) r),'total',(select count(*) from mighty_private.community_comments c where c.post_id=p.id and (p_admin or not c.hidden)),
    'page',p_page,'pageSize',20) into result from mighty_private.community_posts p
    where p.id=p_post and (p_admin or not p.hidden);
  if result is null then raise exception '게시글을 찾을 수 없습니다.' using errcode='P0001'; end if;
  return result;
end;
$$;

create function public.mighty_community_list(p_page integer default 1) returns jsonb
language sql stable security definer set search_path='' as $$select mighty_private.community_list(false,p_page)$$;
create function public.mighty_community_thread(p_post uuid,p_page integer default 1) returns jsonb
language sql stable security definer set search_path='' as $$select mighty_private.community_thread(false,p_post,p_page)$$;
create function public.mighty_community_create(p_request uuid,p_title text,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); found_id uuid;
  heading text:=regexp_replace(coalesce(p_title,''),'^[[:space:]]+|[[:space:]]+$','','g');
  content text:=regexp_replace(coalesce(p_body,''),'^[[:space:]]+|[[:space:]]+$','','g');
begin
  perform mighty_private.require_verified(actor);
  if p_request is null or length(heading) not between 1 and 100 or length(content) not between 1 and 4000 then
    raise exception '제목은 1~100자, 내용은 1~4,000자로 입력해 주세요.' using errcode='22023';
  end if;
  insert into mighty_private.community_posts(owner_id,request_id,nickname,title,body)
    values(actor,p_request,mighty_private.community_nickname(actor),heading,content)
    on conflict(owner_id,request_id) do nothing returning id into found_id;
  if found_id is null then
    select id into found_id from mighty_private.community_posts where owner_id=actor and request_id=p_request and title=heading and body=content;
    if found_id is null then raise exception '이미 처리된 요청입니다. 목록을 확인해 주세요.' using errcode='P0001'; end if;
  end if;
  return mighty_private.community_thread(false,found_id,1);
end;
$$;
create function public.mighty_community_comment(p_post uuid,p_request uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); new_page integer; existing mighty_private.community_comments;
  content text:=regexp_replace(coalesce(p_body,''),'^[[:space:]]+|[[:space:]]+$','','g');
begin
  perform mighty_private.require_verified(actor);
  if p_request is null or length(content) not between 1 and 2000 then
    raise exception '댓글은 1~2,000자로 입력해 주세요.' using errcode='22023';
  end if;
  perform 1 from mighty_private.community_posts where id=p_post and not hidden for update;
  if not found then raise exception '게시글을 찾을 수 없습니다.' using errcode='P0001'; end if;
  insert into mighty_private.community_comments(post_id,owner_id,request_id,nickname,body)
    values(p_post,actor,p_request,mighty_private.community_nickname(actor),content)
    on conflict(owner_id,request_id) do nothing;
  select * into existing from mighty_private.community_comments where owner_id=actor and request_id=p_request
    and post_id=p_post and body=content and not hidden;
  if not found then raise exception '이미 처리된 요청입니다. 게시글을 확인해 주세요.' using errcode='P0001'; end if;
  select (count(*)/20+1)::integer into new_page from mighty_private.community_comments
    where post_id=p_post and not hidden and (created_at,id)<(existing.created_at,existing.id);
  return mighty_private.community_thread(false,p_post,new_page);
end;
$$;
create function public.mighty_admin_community_list(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin perform mighty_private.check_admin(); return mighty_private.community_list(true,p_page); end;
$$;
create function public.mighty_admin_community_thread(p_post uuid,p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin perform mighty_private.check_admin(); return mighty_private.community_thread(true,p_post,p_page); end;
$$;
create function public.mighty_admin_community_visibility(p_post uuid,p_hidden boolean,p_comment uuid default null) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform mighty_private.check_admin();
  if p_hidden is null then raise exception '공개 여부를 선택해 주세요.' using errcode='22023'; end if;
  if p_comment is null then update mighty_private.community_posts set hidden=p_hidden where id=p_post;
  else update mighty_private.community_comments set hidden=p_hidden where post_id=p_post and id=p_comment; end if;
  if not found then raise exception '글 또는 댓글을 찾을 수 없습니다.' using errcode='P0001'; end if;
  return true;
end;
$$;

revoke all on function mighty_private.notify_community_post(),mighty_private.community_nickname(uuid),
  mighty_private.community_list(boolean,integer),mighty_private.community_thread(boolean,uuid,integer),
  public.mighty_community_list(integer),public.mighty_community_thread(uuid,integer),
  public.mighty_community_create(uuid,text,text),public.mighty_community_comment(uuid,uuid,text),
  public.mighty_admin_community_list(integer),public.mighty_admin_community_thread(uuid,integer),
  public.mighty_admin_community_visibility(uuid,boolean,uuid) from public,anon,authenticated,service_role;
grant execute on function public.mighty_community_list(integer),public.mighty_community_thread(uuid,integer) to anon,authenticated;
grant execute on function public.mighty_community_create(uuid,text,text),public.mighty_community_comment(uuid,uuid,text),
  public.mighty_admin_community_list(integer),public.mighty_admin_community_thread(uuid,integer),
  public.mighty_admin_community_visibility(uuid,boolean,uuid) to authenticated;
