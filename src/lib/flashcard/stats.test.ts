import assert from "node:assert/strict";
import type { ReviewLogEntry, SM2Card, UserFlashcard } from "@/lib/types/flashcard";
import { FSRSState, Rating, WordStatus } from "@/lib/types/flashcard";
import { calculateStreak, computeDeckStats } from "./stats";
import { isUndoShortcut } from "./shortcuts";
import { runExclusive } from "./review-actions";
import { readFileSync } from "node:fs";

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

function review(timestamp: Date, rating: Rating = Rating.Good): ReviewLogEntry {
  return {
    id: `r-${timestamp.getTime()}-${rating}`,
    card_id: "c",
    word_id: "w",
    rating,
    timestamp,
    session_id: "s",
    state_before: FSRSState.Review,
    state_after: FSRSState.Review,
  };
}

function card(id: string, state: FSRSState, due: Date, extra: Partial<UserFlashcard> = {}): UserFlashcard {
  return {
    id,
    word_id: `w-${id}`,
    status: WordStatus.IN_BANK,
    created_at: new Date(2026, 0, 1),
    fsrs_state: {
      due, stability: 30, difficulty: 5, elapsed_days: 0, scheduled_days: 10,
      learning_steps: 0, reps: state === FSRSState.New ? 0 : 3, lapses: 0, state,
    },
    ...extra,
  };
}

export function runStatsTests() {
  runCase("L1: the streak survives a DST change and follows the 4am study day", () => {
    withTimeZone("America/New_York", () => {
      // DST ends on Sunday 1 Nov 2026 in New York (a 25-hour day).
      const reviews = [
        review(new Date(2026, 9, 30, 10)),
        review(new Date(2026, 9, 31, 10)),
        review(new Date(2026, 10, 1, 10)),
        review(new Date(2026, 10, 2, 10)),
      ];
      assert.equal(calculateStreak(reviews, new Date(2026, 10, 2, 15)), 4);

      // DST starts on 8 Mar 2026 (a 23-hour day).
      const spring = [7, 8, 9].map((d) => review(new Date(2026, 2, d, 10)));
      assert.equal(calculateStreak(spring, new Date(2026, 2, 9, 12)), 3);

      // 2am on 3 Nov still belongs to the 2 Nov study day (4am rollover), so
      // studying "late" doesn't break or extend the streak.
      const late = [review(new Date(2026, 10, 1, 10)), review(new Date(2026, 10, 3, 2))];
      assert.equal(calculateStreak(late, new Date(2026, 10, 3, 3)), 2);
    });
  });

  runCase("L2: deck stats guard a zero new-card limit, count Hard as a pass, include overdue cards", () => {
    const now = new Date(2026, 9, 27, 12);
    const cards = [
      card("new1", FSRSState.New, now),
      card("overdue", FSRSState.Review, new Date(2026, 9, 20)),
      card("today", FSRSState.Review, new Date(2026, 9, 27, 18)),
    ];
    // One review card each: retention counts a card's first answer of the day (B2-D4).
    const reviews = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].map((r) => ({ ...review(now, r), card_id: `c${r}` }));
    const stats = computeDeckStats(cards, reviews, { dailyNewLimit: 0, algorithm: "fsrs" }, now);
    assert.equal(stats.daysToLearnAll, null);
    assert.equal(stats.retentionRate, 75);
    assert.equal(stats.forecast[0].count, 2, "Today includes overdue cards");
    assert.equal(computeDeckStats(cards, reviews, { dailyNewLimit: 20, algorithm: "fsrs" }, now).daysToLearnAll, 1);
  });

  runCase("L2: in Classic mode the stats come from the SM-2 state", () => {
    const now = new Date(2026, 9, 27, 12);
    const sm2 = (phase: SM2Card["phase"], interval: number, due: Date): SM2Card => ({
      phase, step: 0, interval, repetitions: 3, easiness: 2.5, lapses: 0, due,
    });
    const cards = [
      // FSRS says Review for all of these; Classic state says otherwise.
      card("unstudied", FSRSState.Review, now, { sm2_state: null }),
      card("learning", FSRSState.Review, now, { sm2_state: sm2("learning", 0, new Date(2026, 9, 27, 12, 10)) }),
      card("mature", FSRSState.New, now, { sm2_state: sm2("review", 40, new Date(2026, 10, 5)) }),
      card("young", FSRSState.New, now, { sm2_state: sm2("review", 4, new Date(2026, 9, 29, 12)) }),
    ];
    const stats = computeDeckStats(cards, [], { dailyNewLimit: 10, algorithm: "sm2" }, now);
    assert.equal(stats.newCards, 1);
    assert.equal(stats.learningCards, 1);
    assert.equal(stats.matureCards, 1);
    assert.equal(stats.avgInterval, 22);
    assert.equal(stats.forecast[0].count, 1);
    assert.equal(stats.forecast[2].count, 1);
  });
}

export function runShortcutTests() {
  runCase("L4: the advertised Z shortcut is wired to undo", () => {
    assert.equal(isUndoShortcut({ key: "z", ctrlKey: false, metaKey: false, altKey: false }), true);
    assert.equal(isUndoShortcut({ key: "Z", ctrlKey: false, metaKey: false, altKey: false }), true);
    // Leave browser shortcuts (Ctrl/Cmd+Z) and typing in fields alone.
    assert.equal(isUndoShortcut({ key: "z", ctrlKey: true, metaKey: false, altKey: false }), false);
    assert.equal(isUndoShortcut({ key: "z", ctrlKey: false, metaKey: false, altKey: false, target: { tagName: "INPUT" } }), false);
    assert.equal(isUndoShortcut({ key: "x", ctrlKey: false, metaKey: false, altKey: false }), false);

    const page = readFileSync("src/app/train/flashcards/review/page.tsx", "utf8");
    if (page.includes("(Z)")) assert.match(page, /isUndoShortcut\(/, "the page advertises Z but doesn't handle it");
  });
}

export async function runReviewActionTests() {
  // Resolves when release() is called, to hold an action "in flight".
  const pending = () => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    return { done, release };
  };
  const lock = { current: false };

  // An undo (or a second undo) is ignored while a save is in flight.
  const save = pending();
  const saving = runExclusive(lock, () => save.done);
  let undos = 0;
  assert.equal(await runExclusive(lock, async () => { undos++; }), false);
  assert.equal(undos, 0, "undo ran while a review save was in flight");
  save.release();
  assert.equal(await saving, true);

  // A save can't start during an undo, nor can a second undo.
  const undo = pending();
  const undoing = runExclusive(lock, () => undo.done);
  let saves = 0;
  assert.equal(await runExclusive(lock, async () => { saves++; }), false);
  assert.equal(await runExclusive(lock, async () => { undos++; }), false);
  assert.equal(saves + undos, 0);
  undo.release();
  await undoing;

  // A failed action releases the lock.
  await assert.rejects(runExclusive(lock, async () => { throw new Error("boom"); }));
  assert.equal(await runExclusive(lock, async () => {}), true);

  // The page runs both its rating and its undo handler through the same lock.
  const page = readFileSync("src/app/train/flashcards/review/page.tsx", "utf8");
  assert.match(page, /const handleReview = [^\n]*runExclusive\(busyRef,/);
  assert.match(page, /const handleUndo = [^\n]*runExclusive\(busyRef,/);
  console.log("ok - A1-review #3: undo is ignored while a save or another undo is in flight, and vice versa");
}

export function runFlagWordingTests() {
  runCase("L5: the flag UI doesn't promise that flags reach anyone", () => {
    const hub = readFileSync("src/app/train/flashcards/page.tsx", "utf8");
    const review = readFileSync("src/app/train/flashcards/review/page.tsx", "utf8");
    // Flags are stored only in this browser, so they can't correct anything for others.
    assert.doesNotMatch(hub, /flag it so it can be corrected for everyone/);
    assert.doesNotMatch(review, /flagged for translation review/);
    assert.match(review, /on this device/);
    assert.match(hub, /support@quranarena\.ca/);
  });
}

export function runSettingsResetTests() {
  runCase("User decision: every Reset All Data button in settings goes through the confirmation modal", () => {
    const page = readFileSync("src/app/train/flashcards/settings/page.tsx", "utf8");

    // The handler that deletes everything is the only caller of resetAllData...
    const handler = page.match(/const handleReset = async \(\) => \{[\s\S]*?\n {2}\};/);
    assert.ok(handler, "handleReset not found");
    assert.equal(page.match(/\bresetAllData\(/g)?.length, 1);
    assert.match(handler[0], /\bresetAllData\(/);

    // ...and nothing but the modal's confirm calls the handler.
    const modalStart = page.indexOf("<ResetWarningModal");
    const modal = page.slice(modalStart, page.indexOf("/>", modalStart));
    assert.match(modal, /onConfirm=\{[^}]*\bhandleReset\(\)/);
    const calls = [...page.matchAll(/\bhandleReset\b/g)].map((m) => m.index!);
    for (const at of calls) {
      if (at === page.indexOf("const handleReset =") + "const ".length) continue;
      assert.ok(at > modalStart && at < modalStart + modal.length, `handleReset is reached without the confirmation: ${page.slice(at - 40, at + 20)}`);
    }

    // Both reset buttons open that modal.
    for (const label of ["Reset All Data", "Reset Flashcard Suite"]) {
      const button = page.slice(page.lastIndexOf("<button", page.indexOf(`>${label}<`)), page.indexOf(`>${label}<`));
      assert.match(button, /onClick=\{\(\) => setShowResetWarning\(true\)\}/, `"${label}" doesn't open the confirmation`);
    }
  });
}
