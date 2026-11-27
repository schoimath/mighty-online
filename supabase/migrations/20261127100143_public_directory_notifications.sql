-- Browsers read the authoritative, sanitized RPC after this public signal.
-- No table row, room ID, nickname or hand data goes into the broadcast.
create function mighty_private.notify_public_directory() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'hands' then
    -- A hand only appears in the list while playing or settling, and only
    -- while its own room still occupies the public slot.
    if not exists (
      select 1 from mighty_private.directory_slots d
      join mighty_private.chat_hand_links k on k.room_id = d.room_id
      where d.slot = right(new.room, 1)::int and k.hand_id = new.id and k.host_id = new.host_id
        and (d.summary->>'phase' = 'playing' or d.expires_at is null or d.expires_at <= statement_timestamp())
    ) then return null; end if;
  end if;

  begin
    perform realtime.send('{}'::jsonb, 'changed', 'mighty-public-directory', false);
  exception when others then
    -- Periodic directory reads still work when Realtime is unavailable.
    raise log 'Could not broadcast public directory change (%)', sqlstate;
  end;
  return null;
end;
$$;
revoke all on function mighty_private.notify_public_directory() from public, anon, authenticated, service_role;

-- Occupancy, seats, phase and counts are written together. Heartbeats only
-- extend an active lease and do not change the directory seen by a browser.
create trigger mighty_directory_change after update on mighty_private.directory_slots
for each row when (
  new.slot between 1 and 4 and (
    old.room_id is distinct from new.room_id or old.summary is distinct from new.summary or
    coalesce(old.expires_at > statement_timestamp(), false) <> coalesce(new.expires_at > statement_timestamp(), false)
  )
) execute function mighty_private.notify_public_directory();

-- A linked hand can finish independently of the last lobby browser. Skip
-- ordinary card moves, including writes that assign settled=false again.
create trigger mighty_directory_hand_start after insert on mighty_private.hands
for each row when (not new.settled and new.room ~ '^PUB00[1-4]$')
execute function mighty_private.notify_public_directory();
create trigger mighty_directory_hand_settlement after update of settled on mighty_private.hands
for each row when (old.settled is distinct from new.settled and new.room ~ '^PUB00[1-4]$')
execute function mighty_private.notify_public_directory();
