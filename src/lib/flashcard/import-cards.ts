// Cards read from a backup or from this browser's old local deck before they
// are uploaded (A4 review #5). Shapes that can be repaired without guessing
// at the user's progress are repaired; anything else is reported as skipped,
// so one damaged card neither fails the whole upload nor disappears silently.

import { CARD_STATUSES, isStorableCardBody, isSm2StateBody } from "@/lib/api-validation";
import { FSRSState, type FSRSCard, type SM2Card, type UserFlashcard, type WordStatus } from "@/lib/types/flashcard";

const NUMERIC_FSRS_FIELDS = ["stability", "difficulty", "elapsed_days", "scheduled_days", "learning_steps", "reps", "lapses"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDate(value: unknown): Date | null {
  if (!(typeof value === "string" || value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The card as the app stores it, or null when it can't be stored.
 *
 * Repaired: a missing or unknown FSRS `state` (a card with reviews becomes a
 * review card, one without stays new), FSRS counters that aren't numbers
 * (left out, as on states saved by older versions), a bad `last_review`
 * (left out), a missing or bad `created_at` (now), a missing status (in the
 * bank, the database default), a Classic state of the wrong shape (left
 * out, so the stored one is kept), and a missing id (a new one).
 *
 * Not repaired: no word id, an unknown status, or no FSRS state with a valid
 * `due` date. Making those up would invent the card or its schedule.
 */
export function normalizeImportedCard(raw: unknown, now = new Date()): UserFlashcard | null {
  if (!isRecord(raw) || !isRecord(raw.fsrs_state)) return null;
  if (typeof raw.word_id !== "string" || raw.word_id.length === 0) return null;
  const status = raw.status === undefined ? "IN_BANK" : raw.status;
  if (!(CARD_STATUSES as readonly unknown[]).includes(status)) return null;
  const due = toDate(raw.fsrs_state.due);
  if (!due) return null;

  const fsrs: Record<string, unknown> = { ...raw.fsrs_state, due };
  for (const field of NUMERIC_FSRS_FIELDS) {
    if (fsrs[field] !== undefined && !(typeof fsrs[field] === "number" && Number.isFinite(fsrs[field]))) delete fsrs[field];
  }
  const state = fsrs.state;
  if (!(typeof state === "number" && Number.isInteger(state) && state >= 0 && state <= 3)) {
    fsrs.state = typeof fsrs.reps === "number" && fsrs.reps > 0 ? FSRSState.Review : FSRSState.New;
  }
  const lastReview = toDate(fsrs.last_review);
  if (lastReview) fsrs.last_review = lastReview;
  else delete fsrs.last_review;

  let sm2: SM2Card | null | undefined;
  if (raw.sm2_state === null) sm2 = null;
  else if (isRecord(raw.sm2_state) && toDate(raw.sm2_state.due)) {
    const candidate = { ...raw.sm2_state, due: toDate(raw.sm2_state.due)!.toISOString() };
    sm2 = isSm2StateBody(candidate)
      ? { ...(raw.sm2_state as unknown as SM2Card), due: toDate(raw.sm2_state.due)!, last_review: toDate(raw.sm2_state.last_review) ?? undefined }
      : undefined;
  }

  const card: UserFlashcard = {
    // The app makes every card id with randomUUID; a card without one gets one.
    id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : crypto.randomUUID(),
    word_id: raw.word_id,
    status: status as WordStatus,
    fsrs_state: fsrs as unknown as FSRSCard,
    ...(sm2 !== undefined ? { sm2_state: sm2 } : {}),
    created_at: toDate(raw.created_at) ?? now,
    source_surah_id: typeof raw.source_surah_id === "number" ? raw.source_surah_id : null,
    source_ayah_number: typeof raw.source_ayah_number === "number" ? raw.source_ayah_number : null,
    source_juz_number: typeof raw.source_juz_number === "number" ? raw.source_juz_number : null,
    source_page_number: typeof raw.source_page_number === "number" ? raw.source_page_number : null,
  };

  // The same check the server applies, on the body it will receive.
  const body = {
    word_id: card.word_id,
    status: card.status,
    created_at: card.created_at.toISOString(),
    fsrs_state: { ...fsrs, due: due.toISOString(), last_review: lastReview?.toISOString() },
    ...(sm2 ? { sm2_state: { ...sm2, due: sm2.due.toISOString(), last_review: sm2.last_review?.toISOString() } } : {}),
  };
  return isStorableCardBody(body) ? card : null;
}
