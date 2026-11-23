import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { loadPGlite, sqlStatements } from "./optional-pglite";
import type { FSRSCard, ReviewLogEntry, UserFlashcard } from "@/lib/types/flashcard";
import { DEFAULT_FSRS_PARAMETERS, DEFAULT_PREFERENCES, FSRSState, Rating, WordStatus } from "@/lib/types/flashcard";
import { scheduleReviewWithParams } from "@/lib/fsrs/scheduler";
import { getDayStart } from "./queue";
import { formatInterval, previewIntervals } from "./intervals";
import { computeDeckStats } from "./stats";

// Regression tests for the defects found by the flashcard verification
// (docs/flashcard-verification-plan.md §5, D1–D6). Each was seen failing
// before its fix.

function runCase(name: string, fn: () => void) {
  fn();
  console.log(`ok - ${name}`);
}

function withTimeZone(tz: string, fn: () => void) {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** The study day (4am rollover) of `date`, as a whole-day number. */
function studyDay(date: Date): number {
  const start = getDayStart(date);
  return Math.round(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()) / DAY);
}

function reviewState(lastReview: Date, due: Date, stability: number): FSRSCard {
  return {
    due, stability, difficulty: 5, elapsed_days: 0, scheduled_days: Math.round(stability),
    learning_steps: 0, reps: 6, lapses: 0, state: FSRSState.Review, last_review: lastReview,
  };
}

export function runB2DefectTests() {
  runCase("B2-D1: an FSRS review interval of N days lands N study days later across DST changes", () => {
    // Local wall-clock times [year, month (0-based), day, hour, minute], read
    // in the zone under test.
    const cases: Array<[string, number[][]]> = [
      // DST ends 1 Nov 2026 and starts 14 Mar 2027 in New York.
      ["America/New_York", [[2026, 9, 31, 4, 30], [2026, 9, 31, 4, 0], [2027, 2, 13, 3, 30], [2027, 2, 13, 4, 15]]],
      ["Europe/London", [[2026, 9, 24, 4, 30], [2027, 2, 27, 3, 30]]],
      // A 30-minute shift.
      ["Australia/Lord_Howe", [[2026, 9, 3, 4, 10], [2026, 9, 3, 3, 50], [2027, 3, 3, 4, 10]]],
    ];
    for (const [tz, times] of cases) {
      withTimeZone(tz, () => {
        for (const [y, mo, d, h, mi] of times) {
          const answeredAt = new Date(y, mo, d, h, mi);
          for (const stability of [1, 2, 7, 40]) {
            const card = reviewState(new Date(answeredAt.getTime() - stability * DAY), answeredAt, stability);
            for (const enable_fuzz of [false, true]) {
              const params = { ...DEFAULT_FSRS_PARAMETERS, enable_fuzz };
              for (const rating of [Rating.Hard, Rating.Good, Rating.Easy]) {
                const next = scheduleReviewWithParams(card, rating, params, answeredAt, "card-d1").card;
                assert.equal(
                  studyDay(next.due) - studyDay(answeredAt), next.scheduled_days,
                  `${tz} answered ${answeredAt.toString()} rating ${rating}: due ${next.due.toString()} for ${next.scheduled_days} days`
                );
              }
            }
          }
        }
      });
    }
  });

  runCase("B2-D7: a one-day interval shortened or lengthened by DST is labelled 1d, not 23h or 24h", () => {
    const HOUR = 60 * 60 * 1000;
    assert.equal(formatInterval(23 * HOUR), "1d");
    assert.equal(formatInterval(23.5 * HOUR), "1d"); // Lord Howe's 30-minute shift
    assert.equal(formatInterval(25 * HOUR), "1d");
    assert.equal(formatInterval(3 * HOUR), "3h");
    assert.equal(formatInterval(47 * HOUR), "2d");
    withTimeZone("America/New_York", () => {
      // The day before DST starts (14 Mar 2027) is followed by a 23-hour day.
      const now = new Date(2027, 2, 13, 10, 0);
      const card: UserFlashcard = {
        id: "c", word_id: "w", status: WordStatus.IN_BANK, created_at: now,
        fsrs_state: reviewState(new Date(now.getTime() - DAY), now, 1),
        sm2_state: { phase: "learning", step: 1, interval: 0, repetitions: 0, easiness: 2.5, lapses: 0, due: now },
      };
      const preview = previewIntervals(card, "sm2", DEFAULT_FSRS_PARAMETERS, now);
      assert.equal(formatInterval(preview[Rating.Good]), "1d", "Got it on the last learning step graduates to 1 day");
    });
  });

  runCase("B2-D3: a card is mature when its interval is 21 days or more, in FSRS as in Classic", () => {
    const now = new Date(2026, 9, 27, 12);
    const fsrsCard = (id: string, stability: number, interval: number): UserFlashcard => ({
      id, word_id: `w-${id}`, status: WordStatus.IN_BANK, created_at: now,
      fsrs_state: { ...reviewState(new Date(now.getTime() - interval * DAY), now, stability), scheduled_days: interval },
    });
    const cards = [
      fsrsCard("stable-but-short", 30, 10), // high retention setting: long stability, short interval
      fsrsCard("long-interval", 15, 25), // low retention setting: interval past the stability
      fsrsCard("exactly-21", 18, 21),
      fsrsCard("young", 5, 6),
    ];
    assert.equal(computeDeckStats(cards, [], { dailyNewLimit: 20, algorithm: "fsrs" }, now).matureCards, 2);
  });

  runCase("B2-D4: retention counts each review card's first answer of the study day; Hard is a pass", () => {
    const now = new Date(2026, 9, 28, 12);
    const answer = (cardId: string, stateBefore: FSRSState, rating: Rating, at: Date): ReviewLogEntry => ({
      id: `${cardId}-${at.getTime()}`, card_id: cardId, word_id: `w-${cardId}`, rating, timestamp: at,
      session_id: "s", state_before: stateBefore, state_after: FSRSState.Review,
    });
    const reviews = [
      // Day 1 (27 Oct): card a passes first, then is answered again the same day.
      answer("a", FSRSState.Review, Rating.Good, new Date(2026, 9, 27, 10)),
      answer("a", FSRSState.Review, Rating.Again, new Date(2026, 9, 27, 11)),
      // 3am on 28 Oct still belongs to the 27 Oct study day.
      answer("a", FSRSState.Review, Rating.Again, new Date(2026, 9, 28, 3)),
      answer("a", FSRSState.Relearning, Rating.Good, new Date(2026, 9, 27, 11, 10)),
      // Learning steps of a new card are not reviews of a learned card.
      answer("b", FSRSState.New, Rating.Again, new Date(2026, 9, 27, 10)),
      answer("b", FSRSState.Learning, Rating.Good, new Date(2026, 9, 27, 10, 1)),
      answer("c", FSRSState.Review, Rating.Hard, new Date(2026, 9, 27, 10)),
      answer("d", FSRSState.Review, Rating.Again, new Date(2026, 9, 27, 10)),
      // Day 2 (28 Oct): card a's first answer counts again.
      answer("a", FSRSState.Review, Rating.Again, new Date(2026, 9, 28, 9)),
    ];
    // Counted: a pass (day 1), c pass, d fail, a fail (day 2).
    assert.equal(computeDeckStats([], reviews, { dailyNewLimit: 20, algorithm: "fsrs" }, now).retentionRate, 50);
    assert.equal(computeDeckStats([], [], { dailyNewLimit: 20, algorithm: "fsrs" }, now).retentionRate, 0);
  });

  runCase("B2-D6: the hub's rating help matches the schedule for new and learning words", () => {
    const hub = readFileSync("src/app/train/flashcards/page.tsx", "utf8");
    // Got it on a new or learning word is minutes away (10m, or 1 day on
    // graduation), not "a few days"; Forgot on a review card relearns in 10
    // minutes, which may be after this session ends.
    assert.doesNotMatch(hub, /you&apos;ll see it in a few days/);
    assert.doesNotMatch(hub, /you&apos;ll see it again soon in this session/);
    const help = hub.slice(hub.indexOf(">Forgot<"), hub.indexOf(">Easy<") + 400);
    assert.match(help, /minutes/, "the help should say learning steps are minutes apart");
  });

  runCase("B2-D8: FSRS never schedules past the longest gap the user set", () => {
    withTimeZone("America/Toronto", () => {
      const now = new Date(2026, 5, 1, 12);
      // ts-fsrs keeps Good and Easy a day apart even when Hard is already at
      // the maximum, which pushed them to max + 1 and max + 2.
      for (const maximum_interval of [7, 30, 365]) {
        const card = reviewState(new Date(now.getTime() - maximum_interval * DAY), now, maximum_interval * 4);
        for (const enable_fuzz of [false, true]) {
          const params = { ...DEFAULT_FSRS_PARAMETERS, maximum_interval, enable_fuzz };
          const days = [Rating.Hard, Rating.Good, Rating.Easy].map((r) => {
            const next = scheduleReviewWithParams(card, r, params, now, "d8").card;
            assert.equal(studyDay(next.due) - studyDay(now), next.scheduled_days, "due must match scheduled_days");
            return next.scheduled_days;
          });
          // Fuzz may move an interval below the cap, never above it.
          if (enable_fuzz) assert.ok(days.every((d) => d <= maximum_interval), `max ${maximum_interval}, fuzz on: ${days}`);
          else assert.deepEqual(days, [maximum_interval, maximum_interval, maximum_interval], `max ${maximum_interval}, fuzz off`);
          const preview = previewIntervals({ id: "d8", word_id: "w", status: WordStatus.IN_BANK, created_at: now, fsrs_state: card }, "fsrs", params, now);
          assert.ok(preview[Rating.Easy] <= maximum_interval * DAY + 60 * 60 * 1000, "the Easy button shows more than the maximum");
        }
      }
    });
  });
}

export async function runB2DefectAsyncTests() {
  // B2-D5: the server returns cards ordered by created_at, then id
  // (api/flashcards/cards GET). Cards from one intake batch must keep the
  // intake order under that sort, so new words are introduced in the order
  // they were added.
  const posted: Array<{ id: string; word_id: string; created_at: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/flashcards/cards" && init?.method === "POST") posted.push(...JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const { addWordsToBank } = await import("./intake-manager");
    const words = Array.from({ length: 30 }, (_, i) => `word-${String(i).padStart(2, "0")}`);
    await addWordsToBank(words, WordStatus.IN_BANK);
    assert.equal(posted.length, 30);
    const serverOrder = [...posted].sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    assert.deepEqual(serverOrder.map((c) => c.word_id), words, "the server order differs from the intake order");
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log("ok - B2-D5: a signed-in intake batch comes back from the server in intake order");

  // User decision (B2 checkpoint): the default daily review limit is 200, as
  // in Anki. Values users already saved are kept.
  assert.equal(DEFAULT_PREFERENCES.daily_review_cards_limit, 200);
  const dir = "supabase/migrations";
  const files = readdirSync(dir).filter((f) => f.startsWith("016_"));
  assert.equal(files.length, 1, "expected one new migration numbered 016");
  // The migration changes only the column default; it updates no row.
  assert.equal(
    sqlStatements(readFileSync(`${dir}/${files[0]}`, "utf8")),
    "alter table public.user_preferences alter column daily_review_cards_limit set default 200;"
  );
  const PGlite = await loadPGlite();
  if (!PGlite) {
    console.log("ok - B2 review limit: the default is 200 in the code, and 016 only changes the column default (SQL text checked; PGlite is not installed, so it was not executed)");
  } else {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
  `);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && f < "016").sort()) {
    await db.exec(readFileSync(`${dir}/${file}`, "utf8"));
  }
  const saved = "00000000-0000-4000-8000-000000000001";
  const fresh = "00000000-0000-4000-8000-000000000002";
  await db.query("insert into players (id, display_name) values ($1, 'Saved'), ($2, 'Fresh')", [saved, fresh]);
  await db.query("insert into user_preferences (user_id, daily_review_cards_limit) values ($1, 100)", [saved]);
  await db.exec(readFileSync(`${dir}/${files[0]}`, "utf8"));
  await db.exec(readFileSync(`${dir}/${files[0]}`, "utf8")); // idempotent
  await db.query("insert into user_preferences (user_id) values ($1)", [fresh]);
  const { rows } = await db.query<{ user_id: string; daily_review_cards_limit: number }>(
    "select user_id, daily_review_cards_limit from user_preferences order by user_id"
  );
  assert.deepEqual(rows.map((r) => r.daily_review_cards_limit), [100, 200], "a saved limit changed, or the default isn't 200");
  await db.close();
  console.log("ok - B2 review limit: the default is 200 in the code and the database; saved limits are kept");
  }

  // B2-D9 (found in the browser run, S1): the hub runs the sign-in upload on
  // load, and two runs at once (React's development double effect, or two
  // tabs) each kept the same damaged card, so the hub reported two.
  {
    const good = { id: "good-1", word_id: "w-good", status: "IN_BANK", created_at: "2026-10-27T10:00:00.000Z", fsrs_state: { due: "2026-10-27T10:00:00.000Z", state: 0 } };
    const damaged = { id: "damaged-1", word_id: "w-damaged", status: "IN_BANK", created_at: "2026-10-27T10:00:00.000Z", fsrs_state: { due: "not-a-date", state: 2 } };
    const store = new Map<string, string>([["qalamspace_flashcards", JSON.stringify([good, damaged])]]);
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json(init?.method ? { ok: true } : []);
    }) as typeof fetch;
    try {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      await Promise.all([storage.migrateFromLocalStorage(), storage.migrateFromLocalStorage()]);
      assert.equal(storage.getUnsyncedFlashcardCount(), 1, "the damaged card was kept twice");
      await storage.migrateFromLocalStorage();
      assert.equal(storage.getUnsyncedFlashcardCount(), 1);
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
    console.log("ok - B2-D9: a damaged local card is kept once on this device, even when two sign-in uploads run at once");
  }
}
