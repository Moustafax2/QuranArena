/**
 * Classic (SM-2 based) verification (plan §3.3; rows B3-B8, G1-G12): a golden
 * table worked out by hand from the publicly described formulas, and a
 * seeded property test.
 */

import assert from "node:assert/strict";
import type { Rating, SM2Card } from "@/lib/types/flashcard";
import { createNewSM2Card, scheduleSM2Review } from "@/lib/sm2/scheduler";
import { formatInterval } from "@/lib/flashcard/intervals";
import { Rng, SEEDS, addLocalDays, ok, studyDay, withTimeZone } from "./helpers";

const HEAVY = process.env.FLASHCARD_VERIFY_HEAVY === "1";
const MIN = 60 * 1000;

interface Expected {
  phase: SM2Card["phase"];
  step?: number;
  interval?: number;
  ease?: number;
  lapses?: number;
  repetitions?: number;
  /** Due offset from the answer: minutes, or calendar days. */
  dueMinutes?: number;
  dueDays?: number;
}

interface GoldenRow {
  id: string;
  before: (t0: Date) => SM2Card;
  answer: Rating;
  options?: { maximumInterval?: number };
  /** When the card is answered, relative to T0 (minutes). */
  atMinutes?: number;
  expected: Expected;
}

const review = (interval: number, ease: number, due: Date, extra: Partial<SM2Card> = {}): SM2Card => ({
  phase: "review", step: 0, interval, repetitions: 3, easiness: ease, lapses: 0, due,
  last_review: addLocalDays(due, -interval), ...extra,
});
const learning = (step: number, due: Date): SM2Card => ({
  phase: "learning", step, interval: 0, repetitions: 0, easiness: 2.5, lapses: 0, due,
});
const relearning = (returnInterval: number, due: Date): SM2Card => ({
  phase: "relearning", step: 0, interval: returnInterval, repetitions: 0, easiness: 2.3, lapses: 1, due,
});

// Expected values come from the formulas (Anki manual, Deck Options and the
// FAQ on the scheduling algorithm), with the defaults: steps 1m 10m,
// graduating 1d, easy 4d, relearning 10m, ease 250%, easy bonus 1.30, hard
// 1.20, new interval 0, minimum 1d. † marks a .5 tie (rounded half up).
const ROWS: GoldenRow[] = [
  { id: "G01", before: (t) => createNewSM2Card(t), answer: 1, expected: { phase: "learning", step: 0, dueMinutes: 1, ease: 2.5 } },
  { id: "G02", before: (t) => createNewSM2Card(t), answer: 2, expected: { phase: "learning", step: 0, dueMinutes: 5.5 } },
  { id: "G03", before: (t) => createNewSM2Card(t), answer: 3, expected: { phase: "learning", step: 1, dueMinutes: 10 } },
  { id: "G04", before: (t) => createNewSM2Card(t), answer: 4, expected: { phase: "review", interval: 4, dueDays: 4, ease: 2.5, repetitions: 1 } },
  { id: "G05", before: (t) => learning(1, t), answer: 1, expected: { phase: "learning", step: 0, dueMinutes: 1 } },
  { id: "G06", before: (t) => learning(1, t), answer: 2, expected: { phase: "learning", step: 1, dueMinutes: 10 } },
  { id: "G07", before: (t) => learning(1, t), answer: 3, expected: { phase: "review", interval: 1, dueDays: 1 } },
  { id: "G08", before: (t) => learning(1, t), answer: 4, expected: { phase: "review", interval: 4, dueDays: 4 } },
  { id: "G09 Hard", before: (t) => review(10, 2.5, t), answer: 2, expected: { phase: "review", interval: 12, dueDays: 12, ease: 2.35 } },
  { id: "G09 Got it", before: (t) => review(10, 2.5, t), answer: 3, expected: { phase: "review", interval: 25, dueDays: 25, ease: 2.5 } },
  { id: "G09† Easy", before: (t) => review(10, 2.5, t), answer: 4, expected: { phase: "review", interval: 33, dueDays: 33, ease: 2.65 } },
  { id: "G10 Hard", before: (t) => review(10, 2.5, addLocalDays(t, -4)), answer: 2, expected: { phase: "review", interval: 12, ease: 2.35 } },
  { id: "G10 Got it", before: (t) => review(10, 2.5, addLocalDays(t, -4)), answer: 3, expected: { phase: "review", interval: 30, ease: 2.5 } },
  { id: "G10† Easy", before: (t) => review(10, 2.5, addLocalDays(t, -4)), answer: 4, expected: { phase: "review", interval: 46, ease: 2.65 } },
  { id: "G11", before: (t) => review(10, 2.5, t), answer: 1, expected: { phase: "relearning", step: 0, dueMinutes: 10, ease: 2.3, lapses: 1, interval: 1, repetitions: 0 } },
  { id: "G12 Forgot", before: (t) => relearning(1, t), answer: 1, expected: { phase: "relearning", step: 0, dueMinutes: 10 } },
  { id: "G12 Hard", before: (t) => relearning(1, t), answer: 2, expected: { phase: "relearning", step: 0, dueMinutes: 15 } },
  { id: "G12 Got it", before: (t) => relearning(1, t), answer: 3, expected: { phase: "review", interval: 1, dueDays: 1 } },
  { id: "G12d Easy", before: (t) => relearning(1, t), answer: 4, expected: { phase: "review", interval: 2, dueDays: 2 } },
  { id: "G13 Hard", before: (t) => review(1, 1.3, t), answer: 2, expected: { phase: "review", interval: 2, ease: 1.3 } },
  { id: "G13 Got it", before: (t) => review(1, 1.3, t), answer: 3, expected: { phase: "review", interval: 3, ease: 1.3 } },
  { id: "G13 Easy", before: (t) => review(1, 1.3, t), answer: 4, expected: { phase: "review", interval: 4, ease: 1.45 } },
  { id: "G14 max 36500", before: (t) => review(100, 2.5, t), answer: 3, expected: { phase: "review", interval: 250 } },
  { id: "G14 max 180", before: (t) => review(100, 2.5, t), answer: 3, options: { maximumInterval: 180 }, expected: { phase: "review", interval: 180, dueDays: 180 } },
  { id: "G15", before: (t) => review(300, 2.5, t), answer: 3, options: { maximumInterval: 365 }, expected: { phase: "review", interval: 365 } },
  { id: "G16", before: (t) => review(5, 1.4, t), answer: 1, expected: { phase: "relearning", ease: 1.3 } },
  { id: "G18 Hard", before: (t) => review(2, 2.5, t), answer: 2, expected: { phase: "review", interval: 3 } },
  { id: "G18 Got it", before: (t) => review(2, 2.5, t), answer: 3, expected: { phase: "review", interval: 5 } },
  { id: "G18† Easy", before: (t) => review(2, 2.5, t), answer: 4, expected: { phase: "review", interval: 7 } },
  // Due at 22:00, answered at 08:00 the same study day: no late credit.
  { id: "G19", before: (t) => review(10, 2.5, new Date(t.getTime() + 12 * 60 * MIN)), answer: 3, atMinutes: -120, expected: { phase: "review", interval: 25 } },
  // A state saved by an older version, with no phase.
  { id: "G20 Got it", before: (t) => ({ interval: 6, repetitions: 2, easiness: 2.36, due: t }) as SM2Card, answer: 3, expected: { phase: "review", interval: 14 } },
  { id: "G20 Hard", before: (t) => ({ interval: 6, repetitions: 2, easiness: 2.36, due: t }) as SM2Card, answer: 2, expected: { phase: "review", interval: 7 } },
];

/** The golden table, as rows of [id, expected, actual] for the report. */
export function classicGoldenTable(): Array<[string, string, string]> {
  return withTimeZone("America/Toronto", () => {
    const t0 = new Date(2026, 2, 2, 10, 0);
    return ROWS.map((row) => {
      const at = new Date(t0.getTime() + (row.atMinutes ?? 0) * MIN);
      const after = scheduleSM2Review(row.before(t0), row.answer, at, row.options);
      const e = row.expected;
      const describe = (c: Expected) => [
        c.phase, c.step !== undefined ? `step ${c.step}` : "", c.interval !== undefined ? `interval ${c.interval}` : "",
        c.ease !== undefined ? `ease ${c.ease.toFixed(2)}` : "", c.lapses !== undefined ? `lapses ${c.lapses}` : "",
        c.repetitions !== undefined ? `reps ${c.repetitions}` : "", c.dueMinutes !== undefined ? `+${c.dueMinutes}m` : "",
        c.dueDays !== undefined ? `+${c.dueDays}d` : "",
      ].filter(Boolean).join(", ");
      const dueMs = after.due.getTime() - at.getTime();
      const actual: Expected = {
        phase: after.phase,
        step: e.step !== undefined ? after.step : undefined,
        interval: e.interval !== undefined ? after.interval : undefined,
        ease: e.ease !== undefined ? Math.round(after.easiness * 1000) / 1000 : undefined,
        lapses: e.lapses !== undefined ? after.lapses : undefined,
        repetitions: e.repetitions !== undefined ? after.repetitions : undefined,
        dueMinutes: e.dueMinutes !== undefined ? dueMs / MIN : undefined,
        dueDays: e.dueDays !== undefined ? studyDay(after.due) - studyDay(at) : undefined,
      };
      return [row.id, describe(e), describe(actual)];
    });
  });
}

export function runClassicVerificationTests() {
  withTimeZone("America/Toronto", () => {
    const t0 = new Date(2026, 2, 2, 10, 0);
    for (const row of ROWS) {
      const at = new Date(t0.getTime() + (row.atMinutes ?? 0) * MIN);
      const after = scheduleSM2Review(row.before(t0), row.answer, at, row.options);
      const e = row.expected;
      const tag = `${row.id}: ${JSON.stringify(after)}`;
      assert.equal(after.phase, e.phase, tag);
      if (e.step !== undefined) assert.equal(after.step, e.step, tag);
      if (e.interval !== undefined) assert.equal(after.interval, e.interval, tag);
      if (e.ease !== undefined) assert.ok(Math.abs(after.easiness - e.ease) < 1e-9, tag);
      if (e.lapses !== undefined) assert.equal(after.lapses, e.lapses, tag);
      if (e.repetitions !== undefined) assert.equal(after.repetitions, e.repetitions, tag);
      if (e.dueMinutes !== undefined) assert.equal(after.due.getTime() - at.getTime(), e.dueMinutes * MIN, tag);
      if (e.dueDays !== undefined) assert.equal(after.due.getTime(), addLocalDays(at, e.dueDays).getTime(), tag);
    }
    // G02 / B4: the Hard button on a new card reads "6m".
    assert.equal(formatInterval(5.5 * MIN), "6m");
    // G17: Hard, Hard, Easy, Forgot, each on time.
    let card = review(10, 2.5, t0);
    const eases: number[] = [];
    for (const r of [2, 2, 4, 1] as Rating[]) {
      card = scheduleSM2Review(card, r, card.due);
      eases.push(Math.round(card.easiness * 100) / 100);
    }
    assert.deepEqual(eases, [2.35, 2.2, 2.35, 2.15]);
  });
  ok(`B2-G01..G20: the Classic golden table (${ROWS.length} rows + G17) matches the hand-worked values`);

  // Property test.
  const rng = new Rng(SEEDS.classic);
  const sequences = HEAVY ? 50000 : 2000;
  let answers = 0;
  const zones = ["America/Toronto", "America/New_York", "Europe/London", "Australia/Lord_Howe", "Asia/Kolkata"];
  for (let s = 0; s < sequences; s++) {
    withTimeZone(zones[s % zones.length], () => {
      const max = rng.chance(0.3) ? rng.int(7, 400) : 36500;
      let now = new Date(Date.UTC(2026, 0, 1) + rng.int(0, 700) * 86400000 + rng.int(0, 1439) * MIN);
      let card: SM2Card | null = null;
      let easePermille = 2500;
      let lapses = 0;
      const length = rng.int(1, 60);
      for (let i = 0; i < length; i++) {
        if (card) {
          const untilDue = Math.max(MIN, card.due.getTime() - now.getTime());
          const gap = [rng.int(0, 20) * MIN, untilDue, Math.round(untilDue * rng.float(1, 3)), rng.int(1, 30) * 86400000][rng.weighted([20, 40, 25, 15])];
          now = new Date(now.getTime() + gap);
        }
        const rating = ([1, 2, 3, 4] as Rating[])[rng.weighted([15, 10, 60, 15])];
        const before: SM2Card = card ?? createNewSM2Card(now);
        const phase = before.phase ?? "review";
        const where = `seed 0x${SEEDS.classic.toString(16)} sequence ${s} answer ${i} ${JSON.stringify(before)} rating ${rating} at ${now.toString()}`;
        if (phase === "review") {
          // E3 / G10: each button at least a day longer, all within the maximum.
          const next = [2, 3, 4].map((r) => scheduleSM2Review(before, r as Rating, now, { maximumInterval: max }).interval);
          const cur = Math.max(1, before.interval);
          for (let k = 0; k < 3; k++) assert.ok(next[k] <= max, `above the maximum: ${where}`);
          if (next[2] < max) {
            assert.ok(next[0] >= cur + 1 && next[1] >= next[0] + 1 && next[2] >= next[1] + 1, `E3 ${next}: ${where}`);
          }
          if (rating === 1) { easePermille = Math.max(1300, easePermille - 200); lapses++; }
          if (rating === 2) easePermille = Math.max(1300, easePermille - 150);
          if (rating === 4) easePermille += 150;
        }
        const after: SM2Card = scheduleSM2Review(before, rating, now, { maximumInterval: max });
        assert.ok(after.easiness >= 1.3 - 1e-12, `G6 ease below 130%: ${where}`);
        assert.ok(Math.abs(after.easiness - easePermille / 1000) < 1e-9, `G6 ease ${after.easiness} != ${easePermille / 1000}: ${where}`);
        assert.equal(after.lapses, lapses, `G5 lapses: ${where}`);
        assert.ok(after.due.getTime() > now.getTime(), `due not after the answer: ${where}`);
        if (after.phase === "review") {
          assert.ok(after.interval >= 1 && after.interval <= max, `G10: ${where}`);
          assert.equal(studyDay(after.due) - studyDay(now), after.interval, `A3: ${where}`);
        } else {
          const minutes = (after.due.getTime() - now.getTime()) / MIN;
          assert.ok(minutes >= 1 && minutes <= 15, `learning due +${minutes}m: ${where}`);
        }
        card = after;
        answers++;
      }
    });
  }
  ok(`B2-G6/G5/G10/E3/A3: ${sequences} seeded Classic sequences (${answers} answers): ease follows the integer model, lapses count, intervals rise by a day per button within the maximum, N days = N study days [seed 0x${SEEDS.classic.toString(16)}]`);
}
