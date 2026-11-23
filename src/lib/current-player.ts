// The player this tab is signed in as (an account or a guest), from the auth
// state AuthProvider holds. Kept in memory only: it starts empty on every page
// load, is set once a session read has an answer, and is cleared on sign-out.
// Browser data that must belong to one player (the memorization outbox, audit
// M7) is tagged with it at the time it is written.

let currentPlayerId: string | null = null;

export function setCurrentPlayerId(id: string | null): void {
  currentPlayerId = id;
}

export function getCurrentPlayerId(): string | null {
  return currentPlayerId;
}
