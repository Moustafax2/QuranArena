const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const Module = require("node:module");
require("tsx/cjs");
const { NextRequest } = require("next/server");

function loadWithMocks(file, mocks) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "server-only") return {};
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { delete require.cache[require.resolve(file)]; return require(file); }
  finally { Module._load = original; }
}

async function main() {
  process.env.QF_SESSION_SECRET = "test-only-secret-never-use-in-production-123456";
  const tokens = require("../src/lib/privacy/tokens.ts");
  const guest = await tokens.signPrivacyToken("guest", { playerId: "victim" }, 60);
  assert.equal((await tokens.verifyPrivacyToken(guest, "guest")).playerId, "victim");
  assert.equal(await tokens.verifyPrivacyToken(guest, "consent"), null);
  assert.equal(await tokens.verifyPrivacyToken(guest.slice(0,-6) + "AAAAAA", "guest"), null);
  assert.equal(await tokens.verifyPrivacyToken(await tokens.signPrivacyToken("guest", {}, -1), "guest"), null);
  assert.equal(await tokens.verifyPrivacyToken("unsigned-player-id", "guest"), null);
  const consent = await tokens.signPrivacyToken("consent", { version: tokens.CONSENT_VERSION, eligible: true, religiousData: true }, 60);
  assert.equal(await tokens.hasPrivacyConsent(consent), true);
  assert.equal(await tokens.hasPrivacyConsent(await tokens.signPrivacyToken("consent", { version: "old", eligible: true, religiousData: true }, 60)), false);
  assert.equal(await tokens.hasPrivacyConsent(await tokens.signPrivacyToken("consent", { version: tokens.CONSENT_VERSION, eligible: false, religiousData: true }, 60)), false);
  let verifiedGuest = null;
  const resolver = loadWithMocks("../src/lib/multiplayer/resolve-player.ts", {
    "@/lib/qf-user/session": { getUsableSession: async () => null },
    "./guest-session": { getGuestPlayer: async () => verifiedGuest },
  });
  const forged = new Request("https://app.test/api/progress", { headers: { "X-Guest-Player-Id": "victim", cookie: "qalamspace_guest_player_id=victim" } });
  assert.equal(await resolver.resolvePlayerId(forged), null);
  verifiedGuest = { id: "actual-owner" };
  assert.equal(await resolver.resolvePlayerId(forged), "actual-owner");
  let active = false;
  const { proxy } = loadWithMocks("../src/proxy.ts", {
    "@/lib/privacy/consent": { getConsentReceipt: async () => active ? { id: "receipt" } : null },
  });
  assert.equal((await proxy(new NextRequest("https://app.test/api/progress"))).status, 403);
  assert.equal((await proxy(new NextRequest("https://app.test/api/privacy/export"))).status, 200);
  assert.equal((await proxy(new NextRequest("https://app.test/api/auth/callback?code=test&state=test"))).status, 200);
  assert.equal((await proxy(new NextRequest("https://app.test/api/privacy/delete", { method: "POST", headers: { origin: "https://evil.test" } }))).status, 403);
  active = true;
  const allowed = await proxy(new NextRequest("https://app.test/api/progress"));
  assert.equal(allowed.status, 200); assert.match(allowed.headers.get("cache-control"), /no-store/);
  let identity = null;
  let deleteFails = false;
  let deletionCalls = 0;
  const deletion = loadWithMocks("../src/app/api/privacy/delete/route.ts", {
    "@/lib/privacy/account": {
      privacyIdentity: async () => identity,
      revokeQfSession: async () => { throw new Error("provider offline"); },
    },
    "@/lib/supabase/admin": { createAdminSupabaseClient: () => ({ rpc: async (name, args) => {
      assert.equal(name, "delete_player_data"); assert.equal(args.target_player, "verified-owner");
      deletionCalls++; return { error: deleteFails ? new Error("db unavailable") : null };
    } }) },
    "@/lib/qf-user/session": { clearQfCookies: () => {} },
  });
  const deleteRequest = (confirmation = "DELETE") => new NextRequest("https://app.test/api/privacy/delete", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://app.test" }, body: JSON.stringify({ confirmation }),
  });
  assert.equal((await deletion.POST(deleteRequest("no"))).status, 400);
  assert.equal((await deletion.POST(deleteRequest())).status, 401);
  assert.equal(deletionCalls, 0);
  identity = { playerId: "verified-owner", session: {} };
  deleteFails = true;
  const failedDeletion = await deletion.POST(deleteRequest());
  assert.equal(failedDeletion.status, 503);
  assert.equal(failedDeletion.headers.get("set-cookie"), null);
  deleteFails = false;
  const partial = await deletion.POST(deleteRequest());
  assert.equal(partial.status, 200);
  const partialResult = await partial.json();
  assert.equal(partialResult.deleted, true); assert.equal(partialResult.qfDisconnected, false);
  const consentRoute = loadWithMocks("../src/app/api/privacy/consent/route.ts", {
    "@/lib/privacy/consent": { getConsentReceipt: async () => null },
    "@/lib/qf-user/session": { readSessionCookie: async () => null },
    "@/lib/supabase/admin": { createAdminSupabaseClient: () => { throw new Error("database offline"); } },
  });
  const choiceRequest = body => new NextRequest("https://app.test/api/privacy/consent", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await consentRoute.POST(choiceRequest({ eligible: true, religiousData: "true" }))).status, 400);
  assert.equal((await consentRoute.POST(choiceRequest({ eligible: false }))).status, 403);
  const failedConsent = await consentRoute.POST(choiceRequest({ eligible: true, religiousData: true, noticeRead: true, version: tokens.CONSENT_VERSION }));
  assert.equal(failedConsent.status, 503); assert.equal(failedConsent.headers.get("set-cookie"), null);
  const listeners = {}; const removed = []; let unregistered = false;
  vm.runInNewContext(fs.readFileSync("public/sw.js", "utf8"), {
    self: { addEventListener: (name, fn) => { listeners[name] = fn; }, skipWaiting() {}, clients: { claim: async () => {} }, registration: { unregister: async () => { unregistered = true; } } },
    caches: { keys: async () => ["quran-reader-v1", "unrelated"], delete: async name => { removed.push(name); } },
  });
  let cleanup; listeners.activate({ waitUntil: p => { cleanup = p; } }); await cleanup;
  assert.deepEqual(removed, ["quran-reader-v1"]); assert.equal(unregistered, true); assert.equal(listeners.fetch, undefined);
  global.Deno = { env: { get: () => "a".repeat(32) } };
  const { requireAppServer } = require("../supabase/functions/_shared/server-auth.ts");
  assert.equal((await requireAppServer(new Request("https://edge.test"))).status, 401);
  assert.equal((await requireAppServer(new Request("https://edge.test", { headers: { "x-quranarena-server-secret": "wrong" } }))).status, 401);
  assert.equal(await requireAppServer(new Request("https://edge.test", { headers: { "x-quranarena-server-secret": "a".repeat(32) } })), null);
  const cookieValues = new Map();
  const qfSession = loadWithMocks("../src/lib/qf-user/session.ts", {
    "./config": { getQfSessionSecret: () => process.env.QF_SESSION_SECRET },
    "./oidc": {},
    "./user-profile": {},
    "@/lib/supabase/admin": {},
    "@/lib/privacy/consent": {},
    "next/headers": { cookies: async () => ({ get: name => cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined }) },
  });
  const cookieStore = { set: (name, value) => cookieValues.set(name, value) };
  const largeSession = {
    issued_at: Date.now(), session_version: 0, scopes: "openid offline_access user",
    access_token: "a".repeat(1400), refresh_token: "r".repeat(80), id_token: "i".repeat(2200),
    expires_at: Date.now() + 3600000, player_id: "player", user: { sub: "subject", email: null, name: "Player", avatar: null },
  };
  await qfSession.writeSessionCookie(cookieStore, largeSession);
  assert(cookieValues.has("qf_session")); assert(cookieValues.has("qf_id_token"));
  assert(Buffer.byteLength(`qf_session=${cookieValues.get("qf_session")}`) <= 3800);
  assert(Buffer.byteLength(`qf_id_token=${cookieValues.get("qf_id_token")}`) <= 3800);
  assert.deepEqual(await qfSession.readSessionCookie(), largeSession);
  const gateSource = fs.readFileSync("src/components/legal/PrivacyGate.tsx", "utf8");
  assert(!gateSource.includes("draft Privacy Policy"));
  const providersSource = fs.readFileSync("src/app/providers.tsx", "utf8");
  assert(providersSource.includes('pathname === "/credits"'));
  console.log("Privacy tests passed: signed-token tampering/expiry/purpose, guest ID forgery, consent gates/failure, OAuth callback exemption and split-cookie round trip, deletion identity/failure, partial QF revocation, CSRF, no-store, public legal pages, cache cleanup, edge server authorization.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
