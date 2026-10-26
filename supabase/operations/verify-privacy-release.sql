-- Read-only post-deployment checks for migrations 009/010 and privacy Cron.
-- Run in the Supabase SQL Editor after deploying the application and functions.

select
  to_regclass('public.privacy_consents') is not null as privacy_consents_exists,
  to_regclass('public.privacy_erasure_ledger') is not null as erasure_ledger_exists,
  to_regclass('public.privacy_deletion_events') is not null as deletion_events_exists,
  to_regprocedure('public.cleanup_privacy_data()') is not null as cleanup_function_exists,
  to_regprocedure('public.purge_qf_user_data(text,text)') is not null as qf_purge_function_exists,
  to_regprocedure('public.reapply_privacy_erasures(jsonb)') is not null as restore_suppression_exists;

select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'players'
  and column_name in ('session_version', 'last_active_at')
order by column_name;

select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'players', 'rooms', 'room_players', 'games', 'game_rounds', 'round_answers',
    'privacy_consents', 'privacy_erasure_ledger', 'privacy_deletion_events'
  )
  and grantee in ('anon', 'authenticated', 'service_role')
order by table_name, grantee, privilege_type;

select jobid, jobname, schedule, active
from cron.job
where jobname in ('quranarena-privacy-cleanup', 'quranarena-cron-history')
order by jobname;

select j.jobname, d.status, d.start_time, d.end_time, d.return_message
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname in ('quranarena-privacy-cleanup', 'quranarena-cron-history')
order by d.start_time desc
limit 20;
