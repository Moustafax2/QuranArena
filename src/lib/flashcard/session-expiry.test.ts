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
    // Each case is its own page view.
    (await import("@/lib/flashcard/session-expiry")).clearSessionExpired();
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

export async function runSessionRouteExpiryTests() {
  const { loadWithMocks } = await import("@/lib/flashcard/api-routes.test");
  type SessionRoute = { GET(request: Request): Promise<Response> };
  const load = (getUsableAccount: () => Promise<unknown>, cleared: string[]) =>
    loadWithMocks<SessionRoute>("../../app/api/auth/qf/session/route.ts", {
      "@/lib/qf-user/session": {
        getUsableAccount,
        writeSessionCookie: async () => {},
        clearQfCookies: () => void cleared.push("cleared"),
      },
      "@/lib/qf-user/user-profile": { getPlayerById: async () => null },
    });
  const request = (cookie?: string) =>
    new Request("https://app.test/api/auth/qf/session", cookie ? { headers: { cookie } } : undefined);
  const errors = console.error;

  await runCase("D1: the session route says when a sign-in cookie it had to clear was unusable; a transient failure is a 503, not an expiry (H2)", async () => {
    console.error = () => {};
    try {
      // No usable session (definitively over): signed out, and reported.
      const getUsableAccount = async () => null;
      const cleared: string[] = [];
      const expired = await load(getUsableAccount, cleared).GET(request("theme=dark; qf_session=stale-value"));
      assert.deepEqual(await expired.json(), { isAuthenticated: false, user: null, player: null, sessionExpired: true });
      assert.deepEqual(cleared, ["cleared"], "the unusable session's cookies are no longer cleared");

      // A guest (no cookie, or an already cleared one) gets main's reply unchanged.
      for (const guest of [request(), request("qf_session=; theme=dark")]) {
        const cookiesCleared: string[] = [];
        const reply = await load(getUsableAccount, cookiesCleared).GET(guest);
        assert.deepEqual(await reply.json(), { isAuthenticated: false, user: null, player: null });
        assert.deepEqual(cookiesCleared, ["cleared"]);
      }

      // H2: a lookup that throws is transient (QF or the database down). It is
      // a retryable 503 that keeps the cookies and is NOT an expired session.
      const failing = async () => { throw new Error("Could not verify account session."); };
      for (const cookie of ["theme=dark; qf_session=stale-value", undefined]) {
        const kept: string[] = [];
        const reply = await load(failing, kept).GET(request(cookie));
        assert.equal(reply.status, 503);
        const body = await reply.json();
        assert.equal(body.isAuthenticated, false);
        assert.equal("sessionExpired" in body, false, "a transient failure was reported as an expired session");
        assert.deepEqual(kept, [], "a transient failure cleared the cookies");
      }
    } finally {
      console.error = errors;
    }
  });
}

export async function runUseAuthExpiryTests() {
  const { readFileSync } = await import("node:fs");
  await runCase("D1: useAuth exposes sessionExpired and records it for the page view; a sign-in clears it", () => {
    const source = readFileSync("src/lib/hooks/useAuth.ts", "utf8");
    assert.match(source, /sessionExpired: boolean;/, "AuthState has no sessionExpired");
    assert.match(source, /sessionExpired\?: boolean;/, "the session response type has no sessionExpired");
    assert.match(source, /if \(parsed\.isAuthenticated\) clearSessionExpired\(\);\s*else if \(parsed\.sessionExpired === true\) noteSessionExpired\(\);/);
    assert.match(source, /const payload = \{ \.\.\.parsed, sessionExpired: isSessionExpired\(\) \};/);
    // The one shared state update (AuthProvider's apply, audit H2) carries it.
    assert.match(source, /const apply = useCallback\(\(payload[^)]*\) => \{[\s\S]*?sessionExpired: payload\.sessionExpired,/, "the shared state update doesn't pass it on");
    assert.match(source, /window\.location\.href = "\/api\/auth\/qf\/logout";/);
    assert.match(source, /fetch\("\/api\/multiplayer\/guest-token"/);
  });
}

export async function runPageViewExpiryTests() {
  const { readFileSync } = await import("node:fs");
  const log = {
    id: "00000000-0000-4000-8000-000000000001", card_id: "c1", word_id: "w", rating: 3 as const, timestamp: new Date(),
    session_id: "00000000-0000-4000-8000-000000000002", state_before: 2, state_after: 2,
  };

  await runCase("D1: once the page view found a lapsed sign-in, a guest-looking 401 never writes to the device", async () => {
    const expiry = await import("@/lib/flashcard/session-expiry");
    const store = new Map<string, string>();
    try {
      await withBrowser(store, (async () => GUEST()) as typeof fetch, async () => {
        const storage = await import("@/lib/storage/flashcard-storage-supabase");
        // useAuth (the Header's or the page's) saw sessionExpired from the session route.
        expiry.noteSessionExpired();
        await assert.rejects(storage.saveReviewLog(log), (e: unknown) => e instanceof storage.SessionExpiredError);
        await assert.rejects(storage.addFlashcards(JSON.parse(guestDeck).map((c: Record<string, unknown>) => ({ ...c, created_at: new Date(), fsrs_state: { ...(c.fsrs_state as object), due: new Date() } }))),
          (e: unknown) => e instanceof storage.SessionExpiredError);
        await assert.rejects(storage.getFlashcards(), (e: unknown) => e instanceof storage.SessionExpiredError, "the stale device copy was shown");
        assert.equal(store.size, 0, "something was written to the device");

        // A real guest's page view (nothing found) still uses this browser.
        expiry.clearSessionExpired();
        await storage.saveReviewLog(log);
        assert.equal(JSON.parse(store.get("qalamspace_reviews")!).length, 1);
      });

      // A flashcard request answered SESSION_EXPIRED records it for the later ones.
      const later = new Map<string, string>();
      let calls = 0;
      await withBrowser(later, (async () => (calls++ === 0 ? EXPIRED() : GUEST())) as typeof fetch, async () => {
        const storage = await import("@/lib/storage/flashcard-storage-supabase");
        await assert.rejects(storage.getFlashcards(), (e: unknown) => e instanceof storage.SessionExpiredError);
        await assert.rejects(storage.saveReviewLog(log), (e: unknown) => e instanceof storage.SessionExpiredError);
      });
      assert.equal(later.size, 0);
    } finally {
      expiry.clearSessionExpired();
    }
  });

  await runCase("D1: the flashcard pages show 'Sign in again' for a lapsed sign-in", () => {
    const hub = readFileSync("src/app/train/flashcards/page.tsx", "utf8");
    // The hub waits for the session before it loads, and starts nothing when it expired.
    assert.match(hub, /const \{[^}]*sessionExpired[^}]*\} = useAuth\(\);/);
    assert.match(hub, /useEffect\(\(\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(authLoading\) return;/, "the hub loads before the session is known");
    assert.match(hub, /if \(sessionExpired\) throw new SessionExpiredError\(\);/);
    assert.match(hub, /\}, \[authLoading, sessionExpired\]\);/);
    // Pages that write show the expired-session message rather than a generic one.
    for (const page of ["src/app/train/flashcards/intake/page.tsx", "src/app/train/flashcards/settings/page.tsx"]) {
      assert.match(readFileSync(page, "utf8"), /instanceof SessionExpiredError/, page);
    }
  });
}
