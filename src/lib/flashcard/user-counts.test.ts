import assert from "node:assert/strict";
import type { FlashcardSession, UserFlashcard } from "@/lib/types/flashcard";
import { Rating, WordStatus } from "@/lib/types/flashcard";
import { createNewCard } from "@/lib/fsrs/scheduler";

// Counts the user reported after adding Al-Fatihah (docs/audit-fix-log.md,
// "User-reported flashcard counts"). Each was seen failing before its fix.

function newCard(i: number): UserFlashcard {
  return {
    id: `card-${i}`,
    word_id: `word-${i}`,
    status: WordStatus.IN_BANK,
    created_at: new Date(Date.now() + i),
    fsrs_state: createNewCard(),
  };
}

/** Runs `fn` as a known guest: card writes go to an in-memory localStorage. */
async function asGuest<T>(fn: () => Promise<T>): Promise<T> {
  const store = new Map<string, string>();
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
  g.window = globalThis;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
  try {
    return await fn();
  } finally {
    g.window = saved.window;
    g.localStorage = saved.localStorage;
    globalThis.fetch = saved.fetch;
  }
}

export async function runUserCountTests() {
  const { describeStudyLoad, getSessionProgress, reviewCard, isSessionComplete } = await import("./session-manager");

  // U1: after adding 20 words the hub's study tile said "0 cards due", though
  // a session had 20 new cards in it. It now names what a session will hold.
  {
    const fresh = describeStudyLoad({ due: 0, newCards: 20 });
    assert.equal(fresh.headline, "20 cards to study", "the study tile leaves the new cards out");
    assert.equal(fresh.detail, "20 new · 0 due");
    assert.equal(describeStudyLoad({ due: 3, newCards: 17 }).headline, "20 cards to study");
    assert.equal(describeStudyLoad({ due: 1, newCards: 0 }).headline, "1 card to study");
    assert.equal(describeStudyLoad({ due: 0, newCards: 0 }).headline, "Nothing to study now");
    console.log("ok - U1: the hub's study tile counts the new cards a session will show, not only the due ones");
  }

  // U2: a session of 20 new cards showed "0 / 20 cards" and grew to "20 / 40"
  // while answering, because each learning step was counted as another card.
  await asGuest(async () => {
    const cards = Array.from({ length: 20 }, (_, i) => newCard(i));
    let session: FlashcardSession = {
      id: "session-1",
      cards,
      current_index: 0,
      start_time: new Date(),
      algorithm: "fsrs",
      stats: { total_cards: 20, cards_reviewed: 0, new_cards: 20, review_cards: 0, again_count: 0, hard_count: 0, good_count: 0, easy_count: 0, total_time_ms: 0 },
    };
    const first = getSessionProgress(session);
    assert.equal(first.total, 20);
    assert.deepEqual(first.remaining, { new: 20, learning: 0, review: 0 });
    assert.equal(first.done, 0);
    let lastDone = 0;
    let answers = 0;
    while (!isSessionComplete(session) && answers < 100) {
      const current = session.cards[session.current_index];
      ({ updatedSession: session } = await reviewCard(session, current.id, Rating.Good));
      answers++;
      const progress = getSessionProgress(session);
      assert.equal(progress.total, 20, `after ${answers} answers the session claims ${progress.total} cards`);
      assert.ok(progress.done >= lastDone, "the finished count went backwards");
      assert.equal(progress.remaining.new + progress.remaining.learning + progress.remaining.review + progress.done, 20);
      lastDone = progress.done;
      if (answers === 1) assert.deepEqual(progress.remaining, { new: 19, learning: 1, review: 0 });
    }
    assert.ok(answers > 20, "Good on a new card should leave it in learning for a second step");
    const end = getSessionProgress(session);
    assert.equal(end.done, 20);
    assert.equal(end.percentage, 100);
  });
  console.log("ok - U2: a session of 20 new cards stays 20 cards while learning steps repeat them, with Anki-style new/learning/review counts");

  // U3: with a database behind the code (no migration 011), saving the
  // preferences fails, so the sign-in upload never finished. It ran again on
  // every hub visit and each run sent the device's old cards, which reset the
  // account's studied cards to new. A finished step is no longer repeated.
  {
    const due = new Date(2026, 9, 29).toISOString();
    const local = [0, 1].map((i) => ({ ...newCard(i), created_at: due, fsrs_state: { ...createNewCard(), due } }));
    const store = new Map<string, string>([
      ["qalamspace_flashcards", JSON.stringify(local)],
      ["qalamspace_reviews", JSON.stringify([{ id: "r1", card_id: "card-0", word_id: "word-0", rating: 3, timestamp: due, session_id: "s", state_before: 0, state_after: 1 }])],
      ["qalamspace_preferences", JSON.stringify({ daily_new_cards_limit: 20 })],
    ]);
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    let prefsFail = true;
    const sent = { cards: 0, reviews: 0, prefs: 0 };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("/api/flashcards/cards") && init?.method === "PUT") sent.cards++;
      if (u.startsWith("/api/flashcards/reviews") && init?.method === "POST") sent.reviews++;
      if (u.startsWith("/api/flashcards/preferences") && init?.method === "PUT") {
        sent.prefs++;
        if (prefsFail) return Response.json({ error: "Could not save preferences." }, { status: 500 });
      }
      if (u.startsWith("/api/flashcards/preferences")) return Response.json(null);
      return Response.json(init?.method ? { ok: true } : []);
    }) as typeof fetch;
    const quiet = console.error;
    console.error = () => {};
    try {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      assert.equal(await storage.migrateFromLocalStorage(), false);
      assert.equal(await storage.migrateFromLocalStorage(), false);
      assert.equal(sent.cards, 1, "a retry sent the device's cards again, over the account's progress");
      assert.equal(sent.reviews, 1, "the reviews waited for the preferences, or were sent twice");
      assert.equal(sent.prefs, 2);
      prefsFail = false;
      assert.equal(await storage.migrateFromLocalStorage(), true);
      assert.equal(store.get("qalamspace_migrated_to_supabase"), "true");
      assert.deepEqual(sent, { cards: 1, reviews: 1, prefs: 3 });
      assert.equal(await storage.migrateFromLocalStorage(), false);
      assert.deepEqual(sent, { cards: 1, reviews: 1, prefs: 3 });
    } finally {
      console.error = quiet;
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
    console.log("ok - U3: a sign-in upload that fails part-way never sends the device's cards again over the account's progress");
  }
}
