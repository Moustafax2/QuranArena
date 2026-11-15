-- ============================================
-- Flashcard scheduler state and preferences on the server
-- ============================================
-- Before this migration the SM-2 ("Classic") card states, the algorithm
-- choice and the FSRS parameters lived only in the browser's localStorage, so
-- they did not sync between devices and were lost whenever local storage was
-- cleared (audit findings N6, H3, L21). Append-only: earlier migrations are
-- unchanged.

-- SM-2 state per card. Null means the card has never been studied in Classic
-- mode. Shape (written by the app):
--   { phase: 'learning'|'review'|'relearning', step: int, interval: number,
--     repetitions: int, easiness: number, lapses: int, due: timestamptz-string,
--     last_review?: timestamptz-string }
-- Rows written by older app versions may lack phase/step/lapses; the app
-- treats such a state as a review card.
alter table public.user_flashcards
  add column if not exists sm2_state jsonb;

alter table public.user_preferences
  add column if not exists algorithm text not null default 'fsrs'
    check (algorithm in ('fsrs', 'sm2')),
  -- Null means "use the app defaults".
  add column if not exists fsrs_params jsonb,
  -- Off by default: new cards count against the daily review limit.
  add column if not exists new_cards_ignore_review_limit boolean not null default false;
