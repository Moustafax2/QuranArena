/**
 * Queue, limit and order verification (plan §3.4; rows A1, A2, B1, B2, B9,
 * C1-C6, D1q-D4q).
 */

import assert from "node:assert/strict";
import type { ReviewLogEntry, SM2Card, UserFlashcard } from "@/lib/types/flashcard";
import { FSRSState, WordStatus } from "@/lib/types/flashcard";
import {
  LEARN_AHEAD_MS, arrangeNext, buildSessionQueue, countTodayActivity, getDayStart, getNextDayStart,
  getQueueKind, getTodaysQueues, type Algorithm,
} from "@/lib/flashcard/queue";
import { createNewCard } from "@/lib/fsrs/scheduler";
import { Rng, SEEDS, intlOffsetMinutes, newBrowser, ok, withBrowser, withTimeZone } from "./helpers";

const HEAVY = process.env.FLASHCARD_VERIFY_HEAVY === "1";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A1: the 4am study day in every zone, for every day of 2026 and 2027. */
function scanZone(tz: string): number {
  return withTimeZone(tz, () => {
    // TZ really is in effect: the process offset equals Intl's for this zone.
    const probe = new Date(Date.UTC(2026, 6, 1, 12));
    // (`+ 0` turns the -0 of UTC+0 zones into 0 for the strict comparison.)
    assert.equal(-probe.getTimezoneOffset() + 0, intlOffsetMinutes(tz, probe) + 0, `TZ=${tz} was not applied`);
    let days = 0;
    let previous: Date | null = null;
    for (let t = new Date(2026, 0, 1, 12); t.getFullYear() < 2028; t.setDate(t.getDate() + 1)) {
      const start = getDayStart(t);
      const next = getNextDayStart(t);
      const where = `${tz} ${t.toString()}`;
      assert.ok(start.getTime() <= t.getTime() && t.getTime() < next.getTime(), `outside its day: ${where}`);
      assert.equal(start.getDate(), t.getDate(), `day start on another date: ${where}`);
      // 04:00 local, or the first time after it where 04:00 doesn't exist.
      if (start.getHours() !== 4 || start.getMinutes() !== 0) {
        const fourAm = new Date(t);
        fourAm.setHours(4, 0, 0, 0);
        assert.ok(fourAm.getHours() !== 4 || fourAm.getMinutes() !== 0, `day start ${start.toString()} although 04:00 exists: ${where}`);
      }
      const length = next.getTime() - start.getTime();
      assert.ok(length >= 22 * HOUR && length <= 26 * HOUR, `day of ${length / HOUR}h: ${where}`);
      // No gap and no overlap with the previous day.
      if (previous) assert.equal(start.getTime(), previous.getTime(), `gap or overlap before ${where}`);
      assert.equal(getDayStart(new Date(next.getTime() - 1)).getTime(), start.getTime(), `last ms of the day: ${where}`);
      assert.equal(getDayStart(next).getTime(), next.getTime(), `next day start: ${where}`);
      previous = next;
      days++;
    }
    return days;
  });
}

function fsrsCard(id: string, state: FSRSState, due: Date, extra: Partial<UserFlashcard> = {}): UserFlashcard {
  return {
    id, word_id: `w-${id}`, status: WordStatus.IN_BANK, created_at: new Date(2026, 0, 1),
    fsrs_state: { ...createNewCard(), due, state, reps: state === FSRSState.New ? 0 : 3, stability: 5, scheduled_days: 3 },
    ...extra,
  };
}

function due(card: UserFlashcard, algorithm: Algorithm): number {
  return new Date(algorithm === "sm2" ? card.sm2_state?.due ?? card.created_at : card.fsrs_state.due).getTime();
}

/** A random deck with every queue kind, Known words and both algorithms' states. */
function randomDeck(rng: Rng, now: Date, size: number): UserFlashcard[] {
  const cards: UserFlashcard[] = [];
  for (let i = 0; i < size; i++) {
    const kind = rng.weighted([30, 10, 45, 15]);
    const state = [FSRSState.New, FSRSState.Learning, FSRSState.Review, FSRSState.Relearning][kind];
    const offset =
      state === FSRSState.Learning || state === FSRSState.Relearning
        ? rng.int(-120, 120) * MIN
        : rng.int(-10, 10) * DAY + rng.int(-12, 12) * HOUR;
    const sm2: SM2Card | null = rng.chance(0.3)
      ? null
      : {
          phase: rng.pick(["learning", "review", "relearning", undefined] as const),
          step: 0, interval: rng.int(1, 30), repetitions: 2, easiness: 2.5, lapses: 0,
          due: new Date(now.getTime() + rng.int(-5, 5) * DAY + rng.int(-180, 180) * MIN),
        };
    cards.push(
      fsrsCard(`c${String(i).padStart(4, "0")}`, state, new Date(now.getTime() + offset), {
        status: rng.chance(0.1) ? WordStatus.KNOWN_NOT_IN_BANK : WordStatus.IN_BANK,
        sm2_state: sm2,
      })
    );
  }
  return cards;
}

/** arrangeNext written again from the rules (B1, B2), for comparison. */
function arrangeNextReference(queue: UserFlashcard[], index: number, algorithm: Algorithm, now: Date): UserFlashcard[] {
  const done = queue.slice(0, index);
  const pending = queue.slice(index);
  const learning = pending
    .map((card, i) => ({ card, i }))
    .filter(({ card }) => getQueueKind(card, algorithm) === "learning")
    .sort((a, b) => due(a.card, algorithm) - due(b.card, algorithm) || a.i - b.i);
  let pickIndex = -1;
  if (learning.length && due(learning[0].card, algorithm) <= now.getTime()) pickIndex = learning[0].i;
  else {
    pickIndex = pending.findIndex((card) => getQueueKind(card, algorithm) !== "learning");
    if (pickIndex === -1 && learning.length && due(learning[0].card, algorithm) <= now.getTime() + 20 * MIN) pickIndex = learning[0].i;
  }
  if (pickIndex === -1) return done;
  return [...done, pending[pickIndex], ...pending.filter((_, i) => i !== pickIndex)];
}

export async function runQueueVerificationTests() {
  // A1.
  const zones = HEAVY
    ? Intl.supportedValuesOf("timeZone")
    : ["America/New_York", "America/Toronto", "Europe/London", "Pacific/Auckland", "Australia/Lord_Howe", "Asia/Dubai", "Asia/Kolkata", "America/Santiago", "Asia/Tehran", "Pacific/Chatham"];
  let zoneDays = 0;
  for (const tz of zones) zoneDays += scanZone(tz);
  ok(`B2-A1: in ${zones.length} zones, every day of 2026-2027 (${zoneDays} days) starts at 04:00 local (or the first time after it), with no gap or overlap`);
  assert.equal(LEARN_AHEAD_MS, 20 * MIN);

  // Queue properties.
  const rng = new Rng(SEEDS.queue);
  const decks = HEAVY ? 3000 : 300;
  let checked = 0;
  for (let d = 0; d < decks; d++) {
    const tz = rng.pick(["America/New_York", "Europe/London", "Asia/Dubai", "Australia/Lord_Howe"]);
    withTimeZone(tz, () => {
      const now = new Date(Date.UTC(2026, 0, 1) + rng.int(0, 700) * DAY + rng.int(0, 1439) * MIN);
      const algorithm: Algorithm = rng.chance(0.5) ? "fsrs" : "sm2";
      const deck = randomDeck(rng, now, rng.int(0, HEAVY ? 800 : 250));
      const limits = { newLimit: rng.int(0, 50), reviewLimit: rng.int(0, 200), newCardsIgnoreReviewLimit: rng.chance(0.5) };
      const today = { newStudied: rng.int(0, 30), reviewsDone: rng.int(0, 120) };
      const queues = getTodaysQueues(deck, algorithm, limits, today, now);
      const where = `seed 0x${SEEDS.queue.toString(16)} deck ${d} ${algorithm} ${JSON.stringify(limits)} ${JSON.stringify(today)} ${now.toString()}`;
      const study = deck.filter((c) => c.status !== WordStatus.KNOWN_NOT_IN_BANK);
      const kind = (c: UserFlashcard) => getQueueKind(c, algorithm);
      const dayEnd = getNextDayStart(now).getTime();

      // (a) C5 / B9: every learning card due within the learn-ahead limit, uncapped, by due date.
      const wantLearning = study.filter((c) => kind(c) === "learning" && due(c, algorithm) <= now.getTime() + LEARN_AHEAD_MS);
      assert.deepEqual(queues.learning.map((c) => c.id).sort(), wantLearning.map((c) => c.id).sort(), `(a) ${where}`);
      for (let i = 1; i < queues.learning.length; i++) assert.ok(due(queues.learning[i - 1], algorithm) <= due(queues.learning[i], algorithm), `(a) order ${where}`);
      // (b) A2 / C4 / D2q: reviews due before the next 4am, the earliest first, within the room left.
      const countsNew = !limits.newCardsIgnoreReviewLimit;
      const reviewRoom = Math.max(0, limits.reviewLimit - today.reviewsDone - (countsNew ? today.newStudied : 0));
      const dueReviews = study.filter((c) => kind(c) === "review" && due(c, algorithm) < dayEnd);
      assert.equal(queues.reviews.length, Math.min(reviewRoom, dueReviews.length), `(b) count ${where}`);
      for (const c of queues.reviews) assert.ok(due(c, algorithm) < dayEnd, `(b) not due today ${where}`);
      for (let i = 1; i < queues.reviews.length; i++) assert.ok(due(queues.reviews[i - 1], algorithm) <= due(queues.reviews[i], algorithm), `(b) order ${where}`);
      if (queues.reviews.length) {
        const latest = due(queues.reviews[queues.reviews.length - 1], algorithm);
        for (const c of dueReviews) if (!queues.reviews.includes(c)) assert.ok(due(c, algorithm) >= latest, `(b) a sooner card left out ${where}`);
      }
      // A review card due later today is served today, one due at the next 4am is not.
      // (c) C1 / C3 / D3q: new cards in deck order, within the new-card room and, unless ignored, the review room.
      const newCards = study.filter((c) => kind(c) === "new");
      const newRoom = Math.max(0, limits.newLimit - today.newStudied);
      const wantNew = Math.min(newCards.length, newRoom, countsNew ? Math.max(0, reviewRoom - queues.reviews.length) : Infinity);
      assert.deepEqual(queues.newCards.map((c) => c.id), newCards.slice(0, wantNew).map((c) => c.id), `(c) ${where}`);
      if (countsNew) assert.ok(queues.newCards.length + queues.reviews.length <= reviewRoom, `(c) C3 ${where}`);
      // (d) D4q: no Known word anywhere.
      for (const c of [...queues.learning, ...queues.reviews, ...queues.newCards]) assert.notEqual(c.status, WordStatus.KNOWN_NOT_IN_BANK, `(d) ${where}`);

      // (e) C6 / D1q: learning first, new cards spread evenly, capped at the session size.
      const size = rng.int(5, 50);
      const session = buildSessionQueue(queues, size);
      const full = buildSessionQueue(queues, Number.MAX_SAFE_INTEGER);
      assert.deepEqual(session, full.slice(0, size), `(e) the session is the start of the day queue ${where}`);
      assert.equal(full.length, queues.learning.length + queues.reviews.length + queues.newCards.length, `(e) lost a card ${where}`);
      assert.deepEqual(full.slice(0, queues.learning.length), queues.learning, `(e) learning first ${where}`);
      const mixed = full.slice(queues.learning.length);
      const R = queues.reviews.length;
      const N = queues.newCards.length;
      let reviewsSeen = 0;
      let k = 0;
      for (const c of mixed) {
        if (kind(c) === "new") {
          k++;
          const ideal = (k * R) / (N + 1);
          assert.ok(Math.abs(reviewsSeen - ideal) <= 1, `(e) D1q new card ${k} after ${reviewsSeen} reviews, ideal ${ideal.toFixed(2)}: ${where}`);
        } else reviewsSeen++;
      }

      // (f) B1 / B2: arrangeNext against the reference, at random positions and times.
      for (let probe = 0; probe < 3; probe++) {
        const queue = [...session, ...queues.learning.slice(0, 3)];
        const index = rng.int(0, queue.length);
        const at = new Date(now.getTime() + rng.int(-30, 60) * MIN);
        assert.deepEqual(
          arrangeNext(queue, index, algorithm, at).map((c) => c.id),
          arrangeNextReference(queue, index, algorithm, at).map((c) => c.id),
          `(f) ${where} index ${index} at ${at.toISOString()}`
        );
      }

      // (g) C1 / C4: countTodayActivity counts distinct cards since the rollover.
      const start = getDayStart(now).getTime();
      const log: ReviewLogEntry[] = [];
      for (let i = 0; i < rng.int(0, 60); i++) {
        const card = rng.pick(deck.length ? deck : [fsrsCard("x", FSRSState.New, now)]);
        const stateBefore = rng.pick([FSRSState.New, FSRSState.Learning, FSRSState.Review, FSRSState.Relearning]);
        const timestamp = new Date(start + rng.int(-6 * 60, 20 * 60) * MIN);
        log.push({ id: `l${i}`, card_id: card.id, word_id: card.word_id, rating: 3, timestamp, session_id: "s", state_before: stateBefore, state_after: FSRSState.Review });
      }
      const counts = countTodayActivity(log, now);
      const since = log.filter((r) => r.timestamp.getTime() >= start);
      assert.equal(counts.newStudied, new Set(since.filter((r) => r.state_before === FSRSState.New).map((r) => r.card_id)).size, `(g) ${where}`);
      assert.equal(counts.reviewsDone, new Set(since.filter((r) => r.state_before === FSRSState.Review).map((r) => r.card_id)).size, `(g) ${where}`);
      checked++;
    });
  }
  ok(`B2-A2/B1/B2/C1-C6/D1q/D2q/D4q: ${checked} random decks: queues, limits, the even new-card spread, the session cap and arrangeNext follow the rules [seed 0x${SEEDS.queue.toString(16)}]`);

  // A2 edges: a review card due at 03:59 the next morning is today's; one due at 04:00 is tomorrow's.
  withTimeZone("America/New_York", () => {
    const now = new Date(2026, 9, 27, 12);
    const cards = [
      fsrsCard("before4", FSRSState.Review, new Date(2026, 9, 28, 3, 59)),
      fsrsCard("at4", FSRSState.Review, new Date(2026, 9, 28, 4, 0)),
    ];
    const queues = getTodaysQueues(cards, "fsrs", { newLimit: 20, reviewLimit: 200 }, { newStudied: 0, reviewsDone: 0 }, now);
    assert.deepEqual(queues.reviews.map((c) => c.id), ["before4"]);
    // B9: a learning card left overnight is first in the next morning's queue and uses no limit.
    const overnight = fsrsCard("overnight", FSRSState.Learning, new Date(2026, 9, 27, 23, 0));
    const morning = getTodaysQueues([overnight, ...cards], "fsrs", { newLimit: 0, reviewLimit: 0 }, { newStudied: 0, reviewsDone: 0 }, new Date(2026, 9, 28, 7));
    assert.deepEqual(morning.learning.map((c) => c.id), ["overnight"]);
    assert.equal(buildSessionQueue(morning, 20)[0].id, "overnight");
  });
  ok("B2-A2/B9: due by the study day (03:59 is today, 04:00 tomorrow); a learning card left overnight comes first next morning, outside every limit");

  // D3q (guest): an intake batch keeps its order through guest storage.
  await withBrowser(newBrowser(false), async () => {
    const storage = await import("@/lib/storage/flashcard-storage-supabase");
    const now = new Date(2026, 9, 27, 12);
    const batch = Array.from({ length: 30 }, (_, i) => fsrsCard(`zz${30 - i}`, FSRSState.New, now, { word_id: `word-${i}`, created_at: now }));
    await storage.addFlashcards(batch);
    const queues = getTodaysQueues(await storage.getFlashcards(), "fsrs", { newLimit: 50, reviewLimit: 200 }, { newStudied: 0, reviewsDone: 0 }, now);
    assert.deepEqual(queues.newCards.map((c) => c.word_id), batch.map((c) => c.word_id));
  });
  ok("B2-D3q: a guest's intake batch is introduced in intake order (signed in: B2-D5)");
}
