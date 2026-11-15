/**
 * The single scheduling path used both to answer a card and to preview what
 * each rating button would do, so a preview always equals the real result.
 */

import type { FSRSParameters, Rating, UserFlashcard } from "@/lib/types/flashcard";
import { scheduleReviewWithParams } from "@/lib/fsrs/scheduler";
import { createNewSM2Card, scheduleSM2Review } from "@/lib/sm2/scheduler";
import type { Algorithm } from "./queue";

const RATINGS: Rating[] = [1, 2, 3, 4];

/** Returns the card as it would be after answering `rating` at `now`. */
export function scheduleCard(
  card: UserFlashcard,
  rating: Rating,
  algorithm: Algorithm,
  params: FSRSParameters,
  now: Date
): UserFlashcard {
  if (algorithm === "sm2") {
    const sm2State = scheduleSM2Review(card.sm2_state ?? createNewSM2Card(now), rating, now, {
      maximumInterval: params.maximum_interval,
    });
    return { ...card, sm2_state: sm2State };
  }
  // The card id seeds FSRS's interval fuzz, so the same card, rating and day
  // give the same interval whether previewed or answered.
  const { card: fsrsState } = scheduleReviewWithParams(card.fsrs_state, rating, params, now, card.id);
  return { ...card, fsrs_state: fsrsState };
}

/** Time from `now` until the card would next be due, per rating (ms). */
export function previewIntervals(
  card: UserFlashcard,
  algorithm: Algorithm,
  params: FSRSParameters,
  now: Date
): Record<Rating, number> {
  const result = {} as Record<Rating, number>;
  for (const rating of RATINGS) {
    const next = scheduleCard(card, rating, algorithm, params, now);
    const due = algorithm === "sm2" ? next.sm2_state!.due : next.fsrs_state.due;
    result[rating] = new Date(due).getTime() - now.getTime();
  }
  return result;
}

/** Short label for a button: "1m", "6m", "3h", "4d", "1.5mo", "1.1y". */
export function formatInterval(ms: number): string {
  const minutes = ms / 60000;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  // A day-based interval can be 23 or 25 hours (23.5 on Lord Howe) when it
  // spans a DST change; it is still one day. No learning step is that long.
  if (hours < 22) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30;
  if (months < 12) return `${Number(months.toFixed(1))}mo`;
  return `${Number((days / 365).toFixed(1))}y`;
}
