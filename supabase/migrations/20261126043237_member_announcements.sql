create table mighty_private.announcements (
  id uuid primary key,
  author_id uuid not null,
  subject text not null check (length(subject) between 1 and 120 and subject !~ '[[:cntrl:]]'),
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);
create index mighty_announcement_author on mighty_private.announcements(author_id,created_at desc,id);
create table mighty_private.announcement_targets (
  announcement_id uuid not null references mighty_private.announcements(id) on delete cascade,
  member_id uuid not null,
  email_digest bytea not null,
  primary key (announcement_id,member_id),
  unique (announcement_id,email_digest)
);
alter table mighty_private.announcements enable row level security;
alter table mighty_private.announcement_targets enable row level security;
revoke all on mighty_private.announcements,mighty_private.announcement_targets from public,anon,authenticated,service_role;

-- Counts reflect provider acceptance, not arrival in a member's inbox.
create function mighty_private.announcement_summary(a mighty_private.announcements) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id',a.id,'subject',a.subject,'createdAt',a.created_at,'submittedAt',a.submitted_at,
    'total',(select count(*) from mighty_private.announcement_targets where announcement_id=a.id),
    'queued',count(*) filter(where d.status='queued'),'sending',count(*) filter(where d.status='sending'),
    'sent',count(*) filter(where d.status='sent'),'failed',count(*) filter(where d.status='failed'),
    'uncertain',count(*) filter(where d.status='uncertain')
  ) from mighty_private.mail_delivery d where d.kind='announcement' and d.source_id=a.id;
$$;
revoke all on function mighty_private.announcement_summary(mighty_private.announcements) from public,anon,authenticated,service_role;

create function public.mighty_admin_mail_preview(p_id uuid,p_subject text,p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  campaign mighty_private.announcements;
  title text := btrim(p_subject);
  contents text := btrim(p_body);
begin
  perform mighty_private.check_admin();
  if p_id is null or title is null or length(title) not between 1 and 120 or title ~ '[[:cntrl:]]'
    or contents is null or length(contents) not between 1 and 4000 or contents !~ '[^[:space:]]' then
    raise exception '메일 제목과 본문을 확인해 주세요.' using errcode='22023';
  end if;
  insert into mighty_private.announcements(id,author_id,subject,body)
    values(p_id,auth.uid(),title,contents) on conflict(id) do nothing returning * into campaign;
  if found then
    -- Freeze the audience at preview time. A changed or deleted address is skipped at send time.
    insert into mighty_private.announcement_targets(announcement_id,member_id,email_digest)
      select distinct on (lower(btrim(u.email))) p_id,u.id,sha256(convert_to(lower(btrim(u.email)),'UTF8'))
      from auth.users u where u.email_confirmed_at is not null and u.deleted_at is null
        and nullif(btrim(u.email),'') is not null order by lower(btrim(u.email)),u.id;
  else
    select * into campaign from mighty_private.announcements where id=p_id and author_id=auth.uid();
    if not found or campaign.subject<>title or campaign.body<>contents then
      raise exception '다른 메일에 사용한 요청 번호입니다.' using errcode='23505';
    end if;
  end if;
  return mighty_private.announcement_summary(campaign) || jsonb_build_object('body',campaign.body);
end;
$$;

create function public.mighty_admin_mail_status(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare campaign mighty_private.announcements;
begin
  perform mighty_private.check_admin();
  select * into strict campaign from mighty_private.announcements where id=p_id and author_id=auth.uid();
  return mighty_private.announcement_summary(campaign) || jsonb_build_object('body',campaign.body);
end;
$$;

create function public.mighty_admin_mail_history(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare offset_rows bigint := mighty_private.admin_page_offset(p_page);
begin
  return (with page as (
    select a.* from mighty_private.announcements a where a.author_id=auth.uid()
      order by a.created_at desc,a.id limit 20 offset offset_rows
  ) select jsonb_build_object('page',p_page,'pageSize',20,
    'total',(select count(*) from mighty_private.announcements where author_id=auth.uid()),
    'items',coalesce((select jsonb_agg(mighty_private.announcement_summary(p::mighty_private.announcements)
      order by p.created_at desc,p.id) from page p),'[]'::jsonb)));
end;
$$;

create function public.mighty_admin_mail_send(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare campaign mighty_private.announcements;
begin
  perform mighty_private.check_admin();
  select * into strict campaign from mighty_private.announcements where id=p_id and author_id=auth.uid() for update;
  if campaign.submitted_at is null then
    perform mighty_private.enqueue_mail('announcement',p_id,lower(btrim(u.email)),campaign.subject,campaign.body)
      from mighty_private.announcement_targets t join auth.users u on u.id=t.member_id
      where t.announcement_id=p_id and u.email_confirmed_at is not null and u.deleted_at is null
        and t.email_digest=sha256(convert_to(lower(btrim(u.email)),'UTF8'));
    update mighty_private.announcements set submitted_at=now() where id=p_id returning * into campaign;
  end if;
  return mighty_private.announcement_summary(campaign) || jsonb_build_object('body',campaign.body);
end;
$$;

create function public.mighty_admin_mail_retry(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare campaign mighty_private.announcements;
begin
  perform mighty_private.check_admin();
  select * into strict campaign from mighty_private.announcements where id=p_id and author_id=auth.uid() for update;
  if campaign.submitted_at is null then raise exception '발송 기록을 확인해 주세요.' using errcode='22023'; end if;
  perform mighty_private.retry_mail('announcement',p_id);
  return mighty_private.announcement_summary(campaign) || jsonb_build_object('body',campaign.body);
end;
$$;
revoke all on function public.mighty_admin_mail_preview(uuid,text,text),public.mighty_admin_mail_status(uuid),
 public.mighty_admin_mail_history(integer),public.mighty_admin_mail_send(uuid),public.mighty_admin_mail_retry(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.mighty_admin_mail_preview(uuid,text,text),public.mighty_admin_mail_status(uuid),
 public.mighty_admin_mail_history(integer),public.mighty_admin_mail_send(uuid),public.mighty_admin_mail_retry(uuid)
 to authenticated;
