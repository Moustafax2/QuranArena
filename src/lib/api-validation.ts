// Small input checks for the API routes (audit L10). Each answers whether a
// value from a request has the shape the route stores or forwards; the route
// replies 400 when it doesn't, instead of failing later with a 500.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * A whole-number query parameter: `fallback` when it is absent, null when it
 * is not a plain whole number from `min` to `max` ("abc", "1.5", "-1").
 */
export function intParam(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null || value === "") return fallback;
  if (!/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/**
 * An FSRS card state as the client sends it (dates as ISO strings). `due` and
 * `state` are required; the numeric fields are checked when present, because
 * states saved by older versions lack some of them.
 */
export function isFsrsStateBody(value: unknown): boolean {
  if (!isRecord(value) || !isDateString(value.due) || !isIntegerIn(value.state, 0, 3)) return false;
  for (const key of ["stability", "difficulty", "elapsed_days", "scheduled_days", "learning_steps", "reps", "lapses"]) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) return false;
  }
  return value.last_review === undefined || value.last_review === null || isDateString(value.last_review);
}

/** A Classic (SM-2) state, or null (no Classic state). */
export function isSm2StateBody(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !isDateString(value.due)) return false;
  for (const key of ["interval", "repetitions", "easiness"]) if (!isFiniteNumber(value[key])) return false;
  for (const key of ["step", "lapses"]) if (value[key] !== undefined && !isFiniteNumber(value[key])) return false;
  if (value.phase !== undefined && !["learning", "review", "relearning"].includes(value.phase as string)) return false;
  return value.last_review === undefined || value.last_review === null || isDateString(value.last_review);
}

/** The card-state fields of a card body, where present, have valid shapes. */
export function hasValidCardStates(card: unknown): boolean {
  if (!isRecord(card)) return false;
  if (card.fsrs_state !== undefined && !isFsrsStateBody(card.fsrs_state)) return false;
  return card.sm2_state === undefined || isSm2StateBody(card.sm2_state);
}

/** The card statuses the user_flashcards check constraint allows (migration 002). */
export const CARD_STATUSES = ["IN_BANK", "KNOWN_NOT_IN_BANK", "UNKNOWN_SELECTED"] as const;

/**
 * A card the cards routes can store as sent: a word id, a known status, a
 * valid FSRS state, a valid Classic state if sent, and a date `created_at` if
 * sent. Anything else would fail the whole write in the database. The client
 * applies the same check before an import (A4 review #5).
 */
export function isStorableCardBody(card: unknown): boolean {
  return isRecord(card) &&
    typeof card.word_id === "string" && card.word_id.length > 0 &&
    (CARD_STATUSES as readonly unknown[]).includes(card.status) &&
    (card.created_at === undefined || isDateString(card.created_at)) &&
    hasValidCardStates(card) && isFsrsStateBody(card.fsrs_state);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A review the reviews route can store as sent: uuid ids, a word id, a 1-4
 * rating, a date, 0-3 states and a whole-number duration if sent (the
 * review_log columns and checks of migration 002). Anything else would fail
 * the whole batch in the database (code review of the flashcard port, #4).
 */
export function isStorableReviewBody(review: unknown): boolean {
  return isRecord(review) &&
    typeof review.id === "string" && UUID.test(review.id) &&
    typeof review.session_id === "string" && UUID.test(review.session_id) &&
    typeof review.word_id === "string" && review.word_id.length > 0 &&
    isIntegerIn(review.rating, 1, 4) &&
    isDateString(review.timestamp) &&
    isIntegerIn(review.state_before, 0, 3) && isIntegerIn(review.state_after, 0, 3) &&
    (review.review_duration_ms === undefined || review.review_duration_ms === null ||
      isIntegerIn(review.review_duration_ms, 0, 2147483647));
}

/** A verse bookmark: a surah number and an ayah number (no surah has more than 286). */
export function isBookmarkInput(value: unknown): value is { chapterId: number; verseNumber: number } {
  return isRecord(value) && isIntegerIn(value.chapterId, 1, 114) && isIntegerIn(value.verseNumber, 1, 286);
}

/** A QF bookmark id: a non-empty string of reasonable length. */
export function isBookmarkId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
