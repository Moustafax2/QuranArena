/**
 * FSRS verification (plan §3.2; rows F1–F7, E1–E3, A3, A4): our scheduler
 * against ts-fsrs called directly, over seeded random review histories.
 */

import assert from "node:assert/strict";
import {
  Card, FSRS, GenSeedStrategyWithCardId, Grade, State, StrategyMode,
  clipParameters, default_w, fsrs, get_fuzz_range,
} from "ts-fsrs";
import type { FSRSCard, FSRSParameters, Rating, UserFlashcard } from "@/lib/types/flashcard";
import { DEFAULT_FSRS_PARAMETERS, FSRSState, WordStatus } from "@/lib/types/flashcard";
import { createNewCard, scheduleReviewWithParams } from "@/lib/fsrs/scheduler";
import { previewIntervals, scheduleCard } from "@/lib/flashcard/intervals";
import { Rng, SEEDS, addLocalDays, newBrowser, ok, studyDay, withBrowser, withTimeZone } from "./helpers";

const HEAVY = process.env.FLASHCARD_VERIFY_HEAVY === "1";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RATINGS: Rating[] = [1, 2, 3, 4];
const ZONES = ["America/New_York", "America/Toronto", "Europe/London", "Pacific/Auckland", "Australia/Lord_Howe", "UTC", "Asia/Kolkata"];
const FIELDS = ["stability", "difficulty", "elapsed_days", "scheduled_days", "learning_steps", "reps", "lapses", "state"] as const;

/** ts-fsrs called directly, with our parameters and seed strategy. */
function reference(params: FSRSParameters) {
  return fsrs({
    request_retention: params.request_retention,
    maximum_interval: params.maximum_interval,
    enable_fuzz: params.enable_fuzz,
    w: params.w,
  }).useStrategy(StrategyMode.SEED, GenSeedStrategyWithCardId("card_id"));
}

const toTsState = (s: FSRSState) => [State.New, State.Learning, State.Review, State.Relearning][s];

function toTsCard(card: FSRSCard, id: string): Card & { card_id: string } {
  return { ...card, state: toTsState(card.state), last_review: card.last_review, card_id: id } as Card & { card_id: string };
}

/**
 * The card we expect from ts-fsrs's result. Two documented adjustments, both
 * to review cards only: the interval is capped at the maximum (B2-D8), and the
 * due date keeps the answer's wall-clock time N calendar days later (B2-D1).
 * Every other field is ts-fsrs's own.
 */
function expected(ref: Card, now: Date, maximumInterval: number): Card {
  if (ref.state !== State.Review) return ref;
  let card = ref;
  if (card.scheduled_days > maximumInterval) {
    card = { ...card, scheduled_days: maximumInterval, due: new Date(now.getTime() + maximumInterval * DAY) };
  }
  if (card.scheduled_days >= 1 && card.due.getTime() === now.getTime() + card.scheduled_days * DAY) {
    card = { ...card, due: addLocalDays(now, card.scheduled_days) };
  }
  return card;
}

function randomParams(rng: Rng): FSRSParameters {
  const w = rng.chance(0.5)
    ? [...default_w]
    : clipParameters(default_w.map((x) => x * rng.float(0.8, 1.2)), 1, true);
  return {
    request_retention: Number(rng.float(0.7, 0.99).toFixed(2)),
    maximum_interval: rng.chance(0.3) ? 36500 : rng.int(7, 36500),
    enable_fuzz: rng.chance(0.5),
    w,
  };
}

function randomRating(rng: Rng): Rating {
  return ([1, 2, 3, 4] as Rating[])[rng.weighted([15, 10, 60, 15])];
}

/** The gap to the next answer: within a session, hours, days, or overdue. */
function randomGap(rng: Rng, card: FSRSCard, now: Date): number {
  switch (rng.weighted([25, 15, 20, 40])) {
    case 0: return rng.int(0, 20 * 60) * 1000;
    case 1: return rng.int(1 * 60, 12 * 60) * MIN;
    case 2: return rng.int(1, 400) * DAY + rng.int(0, 23 * 60) * MIN;
    default: {
      const untilDue = Math.max(MIN, card.due.getTime() - now.getTime());
      return Math.round(untilDue * rng.float(1, 3));
    }
  }
}

function userCard(id: string, state: FSRSCard): UserFlashcard {
  return { id, word_id: `w-${id}`, status: WordStatus.IN_BANK, created_at: new Date(2026, 0, 1), fsrs_state: state };
}

interface Tally {
  steps: number;
  dueShiftedByDst: number;
  sameDayHardDrops: number;
  e2Differences: number;
  fuzzChecked: number;
  capped: number;
}

/** One random history: every answer is checked against ts-fsrs and the invariants. */
function runHistory(rng: Rng, tally: Tally) {
  const params = randomParams(rng);
  const ref = reference(params);
  const id = rng.uuid();
  let now = new Date(Date.UTC(2026, 0, 1) + rng.int(0, 729) * DAY + rng.int(0, 24 * 60 - 1) * MIN);
  let ours: FSRSCard = { ...createNewCard(), due: now };
  let theirs: Card = toTsCard(ours, id);
  const answers = rng.int(1, 40);
  const where = () => `seed ${SEEDS.fsrs.toString(16)} card ${id} at ${now.toISOString()} TZ ${process.env.TZ} params ${JSON.stringify({ ...params, w: params.w === default_w ? "default" : "scaled" })}`;

  for (let i = 0; i < answers; i++) {
    if (i > 0) now = new Date(now.getTime() + randomGap(rng, ours, now));
    const rating = randomRating(rng);

    // F1: field for field, exactly, against ts-fsrs's own result.
    const next = scheduleReviewWithParams(ours, rating, params, now, id).card;
    const raw = ref.next({ ...theirs, card_id: id } as Card, now, rating as unknown as Grade).card;
    const refNext = expected(raw, now, params.maximum_interval);
    if (raw.scheduled_days !== refNext.scheduled_days) tally.capped++;
    else if (raw.due.getTime() !== refNext.due.getTime()) tally.dueShiftedByDst++;
    for (const field of FIELDS) {
      const want = field === "state" ? [State.New, State.Learning, State.Review, State.Relearning].indexOf(refNext.state) : refNext[field];
      assert.equal(next[field], want, `F1 ${field} differs: ${where()} answer ${i} rating ${rating}`);
    }
    assert.equal(next.last_review?.getTime(), refNext.last_review?.getTime(), `F1 last_review: ${where()}`);
    assert.equal(next.due.getTime(), refNext.due.getTime(), `F1 due: ${where()} answer ${i}`);

    // E1: each button's preview equals the scheduled delta (same moment).
    const card = userCard(id, ours);
    // The answer path (scheduleCard, as reviewCard uses it) must give the
    // same state as the FSRS call above, and the same delta as the preview.
    const preview = previewIntervals(card, "fsrs", params, now);
    const outcomes = RATINGS.map((r) => scheduleCard(card, r, "fsrs", params, now).fsrs_state);
    for (const r of RATINGS) {
      assert.equal(preview[r], outcomes[r - 1].due.getTime() - now.getTime(), `E1 preview ${r}: ${where()}`);
    }
    // F4: the same card, rating and moment always give the same result.
    assert.deepEqual(outcomes[rating - 1], next, `answer path differs: ${where()}`);
    // E2: shown now, answered 40 s later. Equal unless a study day or a UTC
    // date boundary falls in between; those are counted.
    const later = new Date(now.getTime() + 40 * 1000);
    const answered = scheduleCard(card, rating, "fsrs", params, later).fsrs_state.due.getTime() - later.getTime();
    const sameDays = studyDay(now) === studyDay(later) && now.toISOString().slice(0, 10) === later.toISOString().slice(0, 10);
    if (sameDays) assert.equal(answered, preview[rating], `E2: ${where()}`);
    else if (answered !== preview[rating]) tally.e2Differences++;

    // Invariants.
    assert.ok(next.scheduled_days <= params.maximum_interval, `F3: ${next.scheduled_days} > max: ${where()}`);
    assert.ok(next.due.getTime() >= now.getTime(), `due before the answer: ${where()}`);
    assert.ok(Number.isFinite(next.stability) && Number.isFinite(next.difficulty), `NaN state: ${where()}`);
    if (next.state === FSRSState.Review) {
      // A3: N days later is N study days later (B2-D1).
      assert.equal(studyDay(next.due) - studyDay(now), next.scheduled_days, `A3: ${where()} due ${next.due.toString()}`);
    }
    if (ours.state === FSRSState.Review) {
      // E3: each button gives a longer interval, unless capped by the maximum.
      const days = outcomes.map((o) => o.scheduled_days);
      const ms = RATINGS.map((r) => preview[r]);
      assert.ok(ms[0] < ms[1], `E3 Again < Hard: ${where()}`);
      for (let k = 1; k < 3; k++) {
        if (days[k + 1] < params.maximum_interval) assert.ok(days[k] < days[k + 1], `E3 ${days}: ${where()}`);
        else assert.ok(days[k] <= days[k + 1], `E3 ${days}: ${where()}`);
      }
      if (rating >= 2) {
        assert.ok(studyDay(next.due) - studyDay(now) >= 1, `success due today: ${where()}`);
        // ts-fsrs rounds stability to 8 decimals, so an unchanged one can drop by < 1e-8.
        if (next.stability < ours.stability - 1e-8) {
          // Only ts-fsrs's same-day (short-term) formula may lower stability, on Hard.
          assert.ok(rating === 2 && next.elapsed_days === 0, `stability fell on ${rating}: ${where()} before ${JSON.stringify(ours)} after ${JSON.stringify(next)}`);
          tally.sameDayHardDrops++;
        }
      }
      // F4: with fuzz on, Good stays inside ts-fsrs's fuzz range around the
      // unfuzzed interval (when the button order didn't push it up).
      if (params.enable_fuzz && rating === 3) {
        const plain = scheduleReviewWithParams(ours, 3, { ...params, enable_fuzz: false }, now, id).card.scheduled_days;
        const hard = days[1];
        if (plain > hard + 1 && plain < params.maximum_interval) {
          const { min_ivl, max_ivl } = get_fuzz_range(plain, next.elapsed_days, params.maximum_interval);
          assert.ok(next.scheduled_days >= Math.min(min_ivl, hard + 1) && next.scheduled_days <= max_ivl, `F4 ${next.scheduled_days} not in [${min_ivl}, ${max_ivl}] around ${plain}: ${where()}`);
          tally.fuzzChecked++;
        }
      }
    }
    ours = next;
    theirs = refNext;
    tally.steps++;
  }
}

export async function runFsrsVerificationTests() {
  // 5,000 histories take about a minute, so npm test runs 1,000 and the
  // heavy run (FLASHCARD_VERIFY_HEAVY=1) 50,000.
  const histories = HEAVY ? 50000 : 1000;
  const rng = new Rng(SEEDS.fsrs);
  const tally: Tally = { steps: 0, dueShiftedByDst: 0, sameDayHardDrops: 0, e2Differences: 0, fuzzChecked: 0, capped: 0 };
  for (let h = 0; h < histories; h++) {
    withTimeZone(ZONES[h % ZONES.length], () => runHistory(rng, tally));
  }
  ok(`B2-F1/E1/E3/F3/F4/A3: ${histories} seeded FSRS histories (${tally.steps} answers) equal ts-fsrs field for field; previews equal the schedule [seed 0x${SEEDS.fsrs.toString(16)}; due moved by DST ${tally.dueShiftedByDst}; same-day Hard stability drops ${tally.sameDayHardDrops}; E2 boundary differences ${tally.e2Differences}; fuzz ranges checked ${tally.fuzzChecked}; capped at the maximum ${tally.capped}]`);

  // F1 (storage round-trip): the state survives the guest storage path (JSON
  // with the date reviver) and the server path (body shape, then hydration),
  // and the next answer still matches ts-fsrs.
  for (const signedIn of [false, true]) {
    const roundRng = new Rng(SEEDS.fsrs + (signedIn ? 2 : 1));
    const browser = newBrowser(signedIn);
    await withBrowser(browser, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      for (let c = 0; c < (HEAVY ? 200 : 40); c++) {
        const params = randomParams(roundRng);
        const ref = reference(params);
        const id = roundRng.uuid();
        let now = new Date(Date.UTC(2026, 0, 1) + roundRng.int(0, 700) * DAY);
        const first: UserFlashcard = { ...userCard(id, { ...createNewCard(), due: now }), word_id: `rt-${c}` };
        await storage.addFlashcards([first]);
        let theirs: Card = toTsCard(first.fsrs_state, id);
        for (let i = 0; i < 12; i++) {
          const stored = (await storage.getFlashcards()).find((card) => card.id === id)!;
          if (i > 0) now = new Date(now.getTime() + randomGap(roundRng, stored.fsrs_state, now));
          const rating = randomRating(roundRng);
          const next = scheduleReviewWithParams(stored.fsrs_state, rating, params, now, id).card;
          const refNext = expected(ref.next({ ...theirs, card_id: id } as Card, now, rating as unknown as Grade).card, now, params.maximum_interval);
          for (const field of FIELDS) {
            const want = field === "state" ? [State.New, State.Learning, State.Review, State.Relearning].indexOf(refNext.state) : refNext[field];
            assert.equal(next[field], want, `F1 round-trip ${signedIn ? "server" : "guest"} ${field}, card ${id}`);
          }
          assert.equal(next.due.getTime(), refNext.due.getTime());
          await storage.updateFlashcard(id, { fsrs_state: next });
          theirs = refNext;
        }
      }
    });
  }
  ok("B2-F1: FSRS states round-trip through the guest and signed-in storage paths and keep matching ts-fsrs");

  // F2: with fuzz off and the card fixed, a higher retention never gives a longer interval.
  const r2 = new Rng(SEEDS.fsrs + 3);
  for (let c = 0; c < (HEAVY ? 5000 : 500); c++) {
    const now = new Date(Date.UTC(2026, 3, 1) + r2.int(0, 300) * DAY);
    const stability = r2.float(0.5, 400);
    const card: FSRSCard = {
      due: now, stability, difficulty: r2.float(1, 10), elapsed_days: 0, scheduled_days: Math.round(stability),
      learning_steps: 0, reps: r2.int(2, 30), lapses: r2.int(0, 5), state: FSRSState.Review,
      last_review: new Date(now.getTime() - r2.int(1, 400) * DAY),
    };
    let previous = Infinity;
    for (let retention = 0.7; retention <= 0.99 + 1e-9; retention += 0.01) {
      const params = { ...DEFAULT_FSRS_PARAMETERS, enable_fuzz: false, request_retention: Number(retention.toFixed(2)) };
      const days = scheduleReviewWithParams(card, 3, params, now, "f2").card.scheduled_days;
      assert.ok(days <= previous, `F2: retention ${retention.toFixed(2)} gave ${days} > ${previous}`);
      previous = days;
    }
  }
  assert.equal(DEFAULT_FSRS_PARAMETERS.request_retention, 0.9);
  ok("B2-F2: a higher desired retention never lengthens an interval; the default is 90%");

  // F5: our default weights are ts-fsrs's, and a changed weight reaches it.
  assert.deepEqual(DEFAULT_FSRS_PARAMETERS.w, [...default_w]);
  assert.equal(DEFAULT_FSRS_PARAMETERS.w.length, 21);
  {
    const now = new Date(Date.UTC(2026, 5, 1, 12));
    const card: FSRSCard = { ...createNewCard(), due: now };
    const plain = { ...DEFAULT_FSRS_PARAMETERS, enable_fuzz: false };
    const changed = { ...plain, w: plain.w.map((x, i) => (i === 2 ? x * 1.5 : x)) };
    assert.notEqual(
      scheduleReviewWithParams(card, 3, plain, now, "f5").card.stability,
      scheduleReviewWithParams(card, 3, changed, now, "f5").card.stability
    );
  }
  ok("B2-F5: the default weights equal ts-fsrs default_w (21 FSRS-6 weights), and a changed weight changes the result");

  // F6 / B3: the scheduler our wrapper builds uses ts-fsrs's default steps
  // with short-term scheduling on. The wrapper passes only these four options.
  const built = new FSRS({ request_retention: 0.9, maximum_interval: 36500, enable_fuzz: true, w: [...default_w] });
  assert.deepEqual([...built.parameters.learning_steps], ["1m", "10m"]);
  assert.deepEqual([...built.parameters.relearning_steps], ["10m"]);
  assert.equal(built.parameters.enable_short_term, true);
  const { readFileSync } = await import("node:fs");
  const wrapper = readFileSync("src/lib/fsrs/scheduler.ts", "utf8");
  const options = wrapper.match(/const scheduler = new FSRS\(\{([\s\S]*?)\}\);/)![1];
  assert.deepEqual(options.match(/\b[a-z_]+(?=:)/g), ["request_retention", "maximum_interval", "enable_fuzz", "w"]);
  ok("B2-F6/B3: FSRS learning steps are 1m 10m, relearning 10m, short-term on (ts-fsrs defaults, not overridden)");

  // A3 / D1 targeted: every 15 minutes from 00:00 to 06:00 on the day before
  // and the day of each DST change in 2026-2027.
  const transitions: Record<string, Array<[number, number, number]>> = {
    "America/New_York": [[2026, 2, 8], [2026, 10, 1], [2027, 2, 14], [2027, 10, 7]],
    "America/Toronto": [[2026, 2, 8], [2026, 10, 1], [2027, 2, 14], [2027, 10, 7]],
    "Europe/London": [[2026, 2, 29], [2026, 9, 25], [2027, 2, 28], [2027, 9, 31]],
    "Pacific/Auckland": [[2026, 3, 5], [2026, 8, 27], [2027, 3, 4], [2027, 8, 26]],
    "Australia/Lord_Howe": [[2026, 3, 5], [2026, 9, 4], [2027, 3, 4], [2027, 9, 3]],
  };
  let a3 = 0;
  for (const [tz, days] of Object.entries(transitions)) {
    withTimeZone(tz, () => {
      for (const [y, m, d] of days) {
        for (const offset of [-1, 0]) {
          for (let q = 0; q < 24; q++) {
            const now = new Date(y, m, d + offset, 0, q * 15);
            for (const stability of [0.6, 1, 3, 20]) {
              const card: FSRSCard = {
                due: now, stability, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0,
                reps: 5, lapses: 0, state: FSRSState.Review, last_review: new Date(now.getTime() - Math.max(1, Math.round(stability)) * DAY),
              };
              for (const r of [2, 3, 4] as Rating[]) {
                const next = scheduleReviewWithParams(card, r, { ...DEFAULT_FSRS_PARAMETERS, enable_fuzz: false }, now, "a3").card;
                assert.equal(studyDay(next.due) - studyDay(now), next.scheduled_days, `A3 ${tz} ${now.toString()} rating ${r}`);
                a3++;
              }
            }
          }
        }
      }
    });
  }
  ok(`B2-A3: around every DST change of 2026-2027 in 5 zones, an FSRS interval of N days is N study days (${a3} answers)`);

  // A4 / D2 (not fixed, by the user's decision): ts-fsrs counts elapsed days
  // by UTC date. This records the current, documented behaviour.
  withTimeZone("America/Toronto", () => {
    const first = new Date(2026, 5, 10, 21, 0); // 01:00 UTC on 11 June
    const second = new Date(2026, 5, 11, 9, 0); // 13:00 UTC on 11 June
    const card: FSRSCard = {
      due: first, stability: 0.5, difficulty: 5, elapsed_days: 0, scheduled_days: 0, learning_steps: 0,
      reps: 3, lapses: 0, state: FSRSState.Review, last_review: new Date(2026, 5, 9, 21, 0),
    };
    const afterFirst = scheduleReviewWithParams(card, 3, { ...DEFAULT_FSRS_PARAMETERS, enable_fuzz: false }, first, "d2").card;
    const afterSecond = scheduleReviewWithParams(afterFirst, 3, { ...DEFAULT_FSRS_PARAMETERS, enable_fuzz: false }, second, "d2").card;
    assert.equal(studyDay(second) - studyDay(first), 1, "one study day apart");
    assert.equal(afterSecond.elapsed_days, 0, "D2 as documented: ts-fsrs sees the same UTC date, so 0 elapsed days");
  });
  ok("B2-A4/D2 (reported, not fixed): Toronto 21:00 then 09:00 next day is 1 study day but 0 FSRS elapsed days (UTC date), as documented");
}
