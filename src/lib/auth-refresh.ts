// Request coalescing for the shared client auth state (audit H2). Kept out of
// the provider so it can be tested without a DOM.

export interface SingleFlight<T> {
  /** Shares the request in flight, or starts one. For navigation and focus. */
  join(): Promise<T>;
  /**
   * A result that reflects changes made before this call (a sign-in, a game
   * that just ended). If a request is in flight it may predate the change, so
   * this waits for it and then runs once more; every caller meanwhile shares
   * that one follow-up. At most one request runs at a time.
   */
  fresh(): Promise<T>;
}

export function createSingleFlight<T>(run: () => Promise<T>): SingleFlight<T> {
  let current: Promise<T> | null = null;
  let queued: Promise<T> | null = null;
  function start(): Promise<T> {
    const request = run();
    current = request;
    const settle = () => { if (current === request) current = null; };
    request.then(settle, settle);
    return request;
  }
  return {
    join: () => current ?? queued ?? start(),
    fresh() {
      if (queued) return queued;
      if (!current) return start();
      queued = current.then(() => undefined, () => undefined).then(() => {
        queued = null;
        return start();
      });
      return queued;
    },
  };
}

/**
 * Storage changes in another tab that can mean the account changed. This app
 * keeps no account marker in browser storage, so only a full clear() (privacy
 * controls withdrawal or deletion, reported with a null key) counts. Study
 * data is written all the time and is not one; returning to this tab (focus)
 * re-reads the session anyway.
 */
export function shouldRefreshAuthOnStorage(key: string | null): boolean {
  return key === null;
}

/** Give the other tab's change (and its requests) a moment to finish. */
export const AUTH_STORAGE_REFRESH_DELAY_MS = 1000;
