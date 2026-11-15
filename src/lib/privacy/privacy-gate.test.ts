import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import * as realReact from "react";
import type { ReactElement, ReactNode } from "react";
import { NextRequest } from "next/server";
import { loadWithMocks } from "@/lib/flashcard/api-routes.test";

// H6: a failed consent re-check used to replace the whole app with the consent
// form, unmounting a game or a review session mid-way. The repo has no DOM
// harness, so the real PrivacyGate runs with a minimal hook runtime in place of
// "react" (useState and useEffect only); JSX still goes through the real
// react/jsx-runtime. Each render calls the component and inspects what it
// returns: the children element itself (the app stays mounted) or the gate's
// <main> (the app is unmounted).
//
// The second half runs the real GET /api/privacy/consent route. It shows the
// line the gate relies on: every real "no consent" answer (missing, withdrawn,
// invalid or outdated receipt, underage) is a 200 reply that the gate applies
// exactly as before, and only an infrastructure failure is an error (503).

async function runCase(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`ok - ${name}`);
}

type Reply = { accepted: boolean; underage: boolean; signedIn: boolean; account: boolean };
type Step = Reply | Error;
type Listener = (event?: unknown) => void;

const accountOk: Reply = { accepted: true, underage: false, signedIn: true, account: true };
const accountNoConsent: Reply = { accepted: false, underage: false, signedIn: true, account: false };
const accountUnderage: Reply = { accepted: false, underage: true, signedIn: true, account: false };
const guestOk: Reply = { accepted: false, underage: false, signedIn: false, account: false };
// The 503 the route answers on an infrastructure failure, as consent-client reports it.
const unavailable = () => new Error("Privacy controls are temporarily unavailable. Please reload to try again.");
// What fetch() rejects with when the network is down.
const offline = () => new TypeError("Failed to fetch");

const GUEST_ACTIVITY_KEY = "quranarena_guest_last_activity";

function gateHarness(steps: Step[]) {
  const state: unknown[] = [];
  let effects: Array<() => void | (() => void)> = [];
  let cleanups: Array<() => void> = [];
  let mounted = false;
  let cursor = 0;
  const react = {
    ...realReact,
    useState<T>(initial: T) {
      const i = cursor++;
      if (!(i in state)) state[i] = initial;
      const set = (v: T | ((p: T) => T)) => { state[i] = typeof v === "function" ? (v as (p: T) => T)(state[i] as T) : v; };
      return [state[i] as T, set] as const;
    },
    useEffect(fn: () => void | (() => void)) { if (!mounted) effects.push(fn); },
  };
  const listeners = new Map<string, Listener[]>();
  const intervals: Array<() => void> = [];
  const g = globalThis as Record<string, unknown>;
  const savedWindow = g.window;
  g.window = {
    addEventListener: (t: string, f: Listener) => listeners.set(t, [...(listeners.get(t) ?? []), f]),
    removeEventListener: (t: string, f: Listener) => listeners.set(t, (listeners.get(t) ?? []).filter((x) => x !== f)),
    setInterval: (f: () => void) => intervals.push(f),
    clearInterval: () => {},
    setTimeout: (f: () => void) => { f(); return 0; },
    clearTimeout: () => {},
    location: { reload: () => {} },
  };
  let calls = 0;
  const guestChecks = { check: 0, touch: 0 };
  const consentChoice = () => null;
  const underageNotice = () => null;
  const mod = loadWithMocks<{ PrivacyGate: (p: { children: ReactNode }) => ReactNode }>(
    path.join(process.cwd(), "src/components/legal/PrivacyGate.tsx"),
    {
      react,
      "@/lib/privacy/consent-client": {
        fetchConsentStatus: async () => {
          const step = steps[Math.min(calls++, steps.length - 1)];
          if (step instanceof Error) throw step;
          return step;
        },
        saveConsent: async () => "accepted",
      },
      "@/lib/privacy/browser-storage": {
        checkGuestStorage: () => { guestChecks.check++; },
        touchGuestStorage: () => { guestChecks.touch++; },
        clearLearningStorage: () => {},
        LAST_ACTIVITY: GUEST_ACTIVITY_KEY,
      },
      // ConsentChoice pulls in next/link; the two leaf components are not under test.
      "./ConsentChoice": { ConsentChoice: consentChoice, UnderageNotice: underageNotice },
    },
  );
  const children = { type: "div", props: { id: "app" } } as unknown as ReactElement;
  const render = () => {
    cursor = 0;
    const out = mod.PrivacyGate({ children });
    if (!mounted) {
      mounted = true;
      const run = effects; effects = [];
      cleanups = run.map((f) => f()).filter((c): c is () => void => typeof c === "function");
    }
    return out;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** Runs one event, lets the check settle and renders again. */
  const after = async (fire: () => void) => { fire(); await flush(); return render(); };
  const fire = (t: string, event?: unknown) => (listeners.get(t) ?? []).forEach((f) => f(event));
  const storage = (key: string | null) => fire("storage", { key });
  const tick = () => intervals.forEach((f) => f());
  const done = () => { cleanups.forEach((c) => c()); g.window = savedWindow; };
  const elementsIn = (node: unknown): ReactElement[] => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(elementsIn);
    const el = node as ReactElement<{ children?: unknown }>;
    return [el, ...elementsIn(el.props?.children)];
  };
  const view = (out: ReactNode) => {
    if (out === children) return "app";
    const els = elementsIn(out);
    if ((out as ReactElement)?.type !== "main") return `unexpected <${String((out as ReactElement)?.type)}>`;
    if (els.some((e) => e.type === underageNotice)) return "underage notice";
    if (els.some((e) => e.type === consentChoice)) return "consent form";
    return "loading";
  };
  const alertText = (out: ReactNode) => {
    const alert = elementsIn(out).find((e) => (e.props as { role?: string }).role === "alert");
    return alert ? String((alert.props as { children?: unknown }).children) : "";
  };
  return { render, flush, after, fire, storage, tick, done, view, alertText, calls: () => calls, guestChecks };
}

/** Mounts the gate, settles the first check and returns the harness and the first view. */
async function mount(steps: Step[]) {
  const h = gateHarness(steps);
  h.render();
  await h.flush();
  return { h, first: h.view(h.render()) };
}

export async function runPrivacyGateTests() {
  await runCase("H6 (1): after a successful check, a failed re-check (503 or offline) keeps a signed-in user's app mounted, whether it came from focus, the 30 s timer or another tab", async () => {
    for (const failure of [unavailable, offline]) {
      const { h, first } = await mount([accountOk, failure(), failure(), failure()]);
      try {
        assert.equal(first, "app");
        assert.equal(h.view(await h.after(() => h.fire("focus"))), "app", `${failure().name}: the focus re-check unmounted the app`);
        assert.equal(h.view(await h.after(() => h.tick())), "app", `${failure().name}: the timer re-check unmounted the app`);
        assert.equal(h.view(await h.after(() => h.storage(null))), "app", `${failure().name}: the storage re-check unmounted the app`);
        assert.equal(h.calls(), 4);
      } finally { h.done(); }
    }
  });

  await runCase("H6 (1): a failed re-check never unlocks a gated user: an underage or no-consent screen stays up", async () => {
    for (const [reply, expected] of [[accountUnderage, "underage notice"], [accountNoConsent, "consent form"]] as const) {
      const { h, first } = await mount([reply, unavailable()]);
      try {
        assert.equal(first, expected);
        assert.equal(h.view(await h.after(() => h.fire("focus"))), expected);
      } finally { h.done(); }
    }
  });

  await runCase("H6 (2): after a successful check, a real answer that consent is missing, withdrawn or invalid, or that the user is underage, gates the app on that same re-check, also right after a failed one", async () => {
    for (const [reply, expected] of [[accountNoConsent, "consent form"], [accountUnderage, "underage notice"]] as const) {
      const { h, first } = await mount([accountOk, reply]);
      try {
        assert.equal(first, "app");
        assert.equal(h.view(await h.after(() => h.fire("focus"))), expected);
      } finally { h.done(); }
      const late = await mount([accountOk, unavailable(), reply]);
      try {
        assert.equal(late.h.view(await late.h.after(() => late.h.fire("focus"))), "app");
        assert.equal(late.h.view(await late.h.after(() => late.h.tick())), expected, "a failure must not latch the app open");
      } finally { late.h.done(); }
    }
  });

  await runCase("H6 (3): a failed first check behaves as before: the error is kept and shown on the consent form once a later reply asks for consent", async () => {
    for (const failure of [unavailable, offline]) {
      const { h, first } = await mount([failure(), accountNoConsent]);
      try {
        // Nothing is known yet, so signedIn is still false and the app shows, as on main.
        assert.equal(first, "app");
        const out = await h.after(() => h.fire("focus"));
        assert.equal(h.view(out), "consent form");
        assert.equal(h.alertText(out), failure().message);
      } finally { h.done(); }
    }
    for (const [reply, expected] of [[accountOk, "app"], [accountNoConsent, "consent form"], [accountUnderage, "underage notice"], [guestOk, "app"]] as const) {
      const { h, first } = await mount([reply]);
      try { assert.equal(first, expected); } finally { h.done(); }
    }
  });

  await runCase("H6 (4): a guest is unchanged: never asked for consent or age, the app stays mounted through failures, and each successful check still runs the 24 h expiry", async () => {
    for (const steps of [[guestOk, unavailable(), guestOk], [unavailable(), guestOk, offline()]]) {
      const { h, first } = await mount(steps);
      try {
        assert.equal(first, "app");
        assert.equal(h.view(await h.after(() => h.fire("focus"))), "app");
        assert.equal(h.view(await h.after(() => h.tick())), "app");
        assert.equal(h.guestChecks.check, steps.filter((s) => !(s instanceof Error)).length, "the guest expiry check runs on each successful guest check");
        h.fire("pointerdown");
        assert.equal(h.guestChecks.touch, 1, "guest activity still refreshes the expiry clock");
      } finally { h.done(); }
    }
  });

  await runCase("H6 (5): consent withdrawn in another tab (privacy controls clear() storage, a null key) re-checks at once and gates this tab", async () => {
    const { h, first } = await mount([accountOk, accountNoConsent]);
    try {
      assert.equal(first, "app");
      h.storage(null);
      assert.equal(h.calls(), 2, "the re-check starts synchronously in the storage event, with no added delay");
      await h.flush();
      assert.equal(h.view(h.render()), "consent form");
    } finally { h.done(); }
  });

  await runCase("H6: consent saved in another tab (the gate stamps the guest activity key) still re-checks this tab at once", async () => {
    const { h, first } = await mount([accountNoConsent, accountOk]);
    try {
      assert.equal(first, "consent form");
      h.storage(GUEST_ACTIVITY_KEY);
      assert.equal(h.calls(), 2);
      await h.flush();
      assert.equal(h.view(h.render()), "app");
    } finally { h.done(); }
  });

  await runCase("H6: study data written in another tab no longer triggers a consent check per write", async () => {
    const { h } = await mount([accountOk]);
    try {
      for (const key of ["qalamspace_flashcards_unsynced", "qalamspace_memorization_attempts", "flashcard_how_it_works_seen", "quran-bookmarks", "quran-game-review-ayahs:g1"]) h.storage(key);
      await h.flush();
      assert.equal(h.calls(), 1, "only the first check ran");
    } finally { h.done(); }
  });

  await runConsentRouteContractTests();
}

// --- The real GET /api/privacy/consent route --------------------------------

const SECRET = "h6-test-secret-not-used-anywhere-else-0123456789";
const consentRoute = path.join(process.cwd(), "src/app/api/privacy/consent/route.ts");
const serverDeps = ["src/lib/privacy/consent.ts", "src/lib/privacy/account.ts"].map((f) => path.join(process.cwd(), f));
const requireHere = createRequire(__filename);

type Row = Record<string, unknown>;
type Tables = { privacy_consents: Row[]; players: Row[] };

/** An in-memory admin client for the two reads the route makes (eq and is filters, maybeSingle). */
function memoryAdmin(tables: Tables, failing: Partial<Record<keyof Tables, boolean>> = {}) {
  return {
    from(table: keyof Tables) {
      const filters: Array<(row: Row) => boolean> = [];
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return builder; },
        is: (column: string, value: unknown) => { filters.push((row) => (row[column] ?? null) === value); return builder; },
        maybeSingle: async () => failing[table]
          ? { data: null, error: { message: "connection refused" } }
          : { data: tables[table].find((row) => filters.every((f) => f(row))) ?? null, error: null },
      };
      return builder;
    },
  };
}

type Session = { player_id: string; session_version: number };

async function getConsent(cookie: string | null, session: Session | null, tables: Tables, failing?: Partial<Record<keyof Tables, boolean>>) {
  const forget = () => serverDeps.forEach((f) => { delete requireHere.cache[f]; });
  forget();
  try {
    const route = loadWithMocks<{ GET(request: NextRequest): Promise<Response> }>(consentRoute, {
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => memoryAdmin(tables, failing) },
      "@/lib/qf-user/session": { readSessionCookie: async () => session },
      "@/lib/multiplayer/guest-session": { getGuestPlayer: async () => null },
      "@/lib/qf-user/config": { getQfClientId: () => "", getQfClientSecret: () => "", getQfDiscoveryDocument: async () => ({}), getQfIssuerBaseUrl: () => "" },
      "next/headers": { cookies: async () => ({ get: () => undefined }) },
    });
    const headers: Record<string, string> = cookie ? { cookie: `quranarena_privacy=${cookie}` } : {};
    const response = await route.GET(new NextRequest("https://app.test/api/privacy/consent", { headers }));
    return { status: response.status, body: await response.json() as Partial<Reply> & { error?: string } };
  } finally { forget(); }
}

async function runConsentRouteContractTests() {
  const savedSecret = process.env.QF_SESSION_SECRET;
  process.env.QF_SESSION_SECRET = SECRET;
  try {
    const { signPrivacyToken, CONSENT_VERSION } = await import("@/lib/privacy/tokens");
    const receiptId = "11111111-1111-4111-8111-111111111111";
    const valid = await signPrivacyToken("consent", { receiptId, eligible: true, religiousData: true, version: CONSENT_VERSION }, 3600);
    const oldVersion = await signPrivacyToken("consent", { receiptId, eligible: true, religiousData: true, version: "2020-01-01" }, 3600);
    const underage = await signPrivacyToken("consent", { eligible: false }, 3600);
    process.env.QF_SESSION_SECRET = "a-different-secret-so-this-token-is-forged-000";
    const forged = await signPrivacyToken("consent", { receiptId, eligible: true, religiousData: true, version: CONSENT_VERSION }, 3600);
    process.env.QF_SESSION_SECRET = SECRET;
    const session: Session = { player_id: "p1", session_version: 3 };
    const live = (over: Row = {}): Tables => ({
      privacy_consents: [{ id: receiptId, version: CONSENT_VERSION, player_id: "p1", withdrawn_at: null, ...over }],
      players: [{ id: "p1", session_version: 3 }],
    });

    await runCase("H6 route contract: a valid receipt for a signed-in account is a 200 answer with accepted true", async () => {
      const r = await getConsent(valid, session, live());
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.accepted, r.body.signedIn, r.body.account, r.body.underage], [true, true, true, false]);
    });

    await runCase("H6 route contract: every real \"no consent\" case is a 200 answer the gate applies at once, never an error the gate could treat as transient", async () => {
      const cases: Array<[string, string | null, Tables, Partial<Reply>]> = [
        ["no consent cookie", null, live(), { accepted: false, underage: false, signedIn: true }],
        ["a forged consent token", forged, live(), { accepted: false, underage: false, signedIn: true }],
        ["a token from an older consent version", oldVersion, live(), { accepted: false, signedIn: true }],
        ["a receipt withdrawn in privacy controls (withdraw_player_consent)", valid, live({ withdrawn_at: "2026-11-15T00:00:00Z" }), { accepted: false, signedIn: true }],
        ["a receipt row from an older consent version", valid, live({ version: "2020-01-01" }), { accepted: false, signedIn: true }],
        ["a receipt id that matches no row (deleted data)", valid, { privacy_consents: [], players: [] }, { accepted: false, signedIn: true }],
        ["a declared underage visitor", underage, live(), { accepted: false, underage: true, signedIn: true }],
        ["withdrawal plus a bumped session_version", valid, { privacy_consents: live({ withdrawn_at: "2026-11-15T00:00:00Z" }).privacy_consents, players: [{ id: "p1", session_version: 4 }] }, { accepted: false, signedIn: true, account: false }],
      ];
      for (const [label, cookie, tables, expected] of cases) {
        const r = await getConsent(cookie, session, tables);
        assert.equal(r.status, 200, `${label}: expected a 200 answer, got ${r.status}`);
        for (const [k, v] of Object.entries(expected)) assert.equal(r.body[k as keyof Reply], v, `${label}: ${k}`);
      }
    });

    await runCase("H6 route contract: a session_version bump alone (QF disconnect) is also a 200 answer, so the gate shows what it showed before H6", async () => {
      const r = await getConsent(valid, session, { privacy_consents: live().privacy_consents, players: [{ id: "p1", session_version: 4 }] });
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.accepted, r.body.account], [true, false]);
    });

    await runCase("H6 route contract: only an infrastructure failure is an error (503), the one case a re-check after success may now ride out", async () => {
      for (const failing of [{ privacy_consents: true }, { players: true }] as const) {
        const r = await getConsent(valid, session, live(), failing);
        assert.equal(r.status, 503, JSON.stringify(failing));
      }
    });
  } finally {
    if (savedSecret === undefined) delete process.env.QF_SESSION_SECRET; else process.env.QF_SESSION_SECRET = savedSecret;
  }
}
