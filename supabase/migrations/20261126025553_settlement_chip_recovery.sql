create or replace function public.chips_update_hand(p_hand uuid,p_revision integer,p_state jsonb,p_deltas jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  hand_row mighty_private.hands;
  deltas integer[];
  new_balance bigint;
  entry record;
begin
  select * into strict hand_row from mighty_private.hands where id=p_hand for update;
  if hand_row.settled or p_revision is distinct from hand_row.revision then
    return mighty_private.hand_json(hand_row) || jsonb_build_object('applied',false);
  end if;
  if jsonb_typeof(p_state) is distinct from 'object' or
     (p_state->>'manifest') is distinct from hand_row.manifest then raise exception '잘못된 판 상태입니다.'; end if;
  if p_deltas is not null then
    if jsonb_typeof(p_deltas) <> 'array' or jsonb_array_length(p_deltas)<>5 or
       exists(select 1 from jsonb_array_elements(p_deltas) d where jsonb_typeof(d) <> 'number'
                or d::text !~ '^-?[0-9]+$') then raise exception '다섯 자리의 점수를 확인해 주세요.'; end if;
    deltas := array(select value::integer from jsonb_array_elements_text(p_deltas) with ordinality d(value,position)
                    order by position);
    if (select sum(delta) from unnest(deltas) delta) <> 0 then raise exception '정산의 합계가 맞지 않습니다.'; end if;
    for entry in select uid,deltas[position::integer] delta from unnest(hand_row.seats) with ordinality s(uid,position)
                  where uid is not null order by uid
    loop
      -- An administrator can now change the wallet while its hand is open.
      -- Book an overdue Seoul-day recovery before charging this settlement.
      perform 1 from mighty_private.wallets where user_id=entry.uid for update;
      perform mighty_private.recover(entry.uid);
      update mighty_private.wallets set balance=balance+entry.delta,active_hand=null,
        recover_on=case when balance+entry.delta<=0 then coalesce(recover_on,(now() at time zone 'Asia/Seoul')::date+1) end
        where user_id=entry.uid and active_hand=p_hand returning balance into strict new_balance;
      insert into mighty_private.chip_entries(user_id,kind,hand_id,delta,balance_after)
        values(entry.uid,'settlement',p_hand,entry.delta,new_balance);
    end loop;
  end if;
  update mighty_private.hands set state=p_state,revision=revision+1,settled=p_deltas is not null,
    due_at=case when p_deltas is null then
      coalesce(to_timestamp((p_state->>'dueAt')::double precision/1000),now()+interval '1 minute') end
    where id=p_hand returning * into hand_row;
  return mighty_private.hand_json(hand_row) || jsonb_build_object('applied',true);
end;
$$;
