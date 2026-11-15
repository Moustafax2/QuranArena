import assert from "node:assert/strict";
import { DEFAULT_PREFERENCES } from "@/lib/types/flashcard";

// Phase 2 defect D1 (docs/flashcards-on-main-verification.md): a lapsed
// session must reach the flashcard pages as "Sign in again", never as a
// guest writing to this browser (audit M10). Each case was seen failing first.

async function runCase(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`ok - ${name}`);
}

const EXPIRED = () => Response.json({ error: "Your sign-in has expired.", code: "SESSION_EXPIRED" }, { status: 401 });
const GUEST = () => Response.json({ error: "Authentication required." }, { status: 401 });

async function withBrowser<T>(store: Map<string, string>, fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch, error: console.error };
  g.window = globalThis;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  globalThis.fetch = fetchImpl;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    g.window = saved.window;
    g.localStorage = saved.localStorage;
    globalThis.fetch = saved.fetch;
    console.error = saved.error;
  }
}

const guestDeck = JSON.stringify([{
  id: "local-1", word_id: "w1", status: "IN_BANK", created_at: "2026-10-01T00:00:00.000Z",
  fsrs_state: { due: "2026-10-01T00:00:00.000Z", stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0 },
}]);

export async function runSessionExpiryTests() {
  await runCase("D1: an expired session found by the sign-in upload's first request reaches the page", async () => {
    // Only the first request still carries the cookie; the session route has
    // cleared it before the later ones, which then look like a guest's.
    const store = new Map<string, string>([
      ["qalamspace_algorithm", "sm2"],
      ["qalamspace_flashcards", guestDeck],
      ["qalamspace_preferences", JSON.stringify(DEFAULT_PREFERENCES)],
    ]);
    const before = JSON.stringify([...store]);
    let calls = 0;
    await withBrowser(store, (async () => (calls++ === 0 ? EXPIRED() : GUEST())) as typeof fetch, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      await assert.rejects(storage.migrateFromLocalStorage(), (e: unknown) => e instanceof storage.SessionExpiredError);
    });
    assert.equal(JSON.stringify([...store]), before, "the browser's storage changed during an expired session");
  });

  await runCase("D1: an expired session during the upload's card or review step is not turned into a generic failure", async () => {
    const store = new Map<string, string>([["qalamspace_flashcards", guestDeck]]);
    await withBrowser(store, (async (url: string, init?: RequestInit) => {
      if (url === "/api/flashcards/cards" && (init?.method ?? "GET") === "GET") return Response.json([]);
      return EXPIRED();
    }) as typeof fetch, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      await assert.rejects(storage.migrateFromLocalStorage(), (e: unknown) => e instanceof storage.SessionExpiredError);
      await assert.rejects(storage.importData(JSON.stringify({ flashcards: JSON.parse(guestDeck) })), (e: unknown) => e instanceof storage.SessionExpiredError);
    });
    assert.equal(store.get("qalamspace_migrated_cards"), undefined);
    assert.equal(store.get("qalamspace_migrated_to_supabase"), undefined);
  });
}
