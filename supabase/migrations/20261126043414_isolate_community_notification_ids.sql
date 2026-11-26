-- A public post ID can be copied into a support client's request. Keep the
-- delivery key private so that copying the post ID never suppresses an email.
create or replace function mighty_private.notify_community_post() returns trigger language plpgsql set search_path='' as $$
declare recipient text; delivery_source uuid := gen_random_uuid();
begin
  for recipient in select distinct u.email from mighty_private.admin_installations a join auth.users u on u.id=a.user_id
    where u.email_confirmed_at is not null and u.deleted_at is null and u.email is not null
  loop
    perform mighty_private.enqueue_mail('support',delivery_source,recipient,'[마이티 온라인] 자유게시판 새 글',
      '자유게시판에 새 글이 등록됐습니다. 관리자 화면의 자유게시판에서 확인해 주세요.');
  end loop;
  return new;
end;
$$;
