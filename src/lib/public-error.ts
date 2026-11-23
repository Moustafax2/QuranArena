/**
 * An error whose message was written for the user, so API routes may return
 * it. Anything else (database, upstream or configuration errors) stays on the
 * server (audit L11).
 */
export class PublicError extends Error {
  /** HTTP status a route should answer with, when the error implies one. */
  readonly status: number | null;
  /** A stable machine-readable reason (for example "already_answered"), when the source gives one (C-R2). */
  readonly code: string | null;

  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = "PublicError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The message an API route may send to the client for `error`: a PublicError's
 * own message, otherwise `fallback`. Other errors are logged here, on the
 * server, so their details aren't lost.
 */
export function clientErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PublicError) return error.message;
  console.error(fallback, error);
  return fallback;
}

/**
 * The status an API route answers `error` with: a PublicError's own 4xx (a
 * rule the request broke, such as "Room is full"), otherwise `fallback`. So a
 * rule violation is not reported as a server fault (C-R2).
 */
export function clientErrorStatus(error: unknown, fallback = 500): number {
  if (error instanceof PublicError && error.status !== null && error.status >= 400 && error.status < 500) {
    return error.status;
  }
  return fallback;
}
