import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Audit M7: memorization attempts saved while the server failed went to a
// device copy that is uploaded only once per player, so they were hidden and
// never uploaded. The fix keeps them in an outbox that each load retries,
// tagged with the player signed in when they were made (never uploaded to or
// shown to anyone else), and queues only failures that can pass: a refused
// save (a 400, or main's 403 CONSENT_REQUIRED) is reported, not retried.

const ROOT = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const failures: string[] = [];

async function runCase(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}`);
    console.log(`  ${error instanceof Error ? error.message.split("\n").join("\n  ") : String(error)}`);
  }
}

type Row = Record<string, unknown>;
type Respond = (method: string, rows: Row[]) => Response | Promise<Response>;

const OUTBOX = "qalamspace_memorization_outbox";
const DEVICE_ATTEMPTS = "qalamspace_memorization_attempts";
const DAY = 86_400_000;

/**
 * A Storage stand-in whose items are its own enumerable properties, like a
 * browser's, so main's clearLearningStorage (which walks Object.keys) sees them.
 */
function browserStorage() {
  const storage = {} as Record<string, unknown>;
  const hidden = (name: string, value: unknown) => Object.defineProperty(storage, name, { value, enumerable: false });
  hidden("getItem", (k: string) => (Object.hasOwn(storage, k) ? String(storage[k]) : null));
  hidden("setItem", (k: string, v: string) => { storage[k] = String(v); });
  hidden("removeItem", (k: string) => { delete storage[k]; });
  hidden("key", (i: number) => Object.keys(storage)[i] ?? null);
  hidden("clear", () => { for (const k of Object.keys(storage)) delete storage[k]; });
  Object.defineProperty(storage, "length", { get: () => Object.keys(storage).length, enumerable: false });
  return storage as unknown as Storage & Record<string, string>;
}

/**
 * A browser and a fake /api/memorization/attempts. GET answers as `player`
 * (null: no account or guest session, a 401). Writes go through `respond`,
 * which by default stores the rows by player and client_attempt_id (the
 * server's upsert key). `setCurrentPlayerId` stands in for AuthProvider.
 */
async function withAttemptsBrowser(fn: (env: {
  local: Storage & Record<string, string>;
  server: Map<string, Row>;
  writes: Array<{ method: string; rows: Row[] }>;
  setPlayer(id: string | null): void;
  respondWith(respond: Respond | null): void;
  storage: typeof import("@/lib/memorization/storage");
  setCurrentPlayerId(id: string | null): void;
}) => Promise<void>) {
  const local = browserStorage();
  const server = new Map<string, Row>();
  const writes: Array<{ method: string; rows: Row[] }> = [];
  let player: string | null = "p1";
  let respond: Respond | null = null;
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g.window, localStorage: g.localStorage, sessionStorage: g.sessionStorage, fetch: globalThis.fetch };
  g.window = globalThis;
  g.localStorage = local;
  g.sessionStorage = browserStorage();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    assert.equal(url, "/api/memorization/attempts");
    const method = init?.method ?? "GET";
    if (player === null) return new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 });
    if (method === "GET") {
      const attempts = [...server.values()]
        .filter((a) => a.player === player)
        .map((a, i) => ({ id: `srv-${i}`, ...a, player: undefined }));
      return new Response(JSON.stringify({ player_id: player, attempts }), { status: 200 });
    }
    if (method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    const body = JSON.parse(String(init?.body));
    const rows = (Array.isArray(body) ? body : [body]) as Row[];
    writes.push({ method, rows });
    if (respond) {
      const response = await respond(method, rows);
      if (!response.ok) return response;
    }
    for (const row of rows) server.set(`${player}|${row.client_attempt_id}`, { ...row, player });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const identity = await import("@/lib/current-player");
  const storage = await import("@/lib/memorization/storage");
  identity.setCurrentPlayerId(null);
  try {
    await fn({
      local, server, writes, storage,
      setPlayer: (id) => { player = id; },
      respondWith: (r) => { respond = r; },
      setCurrentPlayerId: identity.setCurrentPlayerId,
    });
  } finally {
    identity.setCurrentPlayerId(null);
    g.window = saved.window;
    g.localStorage = saved.localStorage;
    g.sessionStorage = saved.sessionStorage;
    globalThis.fetch = saved.fetch;
  }
}

/** Signs `id` in on both sides: the server's cookie and AuthProvider's state. */
function signIn(env: { setPlayer(id: string | null): void; setCurrentPlayerId(id: string | null): void }, id: string | null) {
  env.setPlayer(id);
  env.setCurrentPlayerId(id);
}

const attemptInput = (ayah: number) => ({
  mode: "ayah" as const, verse_key: `2:${ayah}`, surah_id: 2, rating_level: 1 as const,
  tested_at: new Date(Date.UTC(2026, 9, 28, 10, ayah)),
});

const serverError = () => new Response("Could not save the memorization attempt.", { status: 500 });

type StoredEntry = { owner: unknown; attempt: { client_attempt_id: string } };
const outboxEntries = (local: Storage) => JSON.parse(local.getItem(OUTBOX) ?? "[]") as StoredEntry[];
const outboxIds = (local: Storage) => outboxEntries(local).map((e) => e.attempt.client_attempt_id);

function outboxEntry(owner: unknown, id: string, extra: Row = {}, queuedAt = Date.now()) {
  return {
    owner, queued_at: queuedAt,
    attempt: { client_attempt_id: id, mode: "ayah", rating_level: 1, verse_key: "2:1", surah_id: 2, ayah_number: 1, juz_number: null,
      page_number: null, selection_type: null, cover_region: null, tested_at: new Date(queuedAt).toISOString(), ...extra },
  };
}

async function runOutageTests() {
  await runCase("M7: an attempt saved during an outage is uploaded on the next load and stays visible", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, server, writes, storage, respondWith } = env;
      // The first sign-in migration has already run for this player.
      local.setItem("qalamspace_memorization_synced_v1:p1", "true");
      signIn(env, "p1");
      const before = await storage.saveMemorizationAttempt(attemptInput(4));

      respondWith(serverError);
      const during = await storage.saveMemorizationAttempt(attemptInput(5));
      assert.equal(server.has(`p1|${during.client_attempt_id}`), false);

      // Still down: the attempt is shown, and nothing is lost.
      const whileDown = await storage.getMemorizationAttempts();
      assert.deepEqual(whileDown.map((a) => a.client_attempt_id), [before.client_attempt_id, during.client_attempt_id],
        "the outage attempt is hidden while the server is down");

      respondWith(null);
      const afterOutage = await storage.getMemorizationAttempts();
      assert.deepEqual(afterOutage.map((a) => a.client_attempt_id), [before.client_attempt_id, during.client_attempt_id],
        "the outage attempt is hidden once the server answers");
      assert.equal(server.has(`p1|${during.client_attempt_id}`), true, "the outage attempt was never uploaded");
      assert.deepEqual(outboxIds(local), [], "a flushed attempt is still pending");

      // Flushed: later loads read it from the server and send nothing more.
      const writesBefore = writes.length;
      const later = await storage.getMemorizationAttempts();
      assert.deepEqual(later.map((a) => a.client_attempt_id), [before.client_attempt_id, during.client_attempt_id]);
      assert.equal(writes.length, writesBefore, "an already-flushed attempt was sent again");
    });
  });

  await runCase("M7: a retried upload never duplicates an attempt, and another account's pending attempt stays put", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, server, storage, respondWith } = env;
      local.setItem("qalamspace_memorization_synced_v1:p1", "true");
      local.setItem("qalamspace_memorization_synced_v1:p2", "true");
      signIn(env, "p1");
      await storage.getMemorizationAttempts();

      respondWith(serverError);
      const a = await storage.saveMemorizationAttempt(attemptInput(7));
      // The server got it but the reply was lost: it is on both sides now.
      server.set(`p1|${a.client_attempt_id}`, { client_attempt_id: a.client_attempt_id, mode: "ayah", rating_level: 1, verse_key: "2:7",
        surah_id: 2, tested_at: a.tested_at.toISOString(), player: "p1" });
      const both = await storage.getMemorizationAttempts();
      assert.equal(both.filter((x) => x.client_attempt_id === a.client_attempt_id).length, 1, "the attempt is listed twice");

      // Account p2 signs in on this browser: p1's pending attempt is neither sent nor shown.
      const b = await storage.saveMemorizationAttempt(attemptInput(9));
      respondWith(null);
      signIn(env, "p2");
      const asP2 = await storage.getMemorizationAttempts();
      assert.equal(asP2.some((x) => x.client_attempt_id === b.client_attempt_id), false, "p1's attempt is shown to p2");
      assert.equal(server.has(`p2|${b.client_attempt_id}`), false, "p1's attempt was uploaded to p2");

      signIn(env, "p1");
      const asP1 = await storage.getMemorizationAttempts();
      assert.equal(server.has(`p1|${b.client_attempt_id}`), true, "p1's attempt was not uploaded when p1 came back");
      assert.equal(asP1.filter((x) => x.client_attempt_id === b.client_attempt_id).length, 1);
    });
  });
}

async function runOwnerTests() {
  await runCase("A4R1: a failed save belongs to the player signed in when it was made, not the last one loaded", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, server, storage, respondWith } = env;
      local.setItem("qalamspace_memorization_synced_v1:p1", "true");
      local.setItem("qalamspace_memorization_synced_v1:p2", "true");
      // p1 loads the page, then signs out; p2 signs in and saves during an
      // outage before the memorization page has loaded anything as p2.
      signIn(env, "p1");
      await storage.getMemorizationAttempts();
      signIn(env, "p2");
      respondWith(serverError);
      const saved = await storage.saveMemorizationAttempt(attemptInput(5));
      respondWith(null);
      assert.deepEqual(outboxEntries(local).map((e) => e.owner), ["p2"], "the pending attempt is not tagged with its player");

      // p1 comes back first: the attempt is neither sent to p1 nor shown to p1.
      signIn(env, "p1");
      const asP1 = await storage.getMemorizationAttempts();
      assert.equal(server.has(`p1|${saved.client_attempt_id}`), false, "p2's attempt was uploaded to p1");
      assert.equal(asP1.some((a) => a.client_attempt_id === saved.client_attempt_id), false, "p2's attempt is shown to p1");

      signIn(env, "p2");
      await storage.getMemorizationAttempts();
      assert.equal(server.has(`p2|${saved.client_attempt_id}`), true, "p2's attempt was not uploaded to p2");
    });
  });

  await runCase("A4R1: with no signed-in player a failed save is reported, not queued without an owner", async () => {
    await withAttemptsBrowser(async ({ local, storage, respondWith }) => {
      respondWith(serverError);
      await assert.rejects(storage.saveMemorizationAttempt(attemptInput(6)), /could not be saved/i, "the save was reported as saved");
      assert.equal(local.getItem(OUTBOX), null, "an ownerless attempt was queued");
    });
  });

  await runCase("A4R1: entries without a valid owner are never uploaded or shown, and are dropped", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, server, writes, storage } = env;
      local.setItem("qalamspace_memorization_synced_v1:p1", "true");
      local.setItem(OUTBOX, JSON.stringify([outboxEntry(null, "no-owner"), outboxEntry("", "empty-owner"), outboxEntry(7, "number-owner"), "junk"]));
      signIn(env, "p1");
      const shown = await storage.getMemorizationAttempts();
      assert.equal(shown.length, 0, "an ownerless entry is shown");
      assert.equal(server.size, 0, "an ownerless entry was uploaded");
      assert.deepEqual(writes, []);
      assert.equal(local.getItem(OUTBOX), null, "ownerless entries were kept");
    });
  });

  await runCase("A4R1 (main's AuthProvider): an answered session read sets the current player, a failed one does not, and sign-out clears it", () => {
    const source = read("src/lib/hooks/useAuth.ts");
    const apply = source.slice(source.indexOf("const apply = useCallback"));
    const applyBody = apply.slice(0, apply.indexOf("}, []);"));
    // The guest player is the payload's player too, so a guest's attempts are tagged with the guest.
    assert.match(applyBody, /if \("unavailable" in payload\) \{\s*if \(answered\.current\) return;\s*\} else \{\s*answered\.current = true;(?:\s*\/\/[^\n]*)*\s*setCurrentPlayerId\(payload\.player\?\.id \?\? null\);\s*\}/,
      "the current player is not set from an answered session read only");
    assert.equal(applyBody.match(/setCurrentPlayerId\(/g)?.length, 1, "a failed session read changes the current player");
    const logout = source.slice(source.indexOf("const logout = useCallback"));
    assert.match(logout.slice(0, logout.indexOf("}, []);")), /setCurrentPlayerId\(null\);[\s\S]*window\.location\.href = "\/api\/auth\/qf\/logout";/,
      "sign-out does not clear the current player");
    assert.match(source, /guestPlayer[\s\S]*return \{ \.\.\.payload, player: guestPlayer, isGuest: true \}/, "a guest session no longer carries the guest player");
  });

  await runCase("M7 privacy: after sign-out, the account's pending attempts never upload under the guest; a guest's never upload into an account", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, server, storage, respondWith } = env;
      for (const id of ["p1", "g1"]) local.setItem(`qalamspace_memorization_synced_v1:${id}`, "true");
      signIn(env, "p1");
      respondWith(serverError);
      const accountAttempt = await storage.saveMemorizationAttempt(attemptInput(11));
      respondWith(null);

      // Sign-out: the page reloads, AuthProvider starts empty and then finds a guest session.
      signIn(env, null);
      const signedOut = await storage.getMemorizationAttempts();
      assert.equal(signedOut.some((a) => a.client_attempt_id === accountAttempt.client_attempt_id), false, "the account's attempt is shown signed out");
      signIn(env, "g1");
      const asGuest = await storage.getMemorizationAttempts();
      assert.equal(asGuest.some((a) => a.client_attempt_id === accountAttempt.client_attempt_id), false, "the account's attempt is shown to the guest");
      assert.equal(server.has(`g1|${accountAttempt.client_attempt_id}`), false, "the account's attempt was uploaded to the guest");
      // Kept, tagged with the account, until that account loads again (or the device is cleared).
      assert.deepEqual(outboxEntries(local).map((e) => [e.owner, e.attempt.client_attempt_id]), [["p1", accountAttempt.client_attempt_id]]);

      // The guest saves during an outage, then signs in to the account.
      respondWith(serverError);
      const guestAttempt = await storage.saveMemorizationAttempt(attemptInput(12));
      respondWith(null);
      signIn(env, "p1");
      const asAccount = await storage.getMemorizationAttempts();
      assert.equal(server.has(`p1|${guestAttempt.client_attempt_id}`), false, "the guest's pending attempt was uploaded into the account");
      assert.equal(asAccount.some((a) => a.client_attempt_id === guestAttempt.client_attempt_id), false, "the guest's attempt is shown to the account");
      assert.equal(server.has(`p1|${accountAttempt.client_attempt_id}`), true, "the account's own attempt was not uploaded on its return");
      assert.deepEqual(outboxEntries(local).map((e) => [e.owner, e.attempt.client_attempt_id]), [["g1", guestAttempt.client_attempt_id]]);
    });
  });

  await runCase("M7: a visitor with no account or guest session still keeps attempts on this device, as on main", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, storage } = env;
      signIn(env, null);
      const saved = await storage.saveMemorizationAttempt(attemptInput(13));
      assert.equal(local.getItem(OUTBOX), null, "a no-session attempt went to the outbox");
      assert.match(local.getItem(DEVICE_ATTEMPTS) ?? "", new RegExp(saved.client_attempt_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const shown = await storage.getMemorizationAttempts();
      assert.deepEqual(shown.map((a) => a.client_attempt_id), [saved.client_attempt_id]);
    });
  });
}

async function runPoisonTests() {
  await runCase("A4R2: one attempt the server always rejects no longer holds back the others, and is dropped in the end", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, server, storage, respondWith } = env;
      local.setItem("qalamspace_memorization_synced_v1:p1", "true");
      signIn(env, "p1");
      local.setItem(OUTBOX, JSON.stringify([
        outboxEntry("p1", "good-1"), outboxEntry("p1", "poison"), outboxEntry("p1", "refused"), outboxEntry("p1", "good-2"),
      ]));
      // "poison" fails on the server every time (a 500); "refused" is a permanent 400.
      respondWith((_method, rows) => {
        if (rows.some((r) => r.client_attempt_id === "refused")) return new Response("Invalid memorization attempt.", { status: 400 });
        if (rows.some((r) => r.client_attempt_id === "poison")) return serverError();
        return new Response("{}", { status: 200 });
      });
      await storage.getMemorizationAttempts();
      assert.equal(server.has("p1|good-1") && server.has("p1|good-2"), true, "the good attempts were held back by a bad one");
      assert.deepEqual(outboxIds(local), ["poison"], "the refused attempt was kept, or the poison one dropped too early");

      // Alone, it is never retried to death: that could be an outage.
      for (let i = 0; i < 10; i += 1) await storage.getMemorizationAttempts();
      assert.deepEqual(outboxIds(local), ["poison"]);

      // While other attempts get through, each failure counts, and it goes after the cap.
      let rounds = 0;
      while (outboxIds(local).includes("poison") && rounds < 20) {
        rounds += 1;
        respondWith((method, rows) => method === "POST" ? serverError() : rows.some((r) => r.client_attempt_id === "poison") ? serverError() : new Response("{}", { status: 200 }));
        await storage.saveMemorizationAttempt(attemptInput(10 + rounds));
        respondWith((_method, rows) => rows.some((r) => r.client_attempt_id === "poison") ? serverError() : new Response("{}", { status: 200 }));
        await storage.getMemorizationAttempts();
      }
      assert.ok(rounds >= 2 && rounds < 20, `the poison attempt was dropped after ${rounds} rounds`);
      assert.deepEqual(outboxIds(local), [], "an attempt was left behind");
    });
  });

  await runCase("A4R2: malformed or expired entries are dropped without being sent", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, writes, storage } = env;
      local.setItem("qalamspace_memorization_synced_v1:p1", "true");
      signIn(env, "p1");
      local.setItem(OUTBOX, JSON.stringify([
        outboxEntry("p1", "no-mode", { mode: undefined }),
        outboxEntry("p1", "bad-rating", { rating_level: 7 }),
        outboxEntry("p1", "bad-date", { tested_at: "yesterday-ish" }),
        outboxEntry("p1", "", {}),
        outboxEntry("p1", "too-old", {}, Date.now() - 31 * DAY),
        outboxEntry("p1", "fine"),
      ]));
      const shown = await storage.getMemorizationAttempts();
      assert.deepEqual(writes.flatMap((w) => w.rows.map((r) => r.client_attempt_id)), ["fine"]);
      assert.deepEqual(outboxIds(local), []);
      assert.deepEqual(shown.map((a) => a.client_attempt_id), ["fine"]);
    });
  });

  await runCase("A4R2: an outage keeps every pending attempt and uses up no tries", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, server, storage, respondWith } = env;
      local.setItem("qalamspace_memorization_synced_v1:p1", "true");
      signIn(env, "p1");
      local.setItem(OUTBOX, JSON.stringify([outboxEntry("p1", "a"), outboxEntry("p1", "b")]));
      respondWith(() => { throw new TypeError("Failed to fetch"); });
      for (let i = 0; i < 10; i += 1) await storage.getMemorizationAttempts();
      respondWith(() => new Response("Service unavailable", { status: 503 }));
      for (let i = 0; i < 10; i += 1) await storage.getMemorizationAttempts();
      assert.deepEqual(outboxIds(local), ["a", "b"]);
      respondWith(null);
      await storage.getMemorizationAttempts();
      assert.equal(server.has("p1|a") && server.has("p1|b"), true);
      assert.deepEqual(outboxIds(local), []);
    });
  });
}

async function runRefusalTests() {
  await runCase("A4R3: a save the server refuses (400, 403 CONSENT_REQUIRED, 404) is reported and never queued for retry", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, storage, respondWith } = env;
      signIn(env, "p1");
      const refusals: Array<[number, string, RegExp]> = [
        [400, JSON.stringify({ error: "Invalid memorization attempt." }), /Invalid memorization attempt/],
        // main's proxy answer for a signed-in request without a consent receipt
        [403, JSON.stringify({ error: "Age confirmation and privacy consent are required.", code: "CONSENT_REQUIRED" }), /consent are required/],
        [404, "Not found", /Not found/],
      ];
      for (const [status, body, message] of refusals) {
        respondWith(() => new Response(body, { status, headers: { "content-type": "application/json" } }));
        await assert.rejects(storage.saveMemorizationAttempt(attemptInput(status % 50)), message, `a ${status} was reported as saved`);
        assert.equal(local.getItem(OUTBOX), null, `a ${status} was queued for retry`);
        assert.equal(local.getItem(DEVICE_ATTEMPTS), null, `a ${status} was kept as a device attempt`);
      }
    });
  });

  await runCase("A4R3: only a network error, a 5xx, 408 or 429 is queued for retry", async () => {
    await withAttemptsBrowser(async (env) => {
      const { local, storage, respondWith } = env;
      signIn(env, "p1");
      const retryable: Array<[string, () => Response]> = [
        ["network", () => { throw new TypeError("Failed to fetch"); }],
        ["500", serverError], ["503", () => new Response("", { status: 503 })],
        ["408", () => new Response("", { status: 408 })], ["429", () => new Response("", { status: 429 })],
      ];
      const queued: string[] = [];
      for (const [i, [name, respond]] of retryable.entries()) {
        respondWith(respond);
        const saved = await storage.saveMemorizationAttempt(attemptInput(20 + i));
        queued.push(saved.client_attempt_id);
        assert.deepEqual(outboxIds(local), queued, `a ${name} failure was not queued`);
      }
    });
    const storage = await import("@/lib/memorization/storage") as { isRetryableStatus?: (status: number) => boolean };
    assert.equal(typeof storage.isRetryableStatus, "function", "there is no retryable-status rule");
    assert.deepEqual([400, 401, 403, 404, 409, 413, 422].filter(storage.isRetryableStatus!), []);
    assert.deepEqual([408, 429, 500, 502, 503, 504].filter((s) => !storage.isRetryableStatus!(s)), []);
  });

  await runCase("A4R3: the memorization tester shows a failed save instead of moving on", () => {
    const source = read("src/app/train/memorization-tester/MemorizationTester.tsx");
    assert.match(source, /saveError/, "the tester has no save-failure state");
    assert.match(source, /role="alert"[^>]*>\s*\{saveError\}/, "the save failure is not shown");
  });
}

async function runPrivacyTests() {
  await runCase("M7 privacy: the outbox key is learning data: the guest expiry, the export and withdraw/delete all cover it", async () => {
    const source = read("src/lib/memorization/storage.ts");
    const outboxKey = source.match(/const OUTBOX_KEY = "([^"]+)"/)?.[1];
    assert.equal(outboxKey, OUTBOX, "the outbox key moved");
    // Every browser key the memorization storage writes (string literals).
    const keys = [...source.matchAll(/["'`]((?:qalamspace|quranarena|memorization)_[a-z0-9_]+)["'`]/gi)].map((m) => m[1]);
    assert.ok(keys.includes(OUTBOX));
    const learningPattern = /^(quran|qalamspace|memorization|flashcard|fsrs|sm2)/i;
    for (const key of keys) assert.match(key, learningPattern, `${key} escapes the guest expiry and the export`);
    // The same pattern in main's guest-expiry wipe and the privacy controls' export.
    assert.match(read("src/lib/privacy/browser-storage.ts"), /\/\^\(quran\|qalamspace\|memorization\|flashcard\|fsrs\|sm2\)\/i/);
    const controls = read("src/app/privacy/controls/page.tsx");
    assert.match(controls, /\/\^\(quran\|qalamspace\|memorization\|flashcard\|fsrs\|sm2\)\/i\.test\(key\)/, "the export no longer uses the learning-data pattern");
    assert.match(controls, /localStorage\.clear\(\); sessionStorage\.clear\(\);/, "withdraw/delete no longer clear the device");
    // No player id outside the outbox entries: the current player stays in memory.
    assert.doesNotMatch(read("src/lib/current-player.ts"), /localStorage|sessionStorage|document\.cookie/);

    // Behaviour: the guest 24 h expiry and clearAllRecords both remove a pending attempt.
    await withAttemptsBrowser(async (env) => {
      const { local, storage, respondWith } = env;
      const { touchGuestStorage, LAST_ACTIVITY } = await import("@/lib/privacy/browser-storage");
      signIn(env, "g1");
      respondWith(serverError);
      await storage.saveMemorizationAttempt(attemptInput(30));
      assert.notEqual(local.getItem(OUTBOX), null);
      const now = Date.now();
      local.setItem(LAST_ACTIVITY, String(now - DAY));
      touchGuestStorage(now);
      assert.equal(local.getItem(OUTBOX), null, "the guest expiry left a pending attempt behind");

      await storage.saveMemorizationAttempt(attemptInput(31));
      assert.notEqual(local.getItem(OUTBOX), null);
      respondWith(null);
      await storage.clearAllRecords();
      assert.equal(local.getItem(OUTBOX), null, "clearing the memorization records left a pending attempt behind");
    });
  });
}

export async function runMemorizationOutboxTests() {
  await runOutageTests();
  await runOwnerTests();
  await runPoisonTests();
  await runRefusalTests();
  await runPrivacyTests();
  if (failures.length > 0) throw new Error(`${failures.length} memorization outbox case(s) failed: ${failures.join("; ")}`);
}
