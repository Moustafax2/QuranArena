-- ============================================
-- Close the public API roles out of every app table and function
-- ============================================
-- All app access goes through the service role: the Next server's admin
-- client and the edge functions. Nothing uses the anon key from a browser.
-- Migrations 009 and 010 already closed the privacy and multiplayer tables;
-- this closes the rest (audit finding M13):
--
--   * anon and authenticated lose every privilege on every table and
--     sequence in `public`. Before, players, friends, verse_mistakes,
--     user_flashcards, review_log, user_preferences, memorization_attempts
--     and lexical_entries kept Supabase's default grants.
--   * PUBLIC, anon and authenticated lose execute on every function in
--     `public`, including increment_player_score and increment_player_stats.
--     Functions are executable by PUBLIC by default, which is also how
--     service_role reached some of them, so service_role is granted execute
--     on exactly the functions it could execute before. Functions that
--     earlier migrations closed to service_role (delete_player_data_core,
--     mp_round_lead_in, mp_answer_grace) stay closed.
--   * The legacy auth.uid() row-level-security policies from 001, 002 and
--     007 are dropped. Without grants they could no longer match anything,
--     and service_role bypasses RLS. RLS stays enabled, so a grant added by
--     mistake later still exposes no rows.
--   * Default privileges: tables, sequences and functions that the postgres
--     role creates in `public` later are no longer granted to anon or
--     authenticated, and functions postgres creates (in any schema) are no
--     longer executable by PUBLIC. service_role's own defaults are unchanged,
--     so a later migration's function is still callable by service_role.
--
-- Order: the file name sorts before 013-015. On a fresh database it runs
-- before them, and they revoke their own functions from anon and
-- authenticated. On a database where 013-015 are already applied, it closes
-- their objects too, because it walks the catalog instead of a fixed list.
-- Idempotent: running it again changes nothing. Append-only: earlier
-- migrations are unchanged.
--
-- Not covered here (hosted dashboard, see docs/audit-fix-log.md, Phase A4):
-- turning off Supabase Auth sign-up, and objects created outside migrations
-- by other roles.

begin;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind in ('f', 'p')
      -- Leave functions that belong to an extension to the extension.
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    if has_function_privilege('service_role', fn, 'execute') then
      execute format('grant execute on routine %s to service_role', fn);
    end if;
    execute format('revoke all on routine %s from public, anon, authenticated', fn);
  end loop;
end
$$;

drop policy if exists "players_read" on public.players;
drop policy if exists "players_update" on public.players;
drop policy if exists "players_insert" on public.players;
drop policy if exists "rooms_read" on public.rooms;
drop policy if exists "rooms_insert" on public.rooms;
drop policy if exists "rooms_update" on public.rooms;
drop policy if exists "room_players_read" on public.room_players;
drop policy if exists "room_players_insert" on public.room_players;
drop policy if exists "games_read" on public.games;
drop policy if exists "game_rounds_read" on public.game_rounds;
drop policy if exists "round_answers_read" on public.round_answers;
drop policy if exists "round_answers_insert" on public.round_answers;
drop policy if exists "friends_read" on public.friends;
drop policy if exists "friends_insert" on public.friends;
drop policy if exists "friends_update" on public.friends;
drop policy if exists "verse_mistakes_read" on public.verse_mistakes;
drop policy if exists "verse_mistakes_insert" on public.verse_mistakes;
drop policy if exists "verse_mistakes_update" on public.verse_mistakes;
drop policy if exists "lexical_entries_read" on public.lexical_entries;
drop policy if exists "user_flashcards_read" on public.user_flashcards;
drop policy if exists "user_flashcards_insert" on public.user_flashcards;
drop policy if exists "user_flashcards_update" on public.user_flashcards;
drop policy if exists "user_flashcards_delete" on public.user_flashcards;
drop policy if exists "review_log_read" on public.review_log;
drop policy if exists "review_log_insert" on public.review_log;
drop policy if exists "user_preferences_read" on public.user_preferences;
drop policy if exists "user_preferences_insert" on public.user_preferences;
drop policy if exists "user_preferences_update" on public.user_preferences;
drop policy if exists "memorization_attempts_read" on public.memorization_attempts;
drop policy if exists "memorization_attempts_insert" on public.memorization_attempts;
drop policy if exists "memorization_attempts_update" on public.memorization_attempts;
drop policy if exists "memorization_attempts_delete" on public.memorization_attempts;

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
-- Execute for PUBLIC is a global default, which a per-schema entry cannot
-- remove, so this one applies to functions postgres creates in any schema.
-- Supabase's per-schema defaults (service_role here) are unaffected.
alter default privileges for role postgres revoke execute on functions from public;

commit;

-- PostgREST caches the schema; let it see the new privileges straight away.
notify pgrst, 'reload schema';
