-- ============================================
-- Default daily review limit: 200
-- ============================================
-- The user decided (flashcard verification B2) that the default "Reviews per
-- day" matches Anki's commonly cited default of 200, up from 100. This only
-- changes the column default for rows created from now on. Rows already in
-- user_preferences hold a value the user saved, and are not touched.
-- The app's own default (DEFAULT_PREFERENCES) changes with it.
--
-- Idempotent. Append-only: earlier migrations are unchanged.

alter table public.user_preferences
  alter column daily_review_cards_limit set default 200;
