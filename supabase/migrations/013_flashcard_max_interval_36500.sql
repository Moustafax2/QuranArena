-- ============================================
-- Move saved FSRS maximum intervals of 365 days to 36500
-- ============================================
-- Older versions defaulted the FSRS maximum interval to 365 days; the default
-- is now 36500 (audit finding N1). The user decided that everyone who saved
-- the old default moves to the new one. Only the exact old default (365) is
-- changed; any other saved value is the user's own choice and is kept. Rows
-- with no saved parameters (fsrs_params null) are not touched.
--
-- Needs migration 011 (it adds user_preferences.fsrs_params). Idempotent: run
-- again, it finds no row left at 365 (only one saved with 365 since then). The
-- app moves the copy saved on each device the same way, once per device.
-- Append-only: earlier migrations are unchanged.

update public.user_preferences
set fsrs_params = jsonb_set(fsrs_params, '{maximum_interval}', '36500'::jsonb)
where jsonb_typeof(fsrs_params) = 'object'
  and fsrs_params -> 'maximum_interval' = '365'::jsonb;
