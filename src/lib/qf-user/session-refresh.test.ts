import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { loadWithMocks } from "@/lib/flashcard/api-routes.test";

// H2: concurrent token refreshes signed users out. The real session code runs
// against a local fake of the QF token endpoint that ROTATES refresh tokens
// with no grace period (a reused refresh token gets invalid_grant), as the
// audit assumed. Nothing leaves the process: fetch is replaced for the run.
//
// A transient failure (network, timeout, QF 5xx, 408, 429) keeps the cookies
// and is answered with a temporary error; only a definitive one (a 4xx refusal
// such as invalid_grant, no refresh token, an invalidated session_version)
// signs the browser out and may be reported as an expired session (D1).

const repo = process.cwd();
const src = (p: string) => path.join(repo, "src", p);

type Mode = "rotate" | "network" | "5xx" | "408" | "429" | "401";
type Player = { id: string; session_version: number; display_name: string; avatar_url: null; total_points: number; total_wins: number };
type SessionMod = {
  writeSessionCookie: (s: { set: (n: string, v: string) => void }, session: unknown) => Promise<void>;
  readSessionCookie: () => Promise<{ refresh_token: string } | null>;
};
type Route = (request: Request) => Promise<Response>;

function setCookies(res: Response) {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

export async function runSessionRefreshTests() {
  const saved = { fetch: globalThis.fetch, secret: process.env.QF_SESSION_SECRET, error: console.error, now: Date.now };
  process.env.QF_SESSION_SECRET = "test-only-secret-never-use-in-production-123456";

  const tokenCalls: string[] = [];
  const tokenSignals: unknown[] = [];
  const live = new Set<string>();
  let issued = 0;
  let mode: Mode = "rotate";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url) !== "https://qf.test/oauth2/token") throw new Error(`unexpected fetch ${url}`);
    const token = new URLSearchParams(String(init.body)).get("refresh_token") ?? "";
    tokenCalls.push(token);
    tokenSignals.push(init.signal);
    await new Promise((r) => setTimeout(r, 5));
    if (mode === "network") throw new TypeError("fetch failed");
    if (mode === "5xx") return new Response("upstream unavailable", { status: 503 });
    if (mode === "408" || mode === "429") return new Response("try later", { status: Number(mode) });
    if (mode === "401") return new Response("unauthorized", { status: 401 });
    if (!live.delete(token)) return Response.json({ error: "invalid_grant", error_description: "reused" }, { status: 400 });
    const next = `rotated-${++issued}`;
    live.add(next);
    return Response.json({ access_token: `access-${issued}`, refresh_token: next, expires_in: 3600, token_type: "bearer" });
  }) as unknown as typeof fetch;

  const qfConfig = {
    getQfSessionSecret: () => process.env.QF_SESSION_SECRET,
    getQfDiscoveryDocument: async () => ({ issuer: "https://qf.test/", token_endpoint: "https://qf.test/oauth2/token", jwks_uri: "https://qf.test/jwks" }),
    getQfClientId: () => "client",
    getQfClientSecret: () => "secret",
    getQfCallbackUrl: () => "https://app.test/api/auth/callback",
    getQfIssuerBaseUrl: () => "https://qf.test",
  };
  const player: Player = { id: "player", session_version: 0, display_name: "Player", avatar_url: null, total_points: 0, total_wins: 0 };
  const row = (cols: string) => cols.trim() === "*"
    ? { ...player }
    : Object.fromEntries(cols.split(",").map((c) => [c.trim(), (player as Record<string, unknown>)[c.trim()]]));
  const admin = {
    createAdminSupabaseClient: () => ({
      from: () => ({ select: (cols: string) => ({ eq: () => ({ maybeSingle: async () => ({ data: row(cols), error: null }) }) }) }),
    }),
  };
  let jar = new Map<string, string>();
  const oidc = loadWithMocks(src("lib/qf-user/oidc.ts"), { "./config": qfConfig });
  const qfSession = loadWithMocks<SessionMod>(src("lib/qf-user/session.ts"), {
    "./config": qfConfig,
    "./oidc": oidc,
    "./user-profile": { getPlayerById: async () => ({ ...player }) },
    "@/lib/supabase/admin": admin,
    "@/lib/privacy/consent": {},
    "next/headers": { cookies: async () => ({ get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined) }) },
  });
  const resolver = loadWithMocks(src("lib/multiplayer/resolve-player.ts"), {
    "@/lib/qf-user/session": qfSession,
    "./guest-session": { getGuestPlayer: async () => null },
  });
  const createRoom = loadWithMocks<{ POST: Route }>(src("app/api/multiplayer/create-room/route.ts"), {
    "@/lib/multiplayer/resolve-player": resolver,
    "@/lib/qf-user/session": qfSession,
    "@/lib/multiplayer/server": { invokeSupabaseEdgeFunction: async () => ({ room_id: "room", code: "ABC123" }) },
    "@/lib/social/friends": { listAcceptedFriendQfUserIds: async () => [] },
    "@/lib/social/invitations": { createGameInvitations: async () => [] },
  });
  const sessionRoute = loadWithMocks<{ GET: Route }>(src("app/api/auth/qf/session/route.ts"), {
    "@/lib/qf-user/session": qfSession,
    "@/lib/qf-user/user-profile": { getPlayerById: async () => ({ ...player }) },
  });
  const stateRoute = loadWithMocks<{ GET: (r: NextRequest) => Promise<Response> }>(src("app/api/multiplayer/state/route.ts"), {
    "@/lib/multiplayer/resolve-player": resolver,
    "@/lib/supabase/admin": {
      createAdminSupabaseClient: () => ({ from: () => { const b: Record<string, unknown> = {}; for (const k of ["select", "eq", "order", "in"]) b[k] = () => b; b.maybeSingle = async () => ({ data: null, error: null }); return b; } }),
    },
  });
  // Flashcard routes with the real session code. The deck read returns an
  // empty deck; the reset route never reaches its database here.
  const emptyDeck = () => {
    const b: Record<string, unknown> = {};
    for (const k of ["select", "eq", "order", "range"]) b[k] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return b;
  };
  const flashcardCards = loadWithMocks<{ GET: Route }>(src("app/api/flashcards/cards/route.ts"), {
    "@/lib/qf-user/session": qfSession,
    "@/lib/supabase/admin": { createAdminSupabaseClient: () => ({ from: emptyDeck }) },
  });
  const flashcardReset = loadWithMocks<{ DELETE: Route }>(src("app/api/flashcards/reset/route.ts"), {
    "@/lib/qf-user/session": qfSession,
    "@/lib/supabase/admin": { createAdminSupabaseClient: () => { throw new Error("the database must not be reached"); } },
  });

  // expiresIn: the access token's remaining life. Under five minutes is inside
  // the refresh window; a negative value means it has already expired.
  async function signIn(refreshToken: string, expiresIn = 60_000, sessionVersion = 0) {
    live.add(refreshToken);
    jar = new Map();
    await qfSession.writeSessionCookie({ set: (n, v) => jar.set(n, v) }, {
      issued_at: Date.now() - 1000, session_version: sessionVersion, scopes: "openid offline_access user",
      access_token: "access-old", refresh_token: refreshToken, id_token: "id-token",
      expires_at: Date.now() + expiresIn, player_id: "player", user: { sub: "subject", email: null, name: "Player", avatar: null },
    });
  }
  async function browserSessionAfter(res: Response) {
    const set = setCookies(res);
    jar = new Map([...jar, ...Object.entries(set)].filter(([, v]) => v !== ""));
    if (set.qf_session === "") jar.delete("qf_session");
    return qfSession.readSessionCookie();
  }
  const callsFor = (t: string) => tokenCalls.filter((x) => x === t).length;
  const withCookie = (url: string, init: RequestInit = {}) =>
    new Request(url, { ...init, headers: { cookie: `qf_session=${jar.get("qf_session")}` } });
  const sessionGet = () => sessionRoute.GET(withCookie("https://app.test/api/auth/qf/session"));

  const failures: string[] = [];
  async function check(name: string, fn: () => Promise<void>) {
    mode = "rotate";
    player.session_version = 0;
    Date.now = saved.now;
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { failures.push(name); console.log(`not ok - ${name}: ${(e as Error).message}`); }
    finally { Date.now = saved.now; }
  }

  console.error = () => {};
  try {
    // ── The five Phase 3 reproduction cases ──────────────────────────────────
    await check("H2: create-room refreshes once per request and keeps the rotated tokens", async () => {
      await signIn("create-1");
      const res = await createRoom.POST(new Request("https://app.test/api/multiplayer/create-room", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ game_mode: "multiple-choice" }) }));
      assert.equal(callsFor("create-1"), 1, "create-room must refresh exactly once per request");
      assert.equal(res.status, 200);
      assert.ok(await browserSessionAfter(res), "create-room cleared the session cookie (user signed out)");
    });

    await check("H2: concurrent requests share one refresh", async () => {
      await signIn("parallel-1");
      const all = await Promise.all([sessionGet(), sessionGet(), sessionGet()]);
      const authed = await Promise.all(all.map(async (r) => (await r.clone().json()).isAuthenticated));
      assert.equal(callsFor("parallel-1"), 1, "concurrent requests must share one refresh");
      assert.deepEqual(authed, [true, true, true], "a concurrent request was signed out");
      for (const r of all) assert.ok(setCookies(r).qf_session, "a reply dropped the rotated tokens");
    });

    for (const m of ["network", "5xx"] as const) {
      await check(`H2: a ${m} error during refresh never clears the session`, async () => {
        await signIn(`transient-${m}`);
        mode = m;
        const res = await sessionGet();
        assert.notEqual(setCookies(res).qf_session, "", `${m}: cookies cleared while the access token is still valid`);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).isAuthenticated, true, `${m}: the still-valid access token was not used`);
      });
    }

    await check("H2: the state poll keeps the tokens it refreshed", async () => {
      await signIn("state-1");
      const res = await stateRoute.GET(new NextRequest("https://app.test/api/multiplayer/state?code=ABC123"));
      const set = setCookies(res);
      assert.equal(callsFor("state-1"), 1);
      assert.ok(set.qf_session, "the state route refreshed and threw the rotated tokens away");
    });

    // ── Transient failures once the access token has expired ─────────────────
    for (const m of ["network", "5xx", "408", "429"] as const) {
      await check(`H2: an expired access token and a ${m} refresh failure give the session route a 503, keep the cookies and never report sessionExpired`, async () => {
        await signIn(`expired-${m}`, -1000);
        mode = m;
        const res = await sessionGet();
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.isAuthenticated, false);
        assert.equal("sessionExpired" in body, false, "a transient failure was reported as an expired session");
        assert.equal(setCookies(res).qf_session, undefined, "the cookies were touched on a transient failure");
        // QF is back: the same cookie still works.
        mode = "rotate";
        const again = await sessionGet();
        assert.equal((await again.json()).isAuthenticated, true, "the session did not survive the outage");
      });
    }

    await check("H2: flashcard routes answer a transient refresh failure with a retryable 503, never SESSION_EXPIRED, and keep the cookies", async () => {
      await signIn("flashcard-transient", -1000);
      mode = "5xx";
      for (const res of [
        await flashcardCards.GET(withCookie("https://app.test/api/flashcards/cards")),
        await flashcardReset.DELETE(withCookie("https://app.test/api/flashcards/reset", { method: "DELETE" })),
      ]) {
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.notEqual(body.code, "SESSION_EXPIRED");
        assert.equal(typeof body.error, "string");
        assert.equal(setCookies(res).qf_session, undefined, "a flashcard route cleared the cookies on a transient failure");
      }
    });

    await check("H2: flashcard routes return the rotated tokens with their reply", async () => {
      await signIn("flashcard-rotate");
      const res = await flashcardCards.GET(withCookie("https://app.test/api/flashcards/cards"));
      assert.equal(res.status, 200);
      assert.equal(callsFor("flashcard-rotate"), 1);
      assert.ok(setCookies(res).qf_session, "the flashcard reply dropped the rotated tokens");
    });

    // ── Definitive failures still sign out (and D1 reports them) ─────────────
    const definitive: Array<[string, () => Promise<void>]> = [
      ["invalid_grant (revoked or reused refresh token)", async () => { await signIn("revoked-1", -1000); live.delete("revoked-1"); }],
      ["a bare 401 from the token endpoint", async () => { await signIn("bare-401", -1000); mode = "401"; }],
      ["a session_version mismatch (sessions ended elsewhere)", async () => { await signIn("version-1", -1000); player.session_version = 1; }],
    ];
    for (const [label, setup] of definitive) {
      await check(`H2: ${label} clears the cookies and the session route reports sessionExpired`, async () => {
        await setup();
        const res = await sessionGet();
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { isAuthenticated: false, user: null, player: null, sessionExpired: true });
        assert.equal(setCookies(res).qf_session, "", "the dead session's cookie was kept");
      });
      await check(`H2: ${label} gives the flashcard routes 401 SESSION_EXPIRED and clears the cookies`, async () => {
        await setup();
        const res = await flashcardCards.GET(withCookie("https://app.test/api/flashcards/cards"));
        assert.equal(res.status, 401);
        assert.equal((await res.json()).code, "SESSION_EXPIRED");
        assert.equal(setCookies(res).qf_session, "", "the dead session's cookie was kept");
      });
    }

    await check("H2: a request without a session cookie is still a plain guest 401 / unauthenticated reply", async () => {
      jar = new Map();
      const res = await flashcardCards.GET(new Request("https://app.test/api/flashcards/cards"));
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "Authentication required." });
      const session = await sessionRoute.GET(new Request("https://app.test/api/auth/qf/session"));
      assert.deepEqual(await session.json(), { isAuthenticated: false, user: null, player: null });
    });

    // ── The shared refresh: brief, same session only, failures not cached ────
    await check("H2: a finished refresh is shared only briefly; afterwards the spent token goes to QF", async () => {
      await signIn("reuse-1");
      const spent = jar.get("qf_session")!;
      const first = await sessionGet();
      assert.equal((await first.json()).isAuthenticated, true);
      // A request the browser had already sent with the old cookie.
      jar.set("qf_session", spent);
      assert.equal((await (await sessionGet()).json()).isAuthenticated, true, "an in-flight request was signed out");
      assert.equal(callsFor("reuse-1"), 1);
      // Well after the reuse window the spent token is refused by QF.
      const start = saved.now();
      Date.now = () => start + 60_000;
      jar.set("qf_session", spent);
      const late = await sessionGet();
      assert.equal(callsFor("reuse-1"), 2, "the spent token was still answered from the shared refresh");
      assert.equal((await late.json()).isAuthenticated, false);
    });

    await check("H2: a different session presenting the same refresh token never receives the shared tokens", async () => {
      await signIn("shared-1");
      // Same refresh token in a cookie for another QF subject.
      const otherJar = new Map<string, string>();
      await qfSession.writeSessionCookie({ set: (n, v) => otherJar.set(n, v) }, {
        issued_at: Date.now() - 1000, session_version: 0, scopes: "openid offline_access user",
        access_token: "access-x", refresh_token: "shared-1", id_token: "id-token",
        expires_at: Date.now() + 60_000, player_id: "player", user: { sub: "someone-else", email: null, name: "X", avatar: null },
      });
      const other = otherJar.get("qf_session")!;
      assert.equal((await (await sessionGet()).json()).isAuthenticated, true);
      jar.set("qf_session", other);
      const res = await sessionGet();
      assert.equal(callsFor("shared-1"), 2, "the other session was handed the shared refresh");
      assert.equal((await res.json()).isAuthenticated, false);
    });

    await check("H2: a failed refresh is not cached; the next request retries", async () => {
      await signIn("retry-1", -1000);
      mode = "5xx";
      assert.equal((await sessionGet()).status, 503);
      mode = "rotate";
      assert.equal((await (await sessionGet()).json()).isAuthenticated, true);
      assert.equal(callsFor("retry-1"), 2);
    });

    await check("H2: the token request has a timeout so a hung refresh can't hold the shared waiters", async () => {
      await signIn("timeout-1");
      await sessionGet();
      const signal = tokenSignals[tokenCalls.lastIndexOf("timeout-1")];
      assert.ok(signal instanceof AbortSignal, "the refresh request has no abort signal");
      const config = readFileSync("src/lib/qf-user/config.ts", "utf8");
      assert.match(config, /openid-configuration[\s\S]{0,200}signal: AbortSignal\.timeout\(/, "the discovery request has no timeout");
    });
  } finally {
    globalThis.fetch = saved.fetch;
    process.env.QF_SESSION_SECRET = saved.secret;
    console.error = saved.error;
    Date.now = saved.now;
  }

  await check("H2: the flashcard client treats a 503 from a flashcard route as a retryable error: never 'Sign in again', never a device write", async () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    const before = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    globalThis.fetch = (async () => Response.json({ error: "Your sign-in could not be checked right now. Please try again." }, { status: 503 })) as typeof fetch;
    const log = {
      id: "00000000-0000-4000-8000-000000000001", card_id: "c1", word_id: "w", rating: 3 as const, timestamp: new Date(),
      session_id: "00000000-0000-4000-8000-000000000002", state_before: 2, state_after: 2,
    };
    try {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      const expiry = await import("@/lib/flashcard/session-expiry");
      await assert.rejects(storage.saveReviewLog(log), (e: unknown) => e instanceof Error && !(e instanceof storage.SessionExpiredError));
      await assert.rejects(storage.getFlashcards(), (e: unknown) => e instanceof Error && !(e instanceof storage.SessionExpiredError));
      assert.equal(expiry.isSessionExpired(), false, "a 503 was recorded as an expired session");
      assert.equal(store.size, 0, "a 503 wrote to the device");
    } finally {
      g.window = before.window;
      g.localStorage = before.localStorage;
      globalThis.fetch = before.fetch;
    }
  });

  // ── Client: one shared auth state, re-read without request storms ──────────
  await check("H2: the client shares one session request (single flight) and re-reads once after a change", async () => {
    const mod = loadWithMocks<{
      createSingleFlight: <T>(run: () => Promise<T>) => { join(): Promise<T>; fresh(): Promise<T> };
      shouldRefreshAuthOnStorage: (key: string | null) => boolean;
    }>(src("lib/auth-refresh.ts"), {});
    let runs = 0;
    let release: () => void = () => {};
    let fail = false;
    const flight = mod.createSingleFlight(() => {
      runs++;
      const n = runs;
      return new Promise<number>((resolve, reject) => { release = () => (fail ? reject(new Error("offline")) : resolve(n)); });
    });
    const a = flight.join();
    const b = flight.join();
    assert.equal(runs, 1, "navigation and focus started a second request");
    const fresh1 = flight.fresh();
    const fresh2 = flight.fresh();
    release();
    assert.deepEqual([await a, await b], [1, 1]);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(runs, 2, "a change made during a request was not re-read once");
    release();
    assert.deepEqual([await fresh1, await fresh2], [2, 2]);
    fail = true;
    const failed = flight.join();
    release();
    await assert.rejects(failed);
    fail = false;
    const next = flight.join();
    assert.equal(runs, 4, "a failed request was kept");
    release();
    assert.equal(await next, 4);
    // Only a full clear() in another tab (privacy controls) re-reads the
    // session; study data written by other tabs does not.
    assert.equal(mod.shouldRefreshAuthOnStorage(null), true);
    assert.equal(mod.shouldRefreshAuthOnStorage("qalamspace_reviews"), false);
  });

  await check("H2: one AuthProvider holds the auth state, inside the privacy gate, and keeps sessionExpired and main's logout", async () => {
    const auth = readFileSync("src/lib/hooks/useAuth.ts", "utf8");
    assert.match(auth, /export function AuthProvider\(/);
    assert.match(auth, /useContext\(AuthContext\)/);
    assert.match(auth, /createSingleFlight\(loadSession\)/);
    assert.match(auth, /sessionExpired: payload\.sessionExpired,/);
    // A failed re-read (a 503 during a QF outage) keeps what is shown.
    assert.match(auth, /if \("unavailable" in payload\) \{\s*if \(answered\.current\) return;/);
    assert.match(auth, /forgetAccountSchedulerCopy\(\);[\s\S]*?window\.location\.href = "\/api\/auth\/qf\/logout";/);
    const providers = readFileSync("src/app/providers.tsx", "utf8");
    assert.match(providers, /<PrivacyGate><AuthProvider>/, "the session must still be fetched only inside the gate");
    assert.match(providers, /publicPage \? <AuthProvider>\{children\}<\/AuthProvider>/, "the Header on public pages needs the provider");
    assert.match(readFileSync("src/app/play/[roomId]/page.tsx", "utf8"), /phase === "game_over"\) void refresh\(\)/);
    assert.match(readFileSync("src/app/dev/auth/DevAuthClient.tsx", "utf8"), /await refresh\(\);/);
  });

  if (failures.length) throw new Error(`H2: ${failures.length} failing case(s): ${failures.join("; ")}`);
}
