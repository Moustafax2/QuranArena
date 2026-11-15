// Client-side round helpers for the game screen (audit H5).
import { ALREADY_ANSWERED_MESSAGE } from "../../../supabase/functions/_shared/multiplayer-rpc";

/**
 * The round's deadline on this device's clock. The server sends its own clock
 * with the deadline, so a device whose clock is off still counts down the
 * time the server will actually allow.
 */
export function localDeadline(
  deadlineAt: string | null | undefined,
  serverNow: string | null | undefined,
  clientNow: number
): number | null {
  const deadline = deadlineAt ? Date.parse(deadlineAt) : NaN;
  const server = serverNow ? Date.parse(serverNow) : NaN;
  if (!Number.isFinite(deadline) || !Number.isFinite(server)) return null;
  return clientNow + (deadline - server);
}

/** Whole seconds left before `deadline` (rounded up), never below 0. */
export function secondsLeft(deadline: number | null | undefined, now: number): number | null {
  if (deadline === null || deadline === undefined) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export interface AnswerState {
  answered: boolean;
  selected: string | null;
  error: string | null;
}

/**
 * The option buttons' state after a submission. A failed submission unlocks
 * the options so the player can try again; before, one network error locked
 * them for the rest of the round. Only "already answered" stays locked: the
 * server has the answer (an earlier try's response was lost).
 */
export function answerStateAfterSubmit(result: { ok: boolean; error?: string }, verseKey: string): AnswerState {
  if (result.ok || result.error === ALREADY_ANSWERED_MESSAGE) {
    return { answered: true, selected: verseKey, error: null };
  }
  return { answered: false, selected: null, error: result.error ?? "Failed to submit answer" };
}
