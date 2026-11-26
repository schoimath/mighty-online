-- Auth's sign-in SMTP settings are separate. Store the sender credential for
-- support and announcements in Vault; the admin UI only receives a status.
create table mighty_private.mail_sender (
  singleton boolean primary key default true check (singleton),
  version uuid not null default gen_random_uuid(),
  state text not null check (state in ('pending','ready','error')),
  changed_at timestamptz not null default now(),
  checked_at timestamptz
);
create table mighty_private.mail_delivery (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('support','announcement')),
  source_id uuid not null,
  recipient text not null check (length(recipient) between 3 and 254 and recipient !~ '[[:cntrl:]]'),
  subject text not null check (length(subject) between 1 and 250 and subject !~ '[[:cntrl:]]'),
  body text not null,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','uncertain')),
  attempts integer not null default 0,
  due_at timestamptz not null default now(),
  lease uuid, started_at timestamptz, completed_at timestamptz,
  unique(kind,source_id,recipient)
);
alter table mighty_private.mail_sender enable row level security;
alter table mighty_private.mail_delivery enable row level security;
revoke all on mighty_private.mail_sender,mighty_private.mail_delivery from public,anon,authenticated,service_role;
create index mighty_mail_due on mighty_private.mail_delivery(due_at) where status='queued';
create index mighty_mail_inflight on mighty_private.mail_delivery(started_at) where status='sending';

create function mighty_private.enqueue_mail(p_kind text,p_source uuid,p_recipient text,p_subject text,p_body text)
returns void language sql set search_path='' as $$
  insert into mighty_private.mail_delivery(kind,source_id,recipient,subject,body)
  values(p_kind,p_source,lower(btrim(p_recipient)),p_subject,p_body)
  on conflict(kind,source_id,recipient) do nothing;
$$;
create function mighty_private.retry_mail(p_kind text,p_source uuid) returns void language sql set search_path='' as $$
  update mighty_private.mail_delivery set status='queued',attempts=0,due_at=now(),completed_at=null
  where kind=p_kind and source_id=p_source and status='failed';
$$;
revoke all on function mighty_private.enqueue_mail(text,uuid,text,text,text),mighty_private.retry_mail(text,uuid)
from public,anon,authenticated,service_role;

create function mighty_private.notify_support_admin() returns trigger
language plpgsql security definer set search_path='' as $$
declare recipient text;
begin
  for recipient in
    select distinct u.email from mighty_private.admin_installations a join auth.users u on u.id=a.user_id
      where u.email_confirmed_at is not null and u.deleted_at is null and u.email is not null
  loop
    perform mighty_private.enqueue_mail('support',new.message_id,recipient,'[마이티 온라인] 새 문의가 도착했습니다',
      '문의 게시판에 새 글이 등록됐습니다.' || chr(10) || '관리자 컴퓨터에서 로컬 관리자 화면을 열고 ‘문의 게시판’에서 내용을 확인해 주세요.');
  end loop;
  return new;
end;
$$;
revoke all on function mighty_private.notify_support_admin() from public,anon,authenticated,service_role;
create trigger mighty_support_notify after insert on mighty_private.support_mail_outbox
for each row execute function mighty_private.notify_support_admin();

create function public.mighty_admin_mail_settings() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform mighty_private.check_admin();
  return jsonb_build_object('sender','schoi.math@gmail.com',
    'state',coalesce((select state from mighty_private.mail_sender),'missing'),
    'checkedAt',(select checked_at from mighty_private.mail_sender),
    'pending',(select count(*) from mighty_private.mail_delivery where status in ('queued','sending')),
    'attention',(select count(*) from mighty_private.mail_delivery where status in ('failed','uncertain')));
end;
$$;
create function public.mighty_admin_set_mail_password(p_password text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare secret_id uuid; clean text := replace(btrim(p_password),' ','');
begin
  perform mighty_private.check_admin();
  if clean is null or clean !~ '^[A-Za-z]{16}$' then raise exception 'Gmail 앱 비밀번호 16자리를 입력해 주세요.' using errcode='22023'; end if;
  insert into mighty_private.mail_sender(singleton,state) values(true,'pending')
    on conflict(singleton) do update set version=gen_random_uuid(),state='pending',changed_at=now(),checked_at=null;
  select id into secret_id from vault.secrets where name='mighty_mail_gmail_password';
  if secret_id is null then perform vault.create_secret(clean,'mighty_mail_gmail_password');
  else perform vault.update_secret(secret_id,clean); end if;
  return public.mighty_admin_mail_settings();
end;
$$;
revoke all on function public.mighty_admin_mail_settings(),public.mighty_admin_set_mail_password(text)
from public,anon,authenticated,service_role;
grant execute on function public.mighty_admin_mail_settings(),public.mighty_admin_set_mail_password(text) to authenticated;

-- This independent token authenticates the scheduled invocation. It never
-- leaves the database except as an HTTPS header to this project's worker.
select vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text,'mighty_mail_worker_token');
create function public.mighty_mail_worker_context(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare sender mighty_private.mail_sender;
begin
  if p_token is null or not exists(select 1 from vault.decrypted_secrets where name='mighty_mail_worker_token'
    and decrypted_secret=p_token) then raise exception 'Worker authorization required' using errcode='42501'; end if;
  select * into sender from mighty_private.mail_sender;
  if not found or sender.state='error' then return null; end if;
  return jsonb_build_object('version',sender.version,'state',sender.state,'sender','schoi.math@gmail.com',
    'password',(select decrypted_secret from vault.decrypted_secrets where name='mighty_mail_gmail_password'));
end;
$$;
create function public.mighty_mail_sender_checked(p_version uuid,p_ok boolean) returns void
language sql security definer set search_path='' as $$
  update mighty_private.mail_sender set state=case when p_ok then 'ready' else 'error' end,checked_at=now()
  where version=p_version;
$$;
create function public.mighty_mail_take(p_version uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare job mighty_private.mail_delivery;
begin
  update mighty_private.mail_delivery set status='uncertain',lease=null,completed_at=now()
  where status='sending' and started_at<now()-interval '5 minutes';
  if not exists (select 1 from mighty_private.mail_sender where version=p_version and state='ready') then return null; end if;
  with pick as (select id from mighty_private.mail_delivery where status='queued' and due_at<=now()
    order by case when kind='support' then 0 else 1 end,due_at,id limit 1 for update skip locked)
  update mighty_private.mail_delivery d set status='sending',lease=gen_random_uuid(),started_at=now(),attempts=attempts+1
    from pick where d.id=pick.id returning d.* into job;
  if not found then return null; end if;
  return jsonb_build_object('id',job.id,'lease',job.lease,'recipient',job.recipient,'subject',job.subject,'body',job.body);
end;
$$;
create function public.mighty_mail_finish(p_id uuid,p_lease uuid,p_outcome text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_outcome not in ('sent','retry','failed','uncertain','auth_error') or p_outcome is null then raise exception 'Invalid outcome'; end if;
  update mighty_private.mail_delivery set
    status=case when p_outcome='auth_error' or (p_outcome='retry' and attempts<8) then 'queued'
                when p_outcome='retry' then 'failed' else p_outcome end,
    due_at=case when p_outcome='retry' then now()+make_interval(mins=>least(360, power(2,least(attempts,9))::int)) else now() end,
    lease=null,completed_at=case when p_outcome='auth_error' or (p_outcome='retry' and attempts<8) then null else now() end
    where id=p_id and lease=p_lease and status='sending';
end;
$$;
revoke all on function public.mighty_mail_worker_context(text),public.mighty_mail_sender_checked(uuid,boolean),
  public.mighty_mail_take(uuid),public.mighty_mail_finish(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.mighty_mail_worker_context(text),public.mighty_mail_sender_checked(uuid,boolean),
  public.mighty_mail_take(uuid),public.mighty_mail_finish(uuid,uuid,text) to service_role;

select cron.schedule('mighty-outbound-mail','* * * * *',$job$
  select net.http_post(
    url := rtrim((select decrypted_secret from vault.decrypted_secrets where name='mighty_project_url'),'/') || '/functions/v1/member-mail',
    headers := jsonb_build_object('Content-Type','application/json',
      'apikey',(select decrypted_secret from vault.decrypted_secrets where name='mighty_publishable_key'),
      'x-mighty-mail-worker',(select decrypted_secret from vault.decrypted_secrets where name='mighty_mail_worker_token')),
    body := '{}'::jsonb,timeout_milliseconds := 50000)
  where exists(select 1 from mighty_private.mail_sender where state='pending' or
    (state='ready' and exists(select 1 from mighty_private.mail_delivery
      where (status='queued' and due_at<=now()) or (status='sending' and started_at<now()-interval '5 minutes'))));
$job$);
