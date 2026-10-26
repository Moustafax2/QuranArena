-- Run after enabling Supabase Cron (pg_cron) and applying 009 and 010.
-- See https://supabase.com/docs/guides/cron/quickstart
-- Reusing these names updates the existing schedule instead of duplicating it.
select cron.schedule('quranarena-privacy-cleanup', '*/15 * * * *', 'select public.cleanup_privacy_data()');
select cron.schedule('quranarena-cron-history', '0 0 * * *',
  $$delete from cron.job_run_details where jobid in
    (select jobid from cron.job where jobname in ('quranarena-privacy-cleanup','quranarena-cron-history'))
    and end_time < now() - interval '7 days'$$);
-- Verify active=true and inspect job_run_details for failures after deployment.
select jobid, jobname, schedule, active from cron.job where jobname like 'quranarena-%';
