-- An open hand shows the seated accounts' wallets. A finished hand shows
-- what those accounts held at settlement, even if they play again later.
create or replace function mighty_private.hand_json(h mighty_private.hands) returns jsonb
language sql stable strict security invoker set search_path = '' as $$
  select jsonb_build_object(
    'hand', h.id, 'room', h.room, 'host', h.host_id, 'seats', h.seats,
    'state', h.state, 'revision', h.revision, 'settled', h.settled,
    'seatBalances', (
      select jsonb_agg(case when h.settled then charge.balance_after else wallet.balance end
                       order by seat.position)
      from unnest(h.seats) with ordinality as seat(user_id, position)
      left join mighty_private.wallets wallet on not h.settled and wallet.user_id = seat.user_id
      left join mighty_private.chip_entries charge on h.settled and charge.hand_id = h.id
                                                   and charge.user_id = seat.user_id
    )
  );
$$;
