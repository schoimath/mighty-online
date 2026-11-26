alter table mighty_private.chip_entries
  add column admin_actor_id uuid,
  add column admin_request_id uuid,
  add column admin_reason text,
  drop constraint chip_entries_kind_check,
  add constraint chip_entries_kind_check
    check (kind in ('welcome','recovery','settlement','admin_adjustment')),
  add constraint mighty_adjustment_details check (
    (kind = 'admin_adjustment' and admin_actor_id is not null and admin_request_id is not null
      and admin_reason is not null and char_length(admin_reason) between 1 and 200 and delta <> 0)
    or (kind <> 'admin_adjustment' and admin_actor_id is null and admin_request_id is null and admin_reason is null)
  );
-- Keep the actor UUID as an audit value even if the login account is later deleted.
create unique index mighty_one_admin_request on mighty_private.chip_entries(admin_request_id)
  where admin_request_id is not null;

create function public.mighty_admin_adjust(p_user_id uuid, p_delta integer, p_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  reason text;
  receipt mighty_private.chip_entries;
  new_balance bigint;
begin
  perform mighty_private.check_admin();
  reason := btrim(p_reason, E' \t\n\r\f' || chr(11) ||
    U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  if p_user_id is null or p_request_id is null or p_delta is null or p_delta=0 or p_delta < -2147483647
      or reason is null or char_length(reason) not between 1 and 200 then
    raise exception '회원, 칩 수량과 변경 사유를 확인해 주세요.' using errcode='22023';
  end if;

  -- Serialize the same request even if two submissions specify different wallets.
  perform pg_advisory_xact_lock(hashtextextended('mighty-admin-adjust-' || p_request_id::text, 0));
  select * into receipt from mighty_private.chip_entries where admin_request_id=p_request_id;
  if found then
    if (receipt.user_id, receipt.admin_actor_id, receipt.delta, receipt.admin_reason)
       is distinct from (p_user_id, actor, p_delta::bigint, reason) then
      raise exception '같은 요청 번호가 다른 칩 변경에 사용되었습니다.' using errcode='23505';
    end if;
    return jsonb_build_object('entryId',receipt.id,'balanceAfter',receipt.balance_after);
  end if;

  perform 1 from auth.users where id=p_user_id and email_confirmed_at is not null
    and coalesce(email,'') <> '' and deleted_at is null for share;
  if not found then raise exception '인증된 회원을 찾을 수 없습니다.' using errcode='P0002'; end if;
  perform 1 from mighty_private.wallets where user_id=p_user_id for update;
  if not found then raise exception '회원의 칩 지갑을 찾을 수 없습니다.' using errcode='P0002'; end if;

  -- A due recovery is booked first. Settlement and other adjustments share
  -- the same wallet row lock and keep the hand owner and active hand intact.
  perform mighty_private.recover(p_user_id);
  update mighty_private.wallets set balance=balance+p_delta,
    recover_on=case when balance+p_delta <= 0
      then coalesce(recover_on,(now() at time zone 'Asia/Seoul')::date+1) end
    where user_id=p_user_id returning balance into new_balance;
  if new_balance not between -9007199254740991 and 9007199254740991 then
    raise exception '게임에서 표시할 수 있는 잔액 범위를 넘었습니다.' using errcode='22003';
  end if;

  insert into mighty_private.chip_entries(user_id,kind,delta,balance_after,admin_actor_id,admin_reason,admin_request_id)
    values(p_user_id,'admin_adjustment',p_delta,new_balance,actor,reason,p_request_id)
    returning * into receipt;
  return jsonb_build_object('entryId',receipt.id,'balanceAfter',receipt.balance_after);
end;
$$;
revoke all on function public.mighty_admin_adjust(uuid,integer,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.mighty_admin_adjust(uuid,integer,text,uuid) to authenticated;

create or replace function public.mighty_admin_ledger(p_page integer default 1,p_user_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare skip_rows bigint := mighty_private.admin_page_offset(p_page);
begin
  return (with page_rows as (
    select e.id,e.user_id as "userId",u.email,u.raw_user_meta_data->>'nickname' as nickname,
      e.kind,e.delta,e.balance_after as "balanceAfter",e.booked_at as at,h.room,
      case e.kind when 'welcome' then '이메일 인증 가입 지급' when 'recovery' then '다음 날 잔액 복구'
                  when 'settlement' then '대국 점수 정산' when 'admin_adjustment' then e.admin_reason end as reason
    from mighty_private.chip_entries e left join auth.users u on u.id=e.user_id
    left join mighty_private.hands h on h.id=e.hand_id
    where p_user_id is null or e.user_id=p_user_id order by e.id desc limit 20 offset skip_rows)
  select jsonb_build_object('page',p_page,'pageSize',20,
    'total',(select count(*) from mighty_private.chip_entries where p_user_id is null or user_id=p_user_id),
    'items',coalesce((select jsonb_agg(to_jsonb(p) order by p.id desc) from page_rows p),'[]'::jsonb)));
end;
$$;
