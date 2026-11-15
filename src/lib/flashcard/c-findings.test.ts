import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { loadPGlite, sqlStatements } from "./optional-pglite";
import type { ReviewLogEntry, SM2Card, UserFlashcard } from "@/lib/types/flashcard";
import { FSRSState, Rating, WordStatus } from "@/lib/types/flashcard";
import { buildProgressDashboard } from "@/lib/progress/dashboard";
import { computeDeckStats } from "./stats";
import { calculateAccuracy } from "./session-manager";

// Regression tests for the findings the flashcard verification reported
// (docs/flashcard-verification-report.md §8) and the app-wide verification
// fixed (C-N1, C-N3, C-N6). Each was seen failing before its fix.

function runCase(name: string, fn: () => void) {
  fn();
  console.log(`ok - ${name}`);
}

function card(id: string, state: FSRSState, extra: Partial<UserFlashcard> = {}): UserFlashcard {
  return {
    id,
    word_id: `w-${id}`,
    status: WordStatus.IN_BANK,
    created_at: new Date(2026, 0, 1),
    fsrs_state: {
      due: new Date(2026, 9, 30, 12), stability: 30, difficulty: 5, elapsed_days: 0, scheduled_days: 10,
      learning_steps: 0, reps: state === FSRSState.New ? 0 : 3, lapses: 0, state,
    },
    ...extra,
  };
}

function sm2(phase: SM2Card["phase"], interval: number): SM2Card {
  return { phase, step: 0, interval, repetitions: 2, easiness: 2.5, due: new Date(2026, 10, 5) };
}

function answer(cardId: string, at: Date, rating: Rating, stateBefore: FSRSState): ReviewLogEntry {
  return {
    id: `r-${cardId}-${at.getTime()}-${rating}`, card_id: cardId, word_id: `w-${cardId}`, rating, timestamp: at,
    session_id: "s", state_before: stateBefore, state_after: FSRSState.Review,
  };
}

function dashboardFor(cards: UserFlashcard[], reviews: ReviewLogEntry[], algorithm: "fsrs" | "sm2") {
  return buildProgressDashboard({
    isAuthenticated: false, hasPlayer: false, play: null, flashcards: cards, reviews,
    dueCount: 0, newCount: 0, memorizationAttempts: [], algorithm,
  });
}

export function runCFindingTests() {
  runCase("C-N1: the progress page's flashcard summary uses the stats page's definitions", () => {
    const now = new Date(2026, 9, 30, 12);
    const cards = [
      // FSRS: stability 30 but an interval of 10 days, so young (D3).
      card("young-fsrs", FSRSState.Review),
      // Mature by interval in FSRS.
      card("mature-fsrs", FSRSState.Review, { fsrs_state: { ...card("x", FSRSState.Review).fsrs_state, scheduled_days: 25, stability: 12 } }),
      card("young-fsrs-2", FSRSState.Review),
      card("learning-fsrs", FSRSState.Learning),
      // Classic: a mature review card and a learning card whose FSRS state is still New.
      card("mature-sm2", FSRSState.New, { sm2_state: sm2("review", 30) }),
      card("learning-sm2", FSRSState.New, { sm2_state: sm2("learning", 0) }),
      // A Known word is not a study card, on the hub or the stats page.
      card("known", FSRSState.New, { status: WordStatus.KNOWN_NOT_IN_BANK }),
    ];
    const day = (d: number, h: number) => new Date(2026, 9, d, h);
    const reviews = [
      // The first review answer of a study day counts; Hard is a pass (D4).
      answer("young-fsrs", day(28, 10), Rating.Hard, FSRSState.Review),
      // A repeat later the same study day is left out.
      answer("young-fsrs", day(28, 11), Rating.Again, FSRSState.Review),
      answer("mature-fsrs", day(29, 10), Rating.Again, FSRSState.Review),
      // Learning steps are left out.
      answer("learning-fsrs", day(29, 11), Rating.Again, FSRSState.Learning),
    ];
    for (const algorithm of ["fsrs", "sm2"] as const) {
      const studyCards = cards.filter((c) => c.status !== WordStatus.KNOWN_NOT_IN_BANK);
      const expected = computeDeckStats(studyCards, reviews, { dailyNewLimit: 20, algorithm }, now);
      const summary = dashboardFor(cards, reviews, algorithm).flashcards;
      assert.equal(summary.matureCards, expected.matureCards, `${algorithm}: mature cards differ from the stats page`);
      assert.equal(summary.learningCards, expected.learningCards, `${algorithm}: learning cards differ from the stats page`);
      assert.equal(summary.retentionRate, expected.retentionRate / 100, `${algorithm}: retention differs from the stats page`);
      assert.equal(summary.totalCards, studyCards.length, `${algorithm}: Known words counted as cards`);
    }
    assert.equal(dashboardFor(cards, reviews, "fsrs").flashcards.matureCards, 1);
    assert.equal(dashboardFor(cards, reviews, "sm2").flashcards.matureCards, 1);
    assert.equal(dashboardFor(cards, reviews, "sm2").flashcards.learningCards, 1);
    assert.equal(dashboardFor(cards, reviews, "fsrs").flashcards.retentionRate, 0.5);
    // No counted answers: no retention figure, as before.
    assert.equal(dashboardFor(cards, [reviews[3]], "fsrs").flashcards.retentionRate, null);
    // A Hard answer is a success in the progress events too.
    const events = dashboardFor(cards, [reviews[0]], "fsrs").events;
    assert.equal(events[0].success, true, "a Hard answer counted as a failed flashcard attempt");
  });

  runCase("C-N3: session accuracy counts Hard as a pass; only Forgot is a miss", () => {
    const stats = {
      total_cards: 4, cards_reviewed: 4, new_cards: 0, review_cards: 4,
      again_count: 1, hard_count: 1, good_count: 1, easy_count: 1, total_time_ms: 4000,
    };
    assert.equal(calculateAccuracy(stats), 75);
    assert.equal(calculateAccuracy({ ...stats, again_count: 0, hard_count: 4, good_count: 0, easy_count: 0 }), 100);
    assert.equal(calculateAccuracy({ ...stats, cards_reviewed: 0 }), 0);
  });
}

export async function runCFindingAsyncTests() {
  // C-N6: the default of 200 reviews a day was also the slider's maximum, so
  // nobody could raise it. The maximum is now 9999 (Anki's limit fields accept
  // up to 9999), in the settings page and in the database.
  const settings = readFileSync("src/app/train/flashcards/settings/page.tsx", "utf8");
  assert.match(settings, /\["daily_review_cards_limit",\s*"Reviews per day",\s*0,\s*9999\b/, "the Reviews per day maximum is not 9999");

  const dir = "supabase/migrations";
  const files = readdirSync(dir).filter((f) => f.startsWith("017_"));
  assert.equal(files.length, 1, "expected one new migration numbered 017");
  const statements = sqlStatements(readFileSync(`${dir}/${files[0]}`, "utf8"));
  assert.match(statements, /check \(daily_review_cards_limit >= 0 and daily_review_cards_limit <= 9999\);$/, "017 does not end with the 0..9999 check");
  assert.doesNotMatch(statements, /\bupdate\b|set default/i, "017 must not change stored values or the default");
  const PGlite = await loadPGlite();
  if (!PGlite) {
    console.log("ok - C-N6: reviews per day can be raised above the default of 200, up to 9999, in the settings; 017 adds the 0..9999 check (SQL text checked; PGlite is not installed, so it was not executed)");
    return;
  }
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
  `);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && f < "017").sort()) {
    await db.exec(readFileSync(`${dir}/${file}`, "utf8"));
  }
  const saved = "00000000-0000-4000-8000-000000000001";
  const raised = "00000000-0000-4000-8000-000000000002";
  await db.query("insert into players (id, display_name) values ($1, 'Saved'), ($2, 'Raised')", [saved, raised]);
  await db.query("insert into user_preferences (user_id, daily_review_cards_limit) values ($1, 150)", [saved]);
  await db.exec(readFileSync(`${dir}/${files[0]}`, "utf8"));
  await db.exec(readFileSync(`${dir}/${files[0]}`, "utf8")); // idempotent
  await db.query("insert into user_preferences (user_id, daily_review_cards_limit) values ($1, 9999)", [raised]);
  await assert.rejects(db.query("update user_preferences set daily_review_cards_limit = 10000 where user_id = $1", [raised]), /check constraint/);
  await assert.rejects(db.query("update user_preferences set daily_review_cards_limit = -1 where user_id = $1", [raised]), /check constraint/);
  const { rows } = await db.query<{ daily_review_cards_limit: number }>(
    "select daily_review_cards_limit from user_preferences order by user_id"
  );
  assert.deepEqual(rows.map((r) => r.daily_review_cards_limit), [150, 9999], "a saved limit changed, or 9999 was not stored");
  const defaults = await db.query<{ d: string }>(
    "select column_default as d from information_schema.columns where table_name = 'user_preferences' and column_name = 'daily_review_cards_limit'"
  );
  assert.equal(defaults.rows[0].d, "200", "the column default changed");
  await db.close();
  console.log("ok - C-N6: reviews per day can be raised above the default of 200, up to 9999, in the settings and the database");
}
