// Round timing rules, shared by the Next.js routes and the SQL deadline
// (audit H5). Plain TypeScript with no Deno or Node imports, so both runtimes
// and the Node tests load the same file.

// Keep in step with mp_time_per_question() in migration 014.
export const MIN_TIME_PER_QUESTION = 10;
export const MAX_TIME_PER_QUESTION = 120;
export const DEFAULT_TIME_PER_QUESTION = 30;

/**
 * Seconds a question runs for a room's stored settings: the same clamp as
 * mp_time_per_question() in migration 014, which enforces the deadline.
 */
export function effectiveTimePerQuestion(settings: unknown): number {
  const value = settings && typeof settings === "object" ? (settings as Record<string, unknown>).time_per_question : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIME_PER_QUESTION;
  return Math.round(Math.min(Math.max(value, MIN_TIME_PER_QUESTION), MAX_TIME_PER_QUESTION));
}
