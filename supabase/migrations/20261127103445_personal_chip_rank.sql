create or replace function public.chip_wallet() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
begin
  perform mighty_private.require_verified(actor);
  perform mighty_private.recover(actor);
  return (
    select jsonb_build_object('balance', w.balance, 'recoveryDate', w.recover_on,
      'rank', standings.rank, 'tied', standings.tied)
    from mighty_private.wallets w
    left join lateral (
      select 1 + count(*) filter (where p.balance > w.balance) as rank,
        count(*) filter (where p.balance = w.balance) > 1 as tied
      from mighty_private.chip_rank_profiles p
      where p.balance >= w.balance
      having bool_or(p.user_id = w.user_id)
    ) standings on true
    where w.user_id = actor
  );
end;
$$;
