/**
 * Anki-style study queues.
 *
 * Mirrors the Anki v3 scheduler's defaults:
 *  - The study day rolls over at 4am local time, not midnight.
 *  - Review cards are due for the whole day they fall on, not from the exact
 *    timestamp the scheduler produced.
 *  - Learning/relearning cards are due by the minute and are not capped by the
 *    review limit.
 *  - The daily new/review limits count everything studied since the rollover,
 *    across sessions.
 *  - Learning cards answered in a session come back in that same session once
 *    due, or early (up to the learn-ahead limit) when nothing else is left.
 */

import type { ReviewLogEntry, UserFlashcard } from "@/lib/types/flashcard";
import { FSRSState, WordStatus } from "@/lib/types/flashcard";

export type Algorithm = "fsrs" | "sm2";
export type QueueKind = "new" | "learning" | "review";

/** Anki's default "Next day starts at" hour. */
export const DAY_ROLLOVER_HOUR = 4;

/** Anki's default "Learn ahead limit". */
export const LEARN_AHEAD_MS = 20 * 60 * 1000;

export function getDayStart(now: Date = new Date()): Date {
  const start = new Date(now);
  start.setHours(DAY_ROLLOVER_HOUR, 0, 0, 0);
  if (now < start) start.setDate(start.getDate() - 1);
  return start;
}

export function getNextDayStart(now: Date = new Date()): Date {
  const next = getDayStart(now);
  next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Words marked "Known" during intake are stored only so intake doesn't offer
 * them again; they are not part of the study deck.
 */
export function isStudyCard(card: UserFlashcard): boolean {
  return card.status !== WordStatus.KNOWN_NOT_IN_BANK;
}

export function getQueueKind(card: UserFlashcard, algorithm: Algorithm): QueueKind {
  if (algorithm === "sm2") {
    // States saved by older versions have no phase; they are review cards.
    const phase = card.sm2_state?.phase;
    if (!card.sm2_state) return "new";
    return phase === "learning" || phase === "relearning" ? "learning" : "review";
  }
  switch (card.fsrs_state.state) {
    case FSRSState.New:
      return "new";
    case FSRSState.Learning:
    case FSRSState.Relearning:
      return "learning";
    default:
      return "review";
  }
}

function getDue(card: UserFlashcard, algorithm: Algorithm): number {
  const due = algorithm === "sm2" ? card.sm2_state?.due ?? card.created_at : card.fsrs_state.due;
  return new Date(due).getTime();
}

export interface TodayCounts {
  newStudied: number;
  reviewsDone: number;
}

/** Counts cards that have used up today's new/review allowance. */
export function countTodayActivity(reviews: ReviewLogEntry[], now: Date = new Date()): TodayCounts {
  const dayStart = getDayStart(now).getTime();
  const newIds = new Set<string>();
  const reviewIds = new Set<string>();
  for (const review of reviews) {
    if (new Date(review.timestamp).getTime() < dayStart) continue;
    if (review.state_before === FSRSState.New) newIds.add(review.card_id);
    else if (review.state_before === FSRSState.Review) reviewIds.add(review.card_id);
  }
  return { newStudied: newIds.size, reviewsDone: reviewIds.size };
}

export interface DailyLimits {
  newLimit: number;
  reviewLimit: number;
  /**
   * By default the review limit also caps new cards (Anki manual, Deck
   * Options > Daily Limits: "New cards ignore review limit" is off by
   * default). When true, only the new-card limit applies to new cards.
   */
  newCardsIgnoreReviewLimit?: boolean;
}

export interface TodaysQueues {
  learning: UserFlashcard[];
  reviews: UserFlashcard[];
  newCards: UserFlashcard[];
}

export function getTodaysQueues(
  cards: UserFlashcard[],
  algorithm: Algorithm,
  limits: DailyLimits,
  today: TodayCounts,
  now: Date = new Date()
): TodaysQueues {
  cards = cards.filter(isStudyCard);
  const learnCutoff = now.getTime() + LEARN_AHEAD_MS;
  const dayEnd = getNextDayStart(now).getTime();
  const byDue = (a: UserFlashcard, b: UserFlashcard) => getDue(a, algorithm) - getDue(b, algorithm);

  const learning = cards
    .filter((c) => getQueueKind(c, algorithm) === "learning" && getDue(c, algorithm) <= learnCutoff)
    .sort(byDue);
  // New cards studied today use up review-limit room too, unless they ignore it.
  const countsNew = !limits.newCardsIgnoreReviewLimit;
  const reviewRoom = Math.max(0, limits.reviewLimit - today.reviewsDone - (countsNew ? today.newStudied : 0));
  const reviews = cards
    .filter((c) => getQueueKind(c, algorithm) === "review" && getDue(c, algorithm) < dayEnd)
    .sort(byDue)
    .slice(0, reviewRoom);
  const newRoom = Math.max(0, limits.newLimit - today.newStudied);
  const newCards = cards
    .filter((c) => getQueueKind(c, algorithm) === "new")
    .slice(0, countsNew ? Math.min(newRoom, reviewRoom - reviews.length) : newRoom);

  return { learning, reviews, newCards };
}

/**
 * Moves the card Anki would show next into `index`: a learning card that has
 * come due, otherwise the next new/review card, otherwise the earliest learning
 * card within the learn-ahead limit. Learning cards beyond that limit are
 * dropped, so the session ends and they wait for a later session.
 */
export function arrangeNext(
  queue: UserFlashcard[],
  index: number,
  algorithm: Algorithm,
  now: Date = new Date()
): UserFlashcard[] {
  const nowMs = now.getTime();
  const done = queue.slice(0, index);
  const pending = queue.slice(index);
  const isLearning = (c: UserFlashcard) => getQueueKind(c, algorithm) === "learning";

  let earliestLearning = -1;
  for (let i = 0; i < pending.length; i++) {
    if (!isLearning(pending[i])) continue;
    if (earliestLearning === -1 || getDue(pending[i], algorithm) < getDue(pending[earliestLearning], algorithm)) {
      earliestLearning = i;
    }
  }

  let next = -1;
  if (earliestLearning !== -1 && getDue(pending[earliestLearning], algorithm) <= nowMs) {
    next = earliestLearning;
  } else {
    next = pending.findIndex((c) => !isLearning(c));
    if (next === -1 && earliestLearning !== -1 && getDue(pending[earliestLearning], algorithm) <= nowMs + LEARN_AHEAD_MS) {
      next = earliestLearning;
    }
  }

  if (next === -1) return done;
  const [card] = pending.splice(next, 1);
  return [...done, card, ...pending];
}

/**
 * Orders a session: learning cards first, then new cards spread evenly among
 * the reviews, then capped at the session size. This matches the "mix with
 * reviews" new/review order of Anki's v3 scheduler (the option is described in
 * the Anki manual, Deck Options > Display Order; using it as the default
 * follows the remediation plan, N4).
 * Spreading before the cap means a review backlog no longer pushes every new
 * card out of the session.
 */
export function buildSessionQueue(queues: TodaysQueues, sessionSize: number): UserFlashcard[] {
  const { reviews, newCards } = queues;
  const mixed: UserFlashcard[] = [];
  let r = 0;
  let n = 0;
  while (r < reviews.length || n < newCards.length) {
    // Take a new card when it is "due" in the even spread of N new cards over
    // R reviews, i.e. (n+1)/(N+1) <= (r+1)/(R+1).
    const takeNew =
      n < newCards.length &&
      (r >= reviews.length || (n + 1) * (reviews.length + 1) <= (r + 1) * (newCards.length + 1));
    mixed.push(takeNew ? newCards[n++] : reviews[r++]);
  }
  return [...queues.learning, ...mixed].slice(0, sessionSize);
}
