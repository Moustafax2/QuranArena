import type { ReviewLogEntry, UserFlashcard } from "@/lib/types/flashcard";
import { FSRSState } from "@/lib/types/flashcard";
import { getDayStart, getQueueKind, type Algorithm } from "./queue";

/**
 * Consecutive study days with at least one review, counting today if it has
 * reviews and otherwise ending yesterday. Days roll over at the same 4am
 * boundary as the review queue, and are stepped by calendar day (setDate), so
 * 23- and 25-hour DST days are handled.
 */
export function calculateStreak(reviews: ReviewLogEntry[], now: Date = new Date()): number {
  if (reviews.length === 0) return 0;
  const reviewedDays = new Set(reviews.map((r) => getDayStart(new Date(r.timestamp)).getTime()));

  const cursor = getDayStart(now);
  // The streak survives until the end of the day after the last study day.
  if (!reviewedDays.has(cursor.getTime())) {
    cursor.setDate(cursor.getDate() - 1);
    if (!reviewedDays.has(cursor.getTime())) return 0;
  }

  let streak = 0;
  while (reviewedDays.has(cursor.getTime())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export interface DeckStats {
  newCards: number;
  learningCards: number;
  matureCards: number;
  retentionRate: number;
  forecast: { label: string; count: number }[];
  dueIn30: number;
  daysToLearnAll: number | null;
  avgInterval: number;
  reviewCardCount: number;
}

/** Ratings that count as remembered: Hard, Good and Easy (Hard is still a pass). Only Forgot is a miss. */
export function isPassRating(rating: number): boolean {
  return rating >= 2;
}

function isPass(review: ReviewLogEntry): boolean {
  return isPassRating(review.rating);
}

/**
 * The answers retention is measured on: the first answer to each review card
 * in each study day (Anki manual, Statistics: only a card's first review of
 * the day counts). Learning and relearning steps, and repeat answers later in
 * the day, are left out (verification D4).
 */
function retentionAnswers(reviews: ReviewLogEntry[]): ReviewLogEntry[] {
  const first = new Map<string, ReviewLogEntry>();
  for (const review of reviews) {
    if (review.state_before !== FSRSState.Review) continue;
    const at = new Date(review.timestamp);
    const key = `${review.card_id}@${getDayStart(at).getTime()}`;
    const seen = first.get(key);
    if (!seen || at.getTime() < new Date(seen.timestamp).getTime()) first.set(key, review);
  }
  return [...first.values()];
}

/**
 * Retention as a fraction (0..1) of the counted answers (see
 * retentionAnswers), or null when no answer counts yet.
 */
export function retentionFraction(reviews: ReviewLogEntry[]): number | null {
  const counted = retentionAnswers(reviews);
  return counted.length > 0 ? counted.filter(isPass).length / counted.length : null;
}

/**
 * Stats for the deck page, read from the active algorithm's state (Classic
 * cards use sm2_state; FSRS cards use fsrs_state). Days follow the queue's
 * 4am study day.
 */
export function computeDeckStats(
  cards: UserFlashcard[],
  reviews: ReviewLogEntry[],
  options: { dailyNewLimit: number; algorithm: Algorithm },
  now: Date = new Date()
): DeckStats {
  const { algorithm } = options;
  const kind = (c: UserFlashcard) => getQueueKind(c, algorithm);
  const due = (c: UserFlashcard) =>
    new Date(algorithm === "sm2" ? c.sm2_state!.due : c.fsrs_state.due).getTime();
  const interval = (c: UserFlashcard) => (algorithm === "sm2" ? c.sm2_state!.interval : c.fsrs_state.scheduled_days);
  // Mature means an interval of 21 days or more in both algorithms (Anki
  // manual, Statistics). FSRS stability only matches the interval at 90%
  // desired retention.
  const isMature = (c: UserFlashcard) => interval(c) >= 21;

  const newCards = cards.filter((c) => kind(c) === "new").length;
  const learningCards = cards.filter((c) => kind(c) === "learning").length;
  const reviewCards = cards.filter((c) => kind(c) === "review");
  const matureCards = reviewCards.filter(isMature).length;
  // Cards that have been studied, i.e. that have a due date for a review.
  const scheduled = cards.filter((c) => kind(c) !== "new");

  const retentionRate = (retentionFraction(reviews) ?? 0) * 100;

  const today = getDayStart(now);
  const dayAfter = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return d.getTime();
  };
  const forecast = Array.from({ length: 7 }, (_, i) => {
    // "Today" also counts overdue cards: they are due now.
    const from = i === 0 ? -Infinity : dayAfter(i);
    const to = dayAfter(i + 1);
    const count = scheduled.filter((c) => due(c) >= from && due(c) < to).length;
    return { label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : `+${i}d`, count };
  });
  const dueIn30 = scheduled.filter((c) => due(c) < dayAfter(30)).length;

  // null when no new cards are introduced per day (the limit is 0).
  const daysToLearnAll =
    newCards === 0 ? 0 : options.dailyNewLimit > 0 ? Math.ceil(newCards / options.dailyNewLimit) : null;

  const avgInterval =
    reviewCards.length > 0 ? Math.round(reviewCards.reduce((sum, c) => sum + interval(c), 0) / reviewCards.length) : 0;

  return {
    newCards, learningCards, matureCards, retentionRate, forecast, dueIn30, daysToLearnAll, avgInterval,
    reviewCardCount: reviewCards.length,
  };
}
