import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadWithMocks } from "@/lib/flashcard/api-routes.test";
import { FakeServer } from "@/lib/flashcard/verification/helpers";
import { DEFAULT_FSRS_PARAMETERS, DEFAULT_PREFERENCES, FSRSState, WordStatus } from "@/lib/types/flashcard";
import type { SM2Card, UserFlashcard } from "@/lib/types/flashcard";

// Privacy checks for the flashcard port onto main (docs/flashcards-on-main-plan.md):
// every new browser key and column is covered by main's sign-out, deletion
// and export paths, the sign-in upload runs only after main's sign-in
// consent, and a lapsed session loses no account data (H3 under main's model).

const ROOT = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

async function runCase(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`ok - ${name}`);
}

/**
 * A Storage stand-in whose items are its own enumerable properties, like a
 * browser's, so main's clearLearningStorage (which walks Object.keys) sees them.
 */
function browserStorage(initial: Record<string, string> = {}) {
  const storage = {} as Record<string, unknown>;
  const hidden = (name: string, value: unknown) => Object.defineProperty(storage, name, { value, enumerable: false });
  hidden("getItem", (k: string) => (Object.hasOwn(storage, k) ? String(storage[k]) : null));
  hidden("setItem", (k: string, v: string) => { storage[k] = String(v); });
  hidden("removeItem", (k: string) => { delete storage[k]; });
  hidden("key", (i: number) => Object.keys(storage)[i] ?? null);
  Object.defineProperty(storage, "length", { get: () => Object.keys(storage).length, enumerable: false });
  for (const [k, v] of Object.entries(initial)) storage[k] = v;
  return storage as unknown as Storage & Record<string, string>;
}

async function withBrowserGlobals<T>(local: Storage, fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g.window, localStorage: g.localStorage, sessionStorage: g.sessionStorage, fetch: globalThis.fetch };
  g.window = globalThis;
  g.localStorage = local;
  g.sessionStorage = browserStorage();
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    g.window = saved.window;
    g.localStorage = saved.localStorage;
    g.sessionStorage = saved.sessionStorage;
    globalThis.fetch = saved.fetch;
  }
}

/** The localStorage keys the flashcard code reads or writes (string literals). */
function flashcardStorageKeys(): string[] {
  const files = [
    "src/lib/storage/flashcard-storage-supabase.ts",
    "src/lib/storage/flashcard-storage.ts",
    "src/app/train/flashcards/page.tsx",
    "src/app/train/flashcards/review/page.tsx",
    "src/app/train/flashcards/settings/page.tsx",
    "src/app/train/flashcards/stats/page.tsx",
    "src/app/train/flashcards/browse/page.tsx",
    "src/app/train/flashcards/intake/page.tsx",
    "src/components/flashcard/FlashcardReview.tsx",
  ];
  const keys = new Set<string>();
  for (const file of files) {
    for (const match of read(file).matchAll(/["'`]((?:qalamspace|flashcard|fsrs|sm2|quranarena)_[a-z0-9_]+)["'`]/gi)) keys.add(match[1]);
  }
  return [...keys].sort();
}

export async function runFlashcardPrivacyTests() {
  await runCase("Privacy: every flashcard browser key is cleared by the guest expiry and privacy controls, and is in the export", () => {
    const keys = flashcardStorageKeys();
    // The keys this port adds; each must be found, so the scan is not vacuous.
    for (const added of ["qalamspace_scheduler_prefs_synced", "qalamspace_max_interval_upgraded", "qalamspace_flashcards_unsynced",
      "qalamspace_migrated_cards", "qalamspace_migrated_reviews"]) {
      assert.ok(keys.includes(added), `${added} was not found in the flashcard code`);
    }
    const learningPattern = /^(quran|qalamspace|memorization|flashcard|fsrs|sm2)/i;
    // The same pattern in main's three places: the guest-expiry wipe, and the
    // privacy controls' export (withdraw and delete clear all local storage).
    assert.match(read("src/lib/privacy/browser-storage.ts"), /\/\^\(quran\|qalamspace\|memorization\|flashcard\|fsrs\|sm2\)\/i/);
    const controls = read("src/app/privacy/controls/page.tsx");
    assert.match(controls, /\/\^\(quran\|qalamspace\|memorization\|flashcard\|fsrs\|sm2\)\/i\.test\(key\)/, "the export no longer uses the learning-data pattern");
    assert.match(controls, /localStorage\.clear\(\); sessionStorage\.clear\(\);/, "withdraw/delete no longer clear the device");
    for (const key of keys) assert.match(key, learningPattern, `${key} escapes the guest expiry and the export`);
  });

  await runCase("P3: sign-out removes this browser's copy of the account's scheduler settings", async () => {
    const { forgetAccountSchedulerCopy } = await import("@/lib/privacy/browser-storage");
    const local = browserStorage({
      qalamspace_algorithm: "sm2",
      qalamspace_fsrs_params: JSON.stringify({ ...DEFAULT_FSRS_PARAMETERS, request_retention: 0.8 }),
      qalamspace_scheduler_prefs_synced: "true",
      qalamspace_flashcards: "[]",
    });
    await withBrowserGlobals(local, globalThis.fetch, async () => {
      forgetAccountSchedulerCopy();
    });
    assert.deepEqual(Object.keys(local).sort(), ["qalamspace_flashcards"], "the account's scheduler copy outlived sign-out");
    // useAuth().logout (Header and the account page) clears it before it leaves for the logout route.
    const auth = read("src/lib/hooks/useAuth.ts");
    assert.match(auth, /const logout = useCallback\(async \(\) => \{[\s\S]*?forgetAccountSchedulerCopy\(\);[\s\S]*?window\.location\.href = "\/api\/auth\/qf\/logout";/);
  });

  await runCase("H3 (main's model): a signed-in user's Classic schedule and scheduler settings live on the server, so a lapsed session's device wipe loses none of them", async () => {
    const server = new FakeServer();
    const now = new Date(2026, 10, 1, 12);
    const card: UserFlashcard = {
      id: "c1", word_id: "w1", status: WordStatus.IN_BANK, created_at: now,
      fsrs_state: { due: now, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: FSRSState.New },
    };
    const sm2: SM2Card = { phase: "review", step: 0, interval: 6, repetitions: 2, easiness: 2.36, lapses: 0, due: new Date(2026, 10, 7, 12), last_review: now };
    const params = { ...DEFAULT_FSRS_PARAMETERS, request_retention: 0.85 };
    const local = browserStorage();
    await withBrowserGlobals(local, (async (input: string | URL | Request, init?: RequestInit) => server.handle(String(input), init)) as typeof fetch, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      const { clearLearningStorage } = await import("@/lib/privacy/browser-storage");
      await storage.addFlashcards([card]);
      await storage.saveSM2State("c1", sm2);
      await storage.savePreferences({ ...DEFAULT_PREFERENCES, algorithm: "sm2" }, params);

      // Main's privacy gate treats a lapsed session as a guest and, after a
      // day of inactivity, clears the browser's learning data.
      clearLearningStorage();
      assert.equal(Object.keys(local).filter((k) => /^qalamspace/.test(k)).length, 0);

      const [cards, prefs] = await Promise.all([storage.getFlashcards(), storage.getPreferences()]);
      assert.equal(cards[0]?.sm2_state?.interval, 6, "the Classic schedule was lost with the device data");
      assert.equal(cards[0]?.sm2_state?.easiness, 2.36);
      assert.equal(prefs.algorithm, "sm2", "the algorithm choice was lost with the device data");
      assert.equal(storage.getFSRSParameters().request_retention, 0.85, "the FSRS parameters were lost with the device data");
    });
    // Nothing account-only is written to the device while signed in.
    assert.equal(local.getItem("qalamspace_flashcards"), null);
    assert.equal(local.getItem("qalamspace_sm2_states"), null);
  });

  await runCase("M6/U3: the sign-in upload sends nothing before main's sign-in consent and finishes after it", async () => {
    const localDeck = [{
      id: "local-1", word_id: "w1", status: "IN_BANK", created_at: "2026-10-01T00:00:00.000Z",
      fsrs_state: { due: "2026-10-01T00:00:00.000Z", stability: 2, difficulty: 5, elapsed_days: 1, scheduled_days: 2, learning_steps: 0, reps: 3, lapses: 0, state: 2 },
      source_surah_id: null, source_ayah_number: null, source_juz_number: null, source_page_number: null,
    }];
    const local = browserStorage({
      qalamspace_flashcards: JSON.stringify(localDeck),
      qalamspace_reviews: "[]",
      qalamspace_algorithm: "sm2",
    });
    const server = new FakeServer();
    // A preferences row saved by an older version, without the scheduler.
    server.preferences = { ...DEFAULT_PREFERENCES, algorithm: undefined, fsrs_params: null };
    let consented = false;
    const writes: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      // Main's proxy refuses every signed-in API request until the account's
      // consent receipt exists (checked against the real proxy below).
      if (!consented) {
        return Response.json({ error: "Age confirmation and privacy consent are required.", code: "CONSENT_REQUIRED" }, { status: 403 });
      }
      if (init?.method && init.method !== "GET") writes.push(`${init.method} ${String(input)}`);
      return server.handle(String(input), init);
    }) as typeof fetch;
    await withBrowserGlobals(local, fetchImpl, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      const errors = console.error;
      console.error = () => {};
      try {
        // The refusal reaches the caller (the hub shows its load error); the
        // privacy gate on main would show the sign-in consent form instead.
        await assert.rejects(storage.migrateFromLocalStorage(), /CONSENT_REQUIRED/);
      } finally {
        console.error = errors;
      }
      assert.deepEqual(writes, []);
      assert.equal(server.cards.length, 0);
      for (const flag of ["qalamspace_migrated_to_supabase", "qalamspace_migrated_cards", "qalamspace_migrated_reviews", "qalamspace_scheduler_prefs_synced"]) {
        assert.equal(local.getItem(flag), null, `${flag} was set before consent`);
      }

      consented = true;
      assert.equal(await storage.migrateFromLocalStorage(), true);
      assert.deepEqual(server.cards.map((c) => c.word_id), ["w1"]);
      assert.equal(server.preferences?.algorithm, "sm2");
      assert.equal(local.getItem("qalamspace_migrated_to_supabase"), "true");
    });
  });

  await runCase("Consent: main's proxy refuses a signed-in flashcard write without a consent receipt, and asks guests for nothing", async () => {
    const { NextRequest } = await import("next/server");
    const proxyModule = loadWithMocks<{ proxy(request: InstanceType<typeof NextRequest>): Promise<Response> }>("../../proxy.ts", {
      "@/lib/privacy/tokens": { CONSENT_COOKIE: "qa_consent", sameOrigin: () => true, verifyPrivacyToken: async () => null },
      "@/lib/privacy/consent": { getConsentReceipt: async () => null },
    });
    const request = (cookie?: string) => new NextRequest("https://app.test/api/flashcards/cards", {
      method: "PUT", headers: { "Content-Type": "application/json", origin: "https://app.test", ...(cookie ? { cookie } : {}) }, body: "[]",
    });
    const signedIn = await proxyModule.proxy(request("qf_session=abc"));
    assert.equal(signedIn.status, 403);
    assert.equal(((await signedIn.json()) as { code?: string }).code, "CONSENT_REQUIRED");
    const guest = await proxyModule.proxy(request());
    assert.notEqual(guest.status, 403, "a guest's flashcard request was asked for consent");
    // The port leaves main's consent code as it is.
    assert.equal(read("src/proxy.ts").includes("CONSENT_REQUIRED"), true);
  });

  await runCase("Privacy: the new columns sit on rows main's export and deletion already cover", () => {
    const dir = path.join(ROOT, "supabase/migrations");
    const added = readdirSync(dir).filter((f) => /^(011|013|016|017)_/.test(f));
    assert.equal(added.length, 4);
    for (const file of added) {
      const sql = readFileSync(path.join(dir, file), "utf8").replace(/--.*$/gm, "");
      const tables = [...sql.matchAll(/(?:alter table|update)\s+public\.(\w+)/gi)].map((m) => m[1]);
      assert.ok(tables.length > 0, `${file} names no table`);
      for (const table of tables) assert.ok(["user_flashcards", "user_preferences"].includes(table), `${file} touches ${table}`);
      assert.doesNotMatch(sql, /create table/i, `${file} creates a table the export and deletion don't know`);
    }
    const privacy = read("supabase/migrations/009_privacy_controls.sql");
    // The export returns whole rows, so new columns are included.
    assert.match(privacy, /jsonb_agg\(to_jsonb\(t\)\) from public\.user_flashcards t where user_id = target_player/);
    assert.match(privacy, /select to_jsonb\(t\) from public\.user_preferences t where user_id = target_player/);
    // Deleting the player removes both tables' rows (on delete cascade).
    assert.match(privacy, /delete from public\.players where id = target_player/);
    const schema = read("supabase/migrations/002_flashcard_schema.sql");
    assert.equal(schema.match(/user_id uuid (?:not null|primary key) references players\(id\) on delete cascade/g)?.length, 3);
  });
}
