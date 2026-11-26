-- Hosted Supabase supplies pg_cron, pg_net and Vault. Configure
-- mighty_project_url and mighty_publishable_key in Vault for the clock.
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault with schema vault;

select cron.schedule('mighty-due-hands', '* * * * *', $job$
  with config as (
    select max(decrypted_secret) filter (where name = 'mighty_project_url') as url,
           max(decrypted_secret) filter (where name = 'mighty_publishable_key') as api_key
      from vault.decrypted_secrets
     where name in ('mighty_project_url', 'mighty_publishable_key')
  )
  select net.http_post(
    url := rtrim(config.url, '/') || '/functions/v1/chip-hand',
    headers := jsonb_build_object('Content-Type','application/json','apikey',config.api_key),
    body := jsonb_build_object('op','tick','handId',hand_id),
    timeout_milliseconds := 20000
  )
  from config cross join unnest(public.chips_due_hands(32)) as hand_id
  where config.url is not null and config.api_key is not null;
$job$);

-- Recovery uses the Seoul calendar day inside the ledger routine. Running
-- hourly also catches up automatically if the midnight job was interrupted.
select cron.schedule('mighty-chip-recovery', '0 * * * *', $job$
  select public.chips_recover_due();
$job$);
