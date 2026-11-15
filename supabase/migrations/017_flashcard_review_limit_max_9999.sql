-- ============================================
-- Daily review limit: allow up to 9999
-- ============================================
-- The default "Reviews per day" became 200 (016), which was also the settings
-- slider's maximum, so nobody could raise it (flashcard verification N6). The
-- settings now go up to 9999, the largest value Anki's limit fields accept,
-- so the old 0..500 check from 002 is replaced with 0..9999.
-- Stored values (all within 0..500) are unchanged, and so is the default.
--
-- 002 declared the check inline, so Postgres named it
-- user_preferences_daily_review_cards_limit_check. Any other check on this
-- column alone is dropped too, in case a database named it differently.
--
-- Idempotent. Append-only: earlier migrations are unchanged.

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'user_preferences'
      and con.contype = 'c'
      and con.conkey = array[(
        select attnum from pg_attribute
        where attrelid = rel.oid and attname = 'daily_review_cards_limit'
      )]::int2[]
  loop
    execute format('alter table public.user_preferences drop constraint %I', c.conname);
  end loop;
end
$$;

alter table public.user_preferences
  add constraint user_preferences_daily_review_cards_limit_check
  check (daily_review_cards_limit >= 0 and daily_review_cards_limit <= 9999);
