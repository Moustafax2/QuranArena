// Whether this page view found a lapsed sign-in (audit M10, Phase 2 D1).
//
// Main's session route signs a browser with an unusable session out (it
// clears the cookie) and now says so with `sessionExpired`. Only the first
// requests of the page view can see that, so whichever of them does (useAuth,
// or a flashcard request answered SESSION_EXPIRED) records it here. For the
// rest of the page view the flashcard storage then reports "Sign in again"
// instead of falling back to this browser's storage. It is held in memory
// only: nothing is stored, and a new page load (or a successful sign-in)
// starts over, after which the browser is a plain guest by main's rules.

let expired = false;

export function noteSessionExpired(): void {
  expired = true;
}

export function clearSessionExpired(): void {
  expired = false;
}

export function isSessionExpired(): boolean {
  return expired;
}
