/**
 * Multi-day flashcard simulation (docs/flashcard-verification-plan.md §3.5).
 *
 * Drives the real session code (createReviewSession, reviewCard, undoReview,
 * getHubSummary, computeDeckStats, calculateStreak) through the real storage
 * code, with a fake clock and a fake browser: as a guest (localStorage) or
 * signed in (an in-memory server that answers like the /api routes). A
 * hidden memory model, which the scheduler never sees, decides each answer.
 * Every simulated answer and day is checked against the invariants in §3.5.
 *
 * npm test runs short versions (runFastSimulations). The full 90-day runs:
 *   npx tsx scripts/flashcard-sim.ts [--out <dir for the per-day CSVs>]
 * Nothing here touches the network: any request outside the fake server fails.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FSRSParameters, FlashcardSession, Rating, ReviewLogEntry, UserFlashcard, UserPreferences } from "../src/lib/types/flashcard";
import { DEFAULT_FSRS_PARAMETERS, DEFAULT_PREFERENCES, WordStatus } from "../src/lib/types/flashcard";
import { Rng, SEEDS, newBrowser, studyDay, withBrowser, withClock, type Clock } from "../src/lib/flashcard/verification/helpers";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export interface SimConfig {
  name: string;
  /** Zones in order, with the day each one starts (the first starts on day 0). */
  zones: Array<[string, number]>;
  start: [number, number, number];
  days: number;
  signedIn: boolean;
  algorithm: "fsrs" | "sm2";
  params?: Partial<FSRSParameters>;
  prefs?: Partial<UserPreferences>;
  /** FSRS → Classic on the first day, back to FSRS on the second. */
  switchDays?: [number, number];
  /** Extra sessions at a local time: [day, hour, minute]. */
  forcedSessions?: Array<[number, number, number]>;
  deck: { initial: number; batch: number; every: number; total: number };
  breakDays?: [number, number];
  seed: number;
}

export interface DayRow {
  day: number;
  date: string;
  sessions: number;
  newCards: number;
  reviews: number;
  learning: number;
  served: number;
  meanInterval: number;
  maxInterval: number;
  trueRetention: number | null;
}

export interface SimResult {
  name: string;
  days: number;
  answers: number;
  undos: number;
  reloads: number;
  maxInterval: number;
  meanInterval: number;
  trueRetention: number | null;
  failures: string[];
  rows: DayRow[];
  checks: Record<string, number>;
}

interface Answer {
  cardId: string;
  kind: "new" | "learning" | "review";
  at: number;
  logId: string;
  live: boolean;
}

interface Truth {
  stability: number;
  last: number | null;
  growth: number;
}

/** Runs one simulation; every failed invariant is collected, not thrown. */
export async function runSimulation(config: SimConfig): Promise<SimResult> {
  const rng = new Rng(config.seed);
  const failures: string[] = [];
  const checks: Record<string, number> = {};
  const check = (id: string, condition: boolean, message: () => string) => {
    checks[id] = (checks[id] ?? 0) + 1;
    if (!condition && failures.length < 50) failures.push(`${id}: ${message()}`);
  };
  const savedTz = process.env.TZ;
  process.env.TZ = config.zones[0][0];
  // Ids drive FSRS's fuzz seed, so they come from the seeded generator: a run
  // is then exactly repeatable.
  const cryptoObject = globalThis.crypto as Crypto & { randomUUID: () => string };
  const realUUID = cryptoObject.randomUUID.bind(cryptoObject);
  Object.defineProperty(cryptoObject, "randomUUID", { value: () => rng.uuid(), configurable: true, writable: true });

  const [y, m, d] = config.start;
  const browser = newBrowser(config.signedIn);
  const rows: DayRow[] = [];
  const answers: Answer[] = [];
  let undos = 0;
  let reloads = 0;
  let reviewRecalls = 0;
  let reviewAnswers = 0;

  try {
    return await withClock(new Date(y, m, d, 6, 0), (clock: Clock) =>
      withBrowser(browser, async () => {
        const storage = await import("../src/lib/storage/flashcard-storage-supabase");
        const sessions = await import("../src/lib/flashcard/session-manager");
        const queue = await import("../src/lib/flashcard/queue");
        const stats = await import("../src/lib/flashcard/stats");
        const intake = await import("../src/lib/flashcard/intake-manager");

        const params: FSRSParameters = { ...DEFAULT_FSRS_PARAMETERS, ...config.params };
        let prefs: UserPreferences = { ...DEFAULT_PREFERENCES, ...config.prefs, algorithm: config.algorithm };
        await storage.savePreferences(prefs, params);
        let algorithm = prefs.algorithm;
        const truth = new Map<string, Truth>();
        const knownIds = new Set<string>();
        /** What the simulation believes each card's state is (K1). */
        const model = new Map<string, UserFlashcard>();
        let fsrsSnapshot: Map<string, string> | null = null;
        let added = 0;

        const activeState = (card: UserFlashcard) => JSON.stringify(algorithm === "sm2" ? card.sm2_state ?? null : card.fsrs_state);
        const loadDeck = async () => new Map((await storage.getFlashcards()).map((c) => [c.id, c]));
        const interval = (card: UserFlashcard) => (algorithm === "sm2" ? card.sm2_state?.interval ?? 0 : card.fsrs_state.scheduled_days);
        const stamp = () => new Date(clock.now()).toString();

        const addBatch = async () => {
          const count = Math.min(added === 0 ? config.deck.initial : config.deck.batch, config.deck.total - added);
          if (count <= 0) return;
          const ids = Array.from({ length: count }, (_, i) => `lex-${String(added + i).padStart(4, "0")}`);
          added += count;
          const known = ids.filter(() => rng.chance(0.15));
          const learn = ids.filter((id) => !known.includes(id));
          await intake.addWordsToBank(learn, WordStatus.IN_BANK);
          if (known.length) await intake.addWordsToBank(known, WordStatus.KNOWN_NOT_IN_BANK);
          for (const card of await storage.getFlashcards()) {
            if (card.status === WordStatus.KNOWN_NOT_IN_BANK) knownIds.add(card.id);
            else if (!truth.has(card.id)) {
              truth.set(card.id, { stability: 0, last: null, growth: rng.float(1.6, 3.2) });
              model.set(card.id, card);
            }
          }
          // D3q: the new words come in the order they were added.
          const order = (await storage.getFlashcards()).filter((c) => queue.getQueueKind(c, algorithm) === "new" && c.status !== WordStatus.KNOWN_NOT_IN_BANK).map((c) => c.word_id);
          check("D3q", order.join() === [...order].sort().join(), () => `new cards out of intake order at ${stamp()}`);
        };

        /** The hidden memory model's answer, and whether it was a true recall. */
        const decide = (card: UserFlashcard): { rating: Rating; recalled: boolean } => {
          const t = truth.get(card.id)!;
          const now = clock.now();
          if (t.last === null) {
            t.last = now;
            t.stability = rng.float(0.4, 2);
            return { rating: ([1, 2, 3, 4] as Rating[])[rng.weighted([30, 10, 50, 10])], recalled: false };
          }
          const elapsedDays = (now - t.last) / DAY;
          const recalled = rng.chance(Math.exp((Math.log(0.9) * elapsedDays) / Math.max(0.05, t.stability)));
          t.last = now;
          if (!recalled) {
            t.stability = Math.max(0.2, t.stability * 0.35);
            return { rating: 1, recalled };
          }
          if (elapsedDays >= 0.5) t.stability *= t.growth;
          return { rating: ([2, 3, 4] as Rating[])[rng.weighted([15, 70, 15])], recalled };
        };

        /** Checks one answer: intervals, success, limits and double reviews. */
        const afterAnswer = (before: UserFlashcard, after: UserFlashcard, kind: Answer["kind"], rating: Rating, at: number) => {
          const now = new Date(at);
          const where = () => `card ${before.id} ${kind} rating ${rating} at ${now.toString()}`;
          check("7 Known never served", !knownIds.has(before.id), where);
          const state = algorithm === "sm2" ? after.sm2_state! : after.fsrs_state;
          const due = new Date(state.due);
          check("4 due after the answer", due.getTime() >= at, where);
          const isReview = queue.getQueueKind(after, algorithm) === "review";
          if (isReview) {
            const days = interval(after);
            check("4 interval within [1, max]", days >= 1 && days <= params.maximum_interval && Number.isFinite(days), () => `${days} days: ${where()}`);
            check("A3 N days = N study days", studyDay(due) - studyDay(now) === days, () => `due ${due.toString()} for ${days} days: ${where()}`);
          }
          if (kind === "review" && rating >= 2) {
            check("5 success moves the due date forward", studyDay(due) - studyDay(now) >= 1, where);
            if (algorithm === "sm2") {
              const cur = Math.max(1, before.sm2_state?.interval ?? 1);
              check("5 Classic interval grows", after.sm2_state!.interval >= Math.min(cur + 1, params.maximum_interval), where);
            } else if (rating >= 3 || after.fsrs_state.elapsed_days > 0) {
              check("5 FSRS stability does not fall", after.fsrs_state.stability >= before.fsrs_state.stability - 1e-8, where);
            }
          }
          // Limits for the study day (C1, C3, C4), from the simulation's own records.
          const dayStart = queue.getDayStart(now).getTime();
          const today = answers.filter((a) => a.live && a.at >= dayStart);
          const newIds = new Set(today.filter((a) => a.kind === "new").map((a) => a.cardId));
          const reviewIds = new Set(today.filter((a) => a.kind === "review").map((a) => a.cardId));
          check("1 new cards within the new limit", newIds.size <= prefs.daily_new_cards_limit, () => `${newIds.size}: ${where()}`);
          check("2 reviews within the review limit", reviewIds.size <= prefs.daily_review_cards_limit, () => `${reviewIds.size}: ${where()}`);
          if (!prefs.new_cards_ignore_review_limit) {
            check("1 new + reviews within the review limit", newIds.size + reviewIds.size <= prefs.daily_review_cards_limit, () => `${newIds.size}+${reviewIds.size}: ${where()}`);
          }
          // 6: no review card is served as a review twice in one study day.
          const servedAsReview = today.filter((a) => a.kind === "review" && a.cardId === before.id).length;
          check("6 no double review in a study day", servedAsReview <= 1, () => `${servedAsReview} times: ${where()}`);
        };

        /** K1 / 11: what storage holds equals what the simulation saw saved. */
        const verifyStorage = async (label: string) => {
          const deck = await loadDeck();
          let mismatches = 0;
          for (const [id, card] of model) {
            const stored = deck.get(id);
            if (!stored || JSON.stringify(stored.fsrs_state) !== JSON.stringify(card.fsrs_state) || JSON.stringify(stored.sm2_state ?? null) !== JSON.stringify(card.sm2_state ?? null)) mismatches++;
          }
          check("11 reload changes nothing", mismatches === 0, () => `${mismatches} cards differ after ${label} at ${stamp()}`);
          const log = await storage.getReviewLog();
          const live = answers.filter((a) => a.live).length;
          check("K1 no answer lost or doubled", log.length === live, () => `log ${log.length}, answers ${live} at ${stamp()}`);
        };

        let answeredSinceReload = 0;

        /** Answers the session's current card (with a 3% chance of undo and retry). */
        const answerOne = async (session: FlashcardSession): Promise<FlashcardSession> => {
          const card = sessions.getCurrentCard(session)!;
          const kind = queue.getQueueKind(card, algorithm);
          const truthBefore = { ...truth.get(card.id)! };
          const { rating, recalled } = decide(card);
          clock.advance(rng.int(4, 15) * 1000);
          const at = clock.now();
          const { updatedSession, logId } = await sessions.reviewCard(session, card.id, rating, 8000);
          const after = updatedSession.cards[session.current_index];
          const record: Answer = { cardId: card.id, kind, at, logId, live: true };
          answers.push(record);
          afterAnswer(card, after, kind, rating, at);

          if (rng.chance(0.03)) {
            // 8: undo restores the card, the log and the day's counts exactly.
            const countsBefore = queue.countTodayActivity(answers.filter((a) => a !== record && a.live).map(toLog), new Date(at));
            const logBefore = (await storage.getReviewLog()).length;
            await sessions.undoReview(card, logId, session.algorithm);
            record.live = false;
            undos++;
            const stored = (await loadDeck()).get(card.id)!;
            check("8 undo restores the card", activeState(stored) === activeState(card), () => `card ${card.id} at ${stamp()}`);
            const logAfter = await storage.getReviewLog();
            check("8 undo removes the log entry", logAfter.length === logBefore - 1 && !logAfter.some((r) => r.id === logId), () => `at ${stamp()}`);
            const countsAfter = queue.countTodayActivity(logAfter, new Date(at));
            check("8 undo restores the counts", JSON.stringify(countsAfter) === JSON.stringify(countsBefore), () => `${JSON.stringify(countsAfter)} vs ${JSON.stringify(countsBefore)} at ${stamp()}`);
            truth.set(card.id, truthBefore);
            return session; // the page goes back to the previous session; the card is answered again
          }
          model.set(card.id, after);
          if (kind === "review") {
            reviewAnswers++;
            if (recalled) reviewRecalls++;
          }
          return updatedSession;
        };

        const toLog = (a: Answer): ReviewLogEntry => ({
          id: a.logId, card_id: a.cardId, word_id: "", rating: 3, timestamp: new Date(a.at), session_id: "",
          state_before: a.kind === "new" ? 0 : a.kind === "review" ? 2 : 1, state_after: 2,
        });

        /** One session slot; the day's last slot keeps going until nothing is left today. */
        const runSlot = async (finishDay: boolean, firstOfDay: boolean): Promise<boolean> => {
          const dayEnd = queue.getNextDayStart(new Date(clock.now())).getTime();
          let session: FlashcardSession | null;
          if (firstOfDay) {
            // 9 / J1: the hub's counts equal what a session can serve.
            const hub = await sessions.getHubSummary(new Date(clock.now()));
            session = await sessions.createReviewSession();
            const expected = Math.min(prefs.session_size, hub.due + hub.newCards);
            check("9 hub counts equal the session", (session?.cards.length ?? 0) === expected, () => `hub ${hub.due}+${hub.newCards}, session ${session?.cards.length ?? 0} at ${stamp()}`);
          } else session = await sessions.createReviewSession();
          let rounds = 0;
          while (session && clock.now() < dayEnd && rounds < 200) {
            if (sessions.isSessionComplete(session)) {
              if (!finishDay) return false;
              session = await sessions.createReviewSession();
              rounds++;
              continue;
            }
            session = await answerOne(session);
            if (++answeredSinceReload >= 25) {
              answeredSinceReload = 0;
              reloads++;
              await verifyStorage("a reload");
              session = await sessions.createReviewSession();
            }
          }
          return session === null; // the day was finished, not cut short by the rollover
        };

        const dayCards = () => answers.filter((a) => a.live);
        let breakLeft = 0;

        for (let day = 0; day < config.days; day++) {
          for (const [zone, from] of config.zones) if (from === day && day > 0) process.env.TZ = zone;
          // Just after the 4am rollover, so a forced 04:30 session really is at 04:30.
          const morning = new Date(y, m, d + day, 4, 5);
          if (clock.now() < morning.getTime()) clock.set(morning);
          if (day % config.deck.every === 0) await addBatch();
          if (config.switchDays && (day === config.switchDays[0] || day === config.switchDays[1])) {
            const toSm2 = day === config.switchDays[0];
            if (toSm2) fsrsSnapshot = new Map([...(await loadDeck())].map(([id, c]) => [id, JSON.stringify(c.fsrs_state)]));
            prefs = { ...prefs, algorithm: toSm2 ? "sm2" : "fsrs" };
            await storage.savePreferences(prefs, params);
            algorithm = prefs.algorithm;
            if (!toSm2 && fsrsSnapshot) {
              const deck = await loadDeck();
              const changed = [...fsrsSnapshot].filter(([id, state]) => JSON.stringify(deck.get(id)?.fsrs_state) !== state).length;
              check("12 switching back restores the FSRS states", changed === 0, () => `${changed} FSRS states changed while in Classic`);
            } else {
              const deck = [...(await loadDeck()).values()].filter((c) => c.status !== WordStatus.KNOWN_NOT_IN_BANK);
              const fresh = deck.filter((c) => !c.sm2_state);
              check("12 cards without a Classic state are new", fresh.every((c) => queue.getQueueKind(c, "sm2") === "new"), () => "a card without sm2_state is not new");
            }
          }
          if (config.breakDays && day === config.breakDays[0]) breakLeft = config.breakDays[1];
          const forced = (config.forcedSessions ?? []).filter(([fd]) => fd === day).map(([, h, mi]) => h * 60 + mi);
          const skip = breakLeft > 0 || (day > 0 && rng.chance(0.1));
          if (breakLeft > 0) breakLeft--;
          const before = dayCards().length;
          let slots: number[] = [];
          if (!skip) {
            const options = [7 * 60, 12 * 60 + 30, 22 * 60 + 30, 27 * 60 + 30];
            const count = rng.int(1, 3);
            slots = options.filter(() => rng.chance(count / 4));
            if (!slots.length) slots = [rng.pick(options)];
          }
          slots = [...new Set([...slots, ...forced])].sort((a, b) => a - b);
          let finished = false;
          for (let s = 0; s < slots.length; s++) {
            const at = new Date(y, m, d + day, 0, slots[s]);
            if (clock.now() < at.getTime()) clock.set(at);
            finished = await runSlot(s === slots.length - 1, s === 0);
          }

          // End-of-day checks.
          const now = new Date(clock.now());
          const deck = [...(await loadDeck()).values()];
          const study = deck.filter((c) => c.status !== WordStatus.KNOWN_NOT_IN_BANK);
          if (finished) {
            // 3: nothing is left behind while there is budget.
            const dayStart = queue.getDayStart(now).getTime();
            const today = dayCards().filter((a) => a.at >= dayStart);
            const reviewsDone = new Set(today.filter((a) => a.kind === "review").map((a) => a.cardId)).size;
            const newDone = new Set(today.filter((a) => a.kind === "new").map((a) => a.cardId)).size;
            const room = prefs.daily_review_cards_limit - reviewsDone - (prefs.new_cards_ignore_review_limit ? 0 : newDone);
            const dayEnd = queue.getNextDayStart(now).getTime();
            const leftBehind = study.filter((c) => queue.getQueueKind(c, algorithm) === "review" && new Date(algorithm === "sm2" ? c.sm2_state!.due : c.fsrs_state.due).getTime() < dayEnd);
            check("3 nothing left behind with budget", room <= 0 || leftBehind.length === 0, () => `${leftBehind.length} due reviews left with room ${room} at ${stamp()}`);
          }
          const log = await storage.getReviewLog();
          // 10: streak and stats.
          const days = new Set(dayCards().map((a) => studyDay(new Date(a.at))));
          let cursor = studyDay(now);
          if (!days.has(cursor)) cursor--;
          let streak = 0;
          while (days.has(cursor)) { streak++; cursor--; }
          check("10 streak", stats.calculateStreak(log, now) === streak, () => `${stats.calculateStreak(log, now)} vs ${streak} at ${stamp()}`);
          const deckStats = stats.computeDeckStats(deck.filter((c) => c.status !== WordStatus.KNOWN_NOT_IN_BANK), log, { dailyNewLimit: prefs.daily_new_cards_limit, algorithm }, now);
          check("10 stats add up", deckStats.newCards + deckStats.learningCards + deckStats.reviewCardCount === study.length, () => `at ${stamp()}`);
          const dueToday = study.filter((c) => queue.getQueueKind(c, algorithm) !== "new" && new Date(algorithm === "sm2" ? c.sm2_state!.due : c.fsrs_state.due).getTime() < queue.getNextDayStart(now).getTime()).length;
          check("10 forecast Today", deckStats.forecast[0].count === dueToday, () => `${deckStats.forecast[0].count} vs ${dueToday} at ${stamp()}`);

          const todays = dayCards().slice(before);
          const reviewCards = study.filter((c) => queue.getQueueKind(c, algorithm) === "review");
          const intervals = reviewCards.map(interval);
          rows.push({
            day, date: new Date(y, m, d + day).toISOString().slice(0, 10), sessions: slots.length,
            newCards: todays.filter((a) => a.kind === "new").length,
            reviews: todays.filter((a) => a.kind === "review").length,
            learning: todays.filter((a) => a.kind === "learning").length,
            served: todays.length,
            meanInterval: intervals.length ? Number((intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(1)) : 0,
            maxInterval: intervals.length ? Math.max(...intervals) : 0,
            trueRetention: reviewAnswers ? Number((reviewRecalls / reviewAnswers).toFixed(3)) : null,
          });
        }
        await verifyStorage("the run");
        const last = rows[rows.length - 1];
        return {
          name: config.name, days: config.days, answers: answers.filter((a) => a.live).length, undos, reloads,
          maxInterval: Math.max(0, ...rows.map((r) => r.maxInterval)), meanInterval: last?.meanInterval ?? 0,
          trueRetention: reviewAnswers ? Number((reviewRecalls / reviewAnswers).toFixed(3)) : null,
          failures, rows, checks,
        };
      })
    );
  } finally {
    Object.defineProperty(cryptoObject, "randomUUID", { value: realUUID, configurable: true, writable: true });
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
}

const DECK_90 = { initial: 300, batch: 30, every: 7, total: 600 };

/** The plan's runs: 4 timings × 6 configurations, 90 days each. */
export function fullConfigs(): SimConfig[] {
  const timings: Array<Pick<SimConfig, "name" | "zones" | "start" | "forcedSessions">> = [
    { name: "run1 New York from 2026-10-01 (DST ends)", zones: [["America/New_York", 0]], start: [2026, 9, 1], forcedSessions: [[30, 4, 30], [30, 22, 30]] },
    { name: "run2 New York from 2027-02-15 (DST starts)", zones: [["America/New_York", 0]], start: [2027, 1, 15] },
    { name: "run3 Dubai from 2026-10-01", zones: [["Asia/Dubai", 0]], start: [2026, 9, 1] },
    { name: "run4 Toronto then Dubai from day 45", zones: [["America/Toronto", 0], ["Asia/Dubai", 45]], start: [2026, 9, 1] },
  ];
  const variants: Array<Pick<SimConfig, "algorithm" | "params" | "prefs" | "switchDays"> & { label: string }> = [
    { label: "FSRS defaults", algorithm: "fsrs" },
    { label: "FSRS 0.80 / max 30 / no fuzz", algorithm: "fsrs", params: { request_retention: 0.8, maximum_interval: 30, enable_fuzz: false } },
    { label: "Classic defaults", algorithm: "sm2" },
    { label: "Classic max 30", algorithm: "sm2", params: { maximum_interval: 30 } },
    { label: "FSRS, new words ignore the review limit", algorithm: "fsrs", prefs: { new_cards_ignore_review_limit: true, daily_review_cards_limit: 60 } },
    { label: "FSRS → Classic day 45 → FSRS day 70", algorithm: "fsrs", switchDays: [45, 70] },
  ];
  const configs: SimConfig[] = [];
  timings.forEach((timing, t) => variants.forEach((variant, v) => {
    configs.push({
      ...timing, name: `${timing.name}, ${variant.label}`, days: 90, signedIn: true,
      algorithm: variant.algorithm, params: variant.params, prefs: variant.prefs, switchDays: variant.switchDays,
      deck: DECK_90, breakDays: [40, 5], seed: SEEDS.simulation + t * 16 + v,
    });
  }));
  // The guest storage path re-reads the whole review log on every answer, so
  // its long run is 30 days.
  configs.push({
    name: "guest: run1 New York from 2026-10-01, FSRS defaults, 30 days", zones: [["America/New_York", 0]], start: [2026, 9, 1],
    forcedSessions: [[30, 4, 30], [30, 22, 30]], days: 31, signedIn: false, algorithm: "fsrs", deck: DECK_90, breakDays: [20, 5], seed: SEEDS.simulation + 99,
  });
  return configs;
}

/** The short runs npm test does (about 14 simulated days each). */
export function fastConfigs(): SimConfig[] {
  const deck = { initial: 60, batch: 15, every: 7, total: 120 };
  return [
    {
      name: "fast guest: New York 2026-10-25 → 11-07 (DST ends; session at 10-31 04:30), FSRS", zones: [["America/New_York", 0]],
      start: [2026, 9, 25], forcedSessions: [[6, 4, 30], [6, 22, 30]], days: 14, signedIn: false, algorithm: "fsrs",
      prefs: { daily_new_cards_limit: 10 }, deck, breakDays: [9, 2], seed: SEEDS.simulation + 200,
    },
    {
      name: "fast signed in: New York 2027-03-07 → 03-20 (DST starts), Classic, ignore review limit", zones: [["America/New_York", 0]],
      start: [2027, 2, 7], days: 14, signedIn: true, algorithm: "sm2",
      prefs: { new_cards_ignore_review_limit: true, daily_review_cards_limit: 30 }, deck, seed: SEEDS.simulation + 201,
    },
    {
      name: "fast signed in: Toronto then Dubai (day 7), FSRS → Classic day 5 → FSRS day 10", zones: [["America/Toronto", 0], ["Asia/Dubai", 7]],
      start: [2026, 9, 1], days: 14, signedIn: true, algorithm: "fsrs", switchDays: [5, 10], deck, seed: SEEDS.simulation + 202,
    },
  ];
}

export function summaryLine(r: SimResult): string {
  return `${r.name}: ${r.days} days, ${r.answers} answers, ${r.undos} undos, ${r.reloads} reloads, max interval ${r.maxInterval}, mean interval ${r.meanInterval}, true retention ${r.trueRetention ?? "n/a"}, invariant failures ${r.failures.length}`;
}

/**
 * A6 (an intentional difference, as designed): a session keeps the queue it
 * was built with when it runs across the 4am rollover; the answers given
 * after 4am count toward the new day, and the next session uses its limits.
 */
async function checkSessionAcrossRollover() {
  const savedTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    await withClock(new Date(2026, 9, 27, 3, 50), (clock) =>
      withBrowser(newBrowser(false), async () => {
        const storage = await import("../src/lib/storage/flashcard-storage-supabase");
        const sessions = await import("../src/lib/flashcard/session-manager");
        const intake = await import("../src/lib/flashcard/intake-manager");
        const queue = await import("../src/lib/flashcard/queue");
        await storage.savePreferences({ ...DEFAULT_PREFERENCES, daily_new_cards_limit: 2 });
        await intake.addWordsToBank(["a", "b", "c", "d", "e"], WordStatus.IN_BANK);
        const session = (await sessions.createReviewSession())!;
        const ids = session.cards.map((c) => c.id);
        assert.equal(ids.length, 2, "two new words before 4am");
        clock.set(new Date(2026, 9, 27, 4, 5));
        let current = session;
        for (let i = 0; i < 2; i++) current = (await sessions.reviewCard(current, sessions.getCurrentCard(current)!.id, 4)).updatedSession;
        assert.deepEqual(current.cards.slice(0, 2).map((c) => c.id), ids, "the session kept its queue across 4am");
        const counts = queue.countTodayActivity(await storage.getReviewLog(), new Date());
        assert.equal(counts.newStudied, 2, "the answers after 4am count toward the new day");
        const next = await sessions.createReviewSession();
        assert.equal(next, null, "the next session uses the new day's (now used) new-word limit");
      })
    );
  } finally {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
  console.log("ok - B2-A6: a session that runs across 4am keeps its queue; later sessions use the new day's limits");
}

/** J6: the session summary counts equal the ratings given; an undo (the page restores the previous session) takes one back. */
async function checkSessionSummary() {
  await withClock(new Date(2026, 9, 27, 12, 0), () =>
    withBrowser(newBrowser(false), async () => {
      const sessions = await import("../src/lib/flashcard/session-manager");
      const intake = await import("../src/lib/flashcard/intake-manager");
      await intake.addWordsToBank(["a", "b", "c", "d", "e"], WordStatus.IN_BANK);
      let session = (await sessions.createReviewSession())!;
      const history: FlashcardSession[] = [];
      for (const rating of [1, 2, 3, 4, 3] as Rating[]) {
        history.push(session);
        session = (await sessions.reviewCard(session, sessions.getCurrentCard(session)!.id, rating, 1000)).updatedSession;
      }
      const summary = await sessions.getSessionSummary(session);
      assert.deepEqual(summary.ratings, { again: 1, hard: 1, good: 2, easy: 1 });
      assert.equal(summary.cardsReviewed, 5);
      assert.equal(summary.totalTime, 5000);
      const undone = await sessions.getSessionSummary(history[history.length - 1]);
      assert.deepEqual(undone.ratings, { again: 1, hard: 1, good: 1, easy: 1 });
    })
  );
  console.log("ok - B2-J6: the session summary counts equal the ratings given, and the session before an undo has one fewer");
}

/** npm test: the short runs, every invariant must hold. */
export async function runFastSimulations() {
  await checkSessionAcrossRollover();
  await checkSessionSummary();
  for (const config of fastConfigs()) {
    const result = await runSimulation(config);
    assert.deepEqual(result.failures, [], `simulation "${config.name}" (seed 0x${config.seed.toString(16)})`);
    const total = Object.values(result.checks).reduce((a, b) => a + b, 0);
    console.log(`ok - B2-S: ${summaryLine(result)} (${total} checks)`);
  }
}

async function main() {
  const outFlag = process.argv.indexOf("--out");
  const out = outFlag > 0 ? process.argv[outFlag + 1] : null;
  if (out) mkdirSync(out, { recursive: true });
  let failed = 0;
  const only = process.argv.includes("--fast") ? fastConfigs() : fullConfigs();
  for (const [i, config] of only.entries()) {
    const started = Date.now();
    const result = await runSimulation(config);
    console.log(`${result.failures.length ? "FAIL" : "ok  "} ${summaryLine(result)} [${Math.round((Date.now() - started) / 1000)}s, seed 0x${config.seed.toString(16)}]`);
    for (const f of result.failures.slice(0, 10)) console.log(`     ${f}`);
    if (result.failures.length) failed++;
    if (out) {
      const header = "day,date,sessions,new,reviews,learning,served,mean_interval,max_interval,true_retention";
      const lines = result.rows.map((r) => [r.day, r.date, r.sessions, r.newCards, r.reviews, r.learning, r.served, r.meanInterval, r.maxInterval, r.trueRetention ?? ""].join(","));
      writeFileSync(path.join(out, `sim-${String(i + 1).padStart(2, "0")}.csv`), `# ${config.name}\n${header}\n${lines.join("\n")}\n`);
    }
  }
  console.log(failed ? `${failed} simulation run(s) failed` : "All simulation runs passed.");
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && /flashcard-sim\.ts$/.test(process.argv[1])) void main();
