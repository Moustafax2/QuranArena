import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { DEFAULT_FSRS_PARAMETERS, DEFAULT_PREFERENCES, WordStatus } from "@/lib/types/flashcard";
import type { LexicalEntry } from "@/lib/types/flashcard";

// Route handlers are loaded with their session and Supabase modules replaced,
// the same way scripts/test-privacy.cjs does it.
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: ModuleLoader };
const load = createRequire(__filename);

export function loadWithMocks<T>(file: string, mocks: Record<string, unknown>): T {
  const original = moduleWithLoad._load;
  moduleWithLoad._load = function (request, parent, isMain) {
    if (request === "server-only") return {};
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    delete load.cache[load.resolve(file)];
    return load(file) as T;
  } finally {
    moduleWithLoad._load = original;
  }
}

export interface RecordedOp {
  table: string;
  action: string;
  payload?: unknown;
  options?: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
}

type Result = { data?: unknown; error?: { message: string } | null };

/** A chainable stand-in for the Supabase query builder that records every call. */
export function fakeSupabase(respond: (op: RecordedOp) => Result = () => ({ data: null, error: null })) {
  const ops: RecordedOp[] = [];
  const client = {
    from(table: string) {
      const op: RecordedOp = { table, action: "select", filters: [] };
      const builder = {
        select() { if (op.action === "select") op.action = "select"; return builder; },
        insert(payload: unknown, options?: Record<string, unknown>) { Object.assign(op, { action: "insert", payload, options }); return builder; },
        upsert(payload: unknown, options?: Record<string, unknown>) { Object.assign(op, { action: "upsert", payload, options }); return builder; },
        update(payload: unknown) { Object.assign(op, { action: "update", payload }); return builder; },
        delete() { op.action = "delete"; return builder; },
        eq(column: string, value: unknown) { op.filters.push(["eq", column, value]); return builder; },
        in(column: string, value: unknown) { op.filters.push(["in", column, value]); return builder; },
        gte(column: string, value: unknown) { op.filters.push(["gte", column, value]); return builder; },
        lte(column: string, value: unknown) { op.filters.push(["lte", column, value]); return builder; },
        order() { return builder; },
        range() { return builder; },
        single() { return builder; },
        then(resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) {
          ops.push(op);
          const result = { data: null, error: null, ...respond(op) } as Result;
          // Unless a test says otherwise, every word looked up is in the word
          // list (the cards PUT checks lexical_entries before it writes).
          if (op.table === "lexical_entries" && result.data == null) {
            const words = (op.filters.find(([kind, column]) => kind === "in" && column === "word_id")?.[2] ?? []) as string[];
            result.data = words.map((word_id) => ({ word_id }));
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client, ops };
}

export function loadRoute<T>(file: string, supabase: ReturnType<typeof fakeSupabase>, playerId: string | null = "player-1") {
  return loadWithMocks<T>(file, {
    "@/lib/qf-user/session": { getUsableSession: async () => (playerId ? { player_id: playerId } : null) },
    "@/lib/supabase/admin": { createAdminSupabaseClient: () => supabase.client },
  });
}

type Handler = (request?: Request) => Promise<Response>;

/** A uuid for a short test id such as "r1" (review_log ids are uuids). */
function uid(short: string): string {
  return `00000000-0000-4000-8000-${Buffer.from(short).toString("hex").padStart(12, "0").slice(-12)}`;
}
const SESSION_UUID = "00000000-0000-4000-8000-00000000abcd";

function jsonRequest(method: string, body: unknown) {
  return new Request("https://app.test/api", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function runCase(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`ok - ${name}`);
}

export async function runFlashcardApiTests() {
  await runCase("M14: reset reports failure when a delete fails", async () => {
    const supabase = fakeSupabase((op) =>
      op.table === "user_flashcards" ? { error: { message: "permission denied" } } : {}
    );
    const route = loadRoute<{ DELETE: Handler }>("../../app/api/flashcards/reset/route.ts", supabase);
    const response = await route.DELETE();
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.notEqual(body.ok, true);

    const ok = fakeSupabase();
    const okRoute = loadRoute<{ DELETE: Handler }>("../../app/api/flashcards/reset/route.ts", ok);
    const okResponse = await okRoute.DELETE();
    assert.equal(okResponse.status, 200);
    assert.deepEqual(ok.ops.map((op) => [op.table, op.action]), [
      ["review_log", "delete"],
      ["user_flashcards", "delete"],
      ["user_preferences", "delete"],
    ]);
  });

  await runCase("M5: card writes never rewrite an existing card's id", async () => {
    const cardsRoute = "../../app/api/flashcards/cards/route.ts";
    const body = {
      id: "client-id",
      word_id: "w1",
      status: "IN_BANK",
      fsrs_state: { due: "2026-10-27T00:00:00.000Z", state: 0 },
      created_at: "2026-10-27T00:00:00.000Z",
    };
    // Any upsert that updates rows on conflict must not carry `id`, because
    // ON CONFLICT DO UPDATE would then set id = excluded.id.
    const assertNoIdRewrite = (ops: RecordedOp[]) => {
      for (const op of ops.filter((o) => o.action === "upsert" && !o.options?.ignoreDuplicates)) {
        const rows = (Array.isArray(op.payload) ? op.payload : [op.payload]) as Array<Record<string, unknown>>;
        for (const row of rows) assert.equal("id" in row, false, `update-on-conflict upsert sends id: ${JSON.stringify(row)}`);
      }
    };

    // Adding a word that may already exist must leave the stored card alone.
    const add = fakeSupabase();
    const addRoute = loadRoute<{ POST: Handler }>(cardsRoute, add);
    assert.equal((await addRoute.POST(jsonRequest("POST", body))).status, 200);
    assertNoIdRewrite(add.ops);
    const addWrite = add.ops.find((op) => op.table === "user_flashcards" && op.action !== "select");
    assert.equal(addWrite?.options?.ignoreDuplicates, true);

    // A batch import merges into existing cards without touching their ids,
    // while brand-new cards keep the client id (migrated reviews reference it).
    const merge = fakeSupabase();
    const mergeRoute = loadRoute<{ PUT: Handler }>(cardsRoute, merge);
    assert.equal((await mergeRoute.PUT(jsonRequest("PUT", [body]))).status, 200);
    assertNoIdRewrite(merge.ops);
    const insertNew = merge.ops.find((op) => op.action === "upsert" && op.options?.ignoreDuplicates);
    assert.equal((insertNew?.payload as Array<{ id: string }>)[0].id, "client-id");
  });

  await runCase("M12: intake adds all words in one add-only batch request", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const { addWordsToBank } = await import("./intake-manager");
      await addWordsToBank(["w1", "w2", "w3"], WordStatus.KNOWN_NOT_IN_BANK);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "/api/flashcards/cards");
    assert.deepEqual((calls[0].body as Array<{ word_id: string }>).map((c) => c.word_id), ["w1", "w2", "w3"]);

    // The route accepts that array and writes it in one add-only upsert.
    const supabase = fakeSupabase();
    const route = loadRoute<{ POST: Handler }>("../../app/api/flashcards/cards/route.ts", supabase);
    assert.equal((await route.POST(jsonRequest("POST", calls[0].body))).status, 200);
    const writes = supabase.ops.filter((op) => op.table === "user_flashcards");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].options?.ignoreDuplicates, true);
    assert.equal((writes[0].payload as unknown[]).length, 3);
  });

  await runCase("M6: re-uploading reviews is idempotent and the migration retries cleanly", async () => {
    // Server: a batch of reviews is upserted with ignoreDuplicates on id, and
    // reviews for cards the user doesn't own are dropped instead of failing.
    const supabase = fakeSupabase((op) =>
      op.table === "user_flashcards" && op.action === "select" ? { data: [{ id: "c1", word_id: "w" }] } : {}
    );
    const route = loadRoute<{ POST: Handler }>("../../app/api/flashcards/reviews/route.ts", supabase);
    const review = (id: string, cardId: string, wordId = "w") => ({
      id: uid(id), card_id: cardId, word_id: wordId, rating: 3, timestamp: "2026-10-27T10:00:00.000Z",
      session_id: SESSION_UUID, review_duration_ms: 100, state_before: 0, state_after: 1,
    });
    const response = await route.POST(jsonRequest("POST", [review("r1", "c1"), review("r2", "someone-elses", "w-without-card")]));
    assert.equal(response.status, 200);
    const write = supabase.ops.find((op) => op.table === "review_log");
    assert.equal(write?.action, "upsert");
    assert.equal(write?.options?.ignoreDuplicates, true);
    assert.equal(write?.options?.onConflict, "id");
    assert.deepEqual((write?.payload as Array<{ id: string }>).map((r) => r.id), [uid("r1")]);

    // Client: the first attempt fails part-way, so the flag stays unset; the
    // retry sends every review in one request and then sets the flag.
    const store = new Map<string, string>();
    const localStorageStub = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = localStorageStub;
    store.set("qalamspace_reviews", JSON.stringify([review("r1", "c1"), review("r2", "c1"), review("r3", "c1")]));
    let failReviews = true;
    const reviewRequests: unknown[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/flashcards/reviews") && init?.method === "POST") {
        reviewRequests.push(JSON.parse(String(init.body)));
        if (failReviews) return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify(init?.method ? { ok: true } : []), { status: 200 });
    }) as typeof fetch;
    try {
      const { migrateFromLocalStorage } = await import("@/lib/storage/flashcard-storage-supabase");
      assert.equal(await migrateFromLocalStorage(), false);
      assert.equal(store.get("qalamspace_migrated_to_supabase"), undefined);
      failReviews = false;
      reviewRequests.length = 0;
      assert.equal(await migrateFromLocalStorage(), true);
      assert.equal(store.get("qalamspace_migrated_to_supabase"), "true");
      assert.equal(reviewRequests.length, 1);
      assert.equal((reviewRequests[0] as unknown[]).length, 3);
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
  });

  await runCase("N6: SM-2 state is stored on the server, and legacy local states carry over", async () => {
    // Route: PATCH forwards sm2_state (including null, to clear it on undo).
    const supabase = fakeSupabase();
    const patchRoute = loadRoute<{ PATCH: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> }>(
      "../../app/api/flashcards/cards/[id]/route.ts", supabase
    );
    const sm2 = { phase: "review", step: 0, interval: 3, repetitions: 2, easiness: 2.5, lapses: 0, due: "2026-10-30T10:00:00.000Z" };
    await patchRoute.PATCH(jsonRequest("PATCH", { sm2_state: sm2 }), { params: Promise.resolve({ id: "c1" }) });
    await patchRoute.PATCH(jsonRequest("PATCH", { sm2_state: null }), { params: Promise.resolve({ id: "c1" }) });
    const updates = supabase.ops.filter((op) => op.action === "update").map((op) => op.payload);
    assert.deepEqual(updates, [{ sm2_state: sm2 }, { sm2_state: null }]);

    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const serverRow = (id: string, sm2State: unknown) => ({
      id, word_id: `w-${id}`, status: "IN_BANK", created_at: "2026-10-01T00:00:00.000Z",
      fsrs_state: { due: "2026-10-01T00:00:00.000Z", stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0 },
      sm2_state: sm2State,
      source_surah_id: null, source_ayah_number: null, source_juz_number: null, source_page_number: null,
    });
    const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" || init?.method === "PUT") patches.push({ url: String(url), body: JSON.parse(String(init.body)) });
      if (String(url) === "/api/flashcards/cards" && !init?.method) {
        return new Response(JSON.stringify([serverRow("c1", sm2), serverRow("c2", null)]), { status: 200 });
      }
      return new Response(JSON.stringify(init?.method ? { ok: true } : []), { status: 200 });
    }) as typeof fetch;
    try {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      // Server state is hydrated with real dates.
      const [c1] = await storage.getFlashcards();
      assert.ok(c1.sm2_state?.due instanceof Date);
      assert.equal(c1.sm2_state?.interval, 3);

      // A Classic-mode review is written to the server, not only to this browser.
      const { reviewCard } = await import("./session-manager");
      const session = {
        id: "s", cards: [c1], current_index: 0, start_time: new Date(), algorithm: "sm2" as const,
        stats: { total_cards: 1, cards_reviewed: 0, new_cards: 0, review_cards: 1, again_count: 0, hard_count: 0, good_count: 0, easy_count: 0, total_time_ms: 0 },
      };
      await reviewCard(session, "c1", 3);
      const reviewPatch = patches.find((p) => p.url === "/api/flashcards/cards/c1");
      assert.ok(reviewPatch && reviewPatch.body.sm2_state, "SM-2 review did not reach the server");

      // States saved by older versions in localStorage are uploaded once and
      // then removed; until then they are still used.
      patches.length = 0;
      store.set("qalamspace_sm2_states", JSON.stringify({ c2: { interval: 6, repetitions: 2, easiness: 2.36, due: "2026-11-02T10:00:00.000Z" } }));
      const merged = await storage.getFlashcards();
      assert.equal(merged.find((c) => c.id === "c2")?.sm2_state?.interval, 6);
      await storage.migrateFromLocalStorage();
      // One batched write (A1-review #9) carrying only c2's state.
      assert.deepEqual(patches.map((p) => p.url), ["/api/flashcards/cards"]);
      assert.deepEqual((patches[0].body as unknown as Array<{ id: string; sm2_state: { interval: number } }>).map((c) => [c.id, c.sm2_state.interval]), [["c2", 6]]);
      assert.equal(store.has("qalamspace_sm2_states"), false);
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
  });

  await runCase("M10/N7: an expired session is reported instead of diverting writes to this browser", async () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    // The routes tell the two 401s apart: a request that still carries the
    // sign-in cookie but has no usable session is an expired session; one
    // without it is a guest's.
    const route = loadRoute<{ POST: Handler }>("../../app/api/flashcards/reviews/route.ts", fakeSupabase(), null);
    const expired = await route.POST(new Request("https://app.test/api", {
      method: "POST", headers: { "Content-Type": "application/json", cookie: "other=1; qf_session=stale-value" }, body: "{}",
    }));
    assert.equal(expired.status, 401);
    assert.equal(((await expired.json()) as { code?: string }).code, "SESSION_EXPIRED");
    const guestReply = await route.POST(jsonRequest("POST", {}));
    assert.equal(guestReply.status, 401);
    assert.equal(((await guestReply.json()) as { code?: string }).code, undefined);
    const emptyCookie = await route.POST(new Request("https://app.test/api", {
      method: "POST", headers: { "Content-Type": "application/json", cookie: "qf_session=; qf_session_hint=1" }, body: "{}",
    }));
    assert.equal(((await emptyCookie.json()) as { code?: string }).code, undefined, "a cleared cookie is not a session");

    const log = {
      id: "r1", card_id: "c1", word_id: "w", rating: 3 as const, timestamp: new Date(),
      session_id: "s", state_before: 2, state_after: 2,
    };
    try {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");

      // Signed in on this browser earlier, session now expired.
      globalThis.fetch = (async () => Response.json(
        { error: "Your sign-in has expired.", code: "SESSION_EXPIRED" }, { status: 401 })) as typeof fetch;
      await assert.rejects(storage.saveReviewLog(log), (e: unknown) => e instanceof storage.SessionExpiredError);
      await assert.rejects(storage.getFlashcards(), (e: unknown) => e instanceof storage.SessionExpiredError);
      assert.equal(store.has("qalamspace_reviews"), false);

      // A real guest (never signed in, or signed out) still uses local storage.
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })) as typeof fetch;
      await storage.saveReviewLog(log);
      assert.equal(JSON.parse(store.get("qalamspace_reviews")!).length, 1);
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
  });

  await runCase("A2-review #5: a 503 from the sign-in service is a retryable error, never 'Sign in again' or a local write", async () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    globalThis.fetch = (async () => Response.json({ error: "Sign-in service is temporarily unavailable" }, { status: 503 })) as typeof fetch;
    const log = {
      id: "r1", card_id: "c1", word_id: "w", rating: 3 as const, timestamp: new Date(),
      session_id: "s", state_before: 2, state_after: 2,
    };
    try {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      await assert.rejects(storage.saveReviewLog(log), (e: unknown) => e instanceof Error && !(e instanceof storage.SessionExpiredError));
      await assert.rejects(storage.getFlashcards(), (e: unknown) => e instanceof Error && !(e instanceof storage.SessionExpiredError));
      assert.equal(store.has("qalamspace_reviews"), false);
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
    // Each flashcard page shows its own "please try again" text for anything
    // but SessionExpiredError, so a 503 never offers "Sign in again".
    for (const page of ["src/app/train/flashcards/page.tsx", "src/app/train/flashcards/review/page.tsx", "src/app/train/flashcards/stats/page.tsx"]) {
      assert.match(readFileSync(page, "utf8"), /instanceof SessionExpiredError/, page);
    }
  });

  await runCase("M8: a failed save can be retried without double-scheduling or a duplicate log", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    const store = new Map<string, string>();
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const patches: string[] = [];
    const logIds: string[] = [];
    let failLog = true;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") patches.push(JSON.stringify(JSON.parse(String(init.body)).fsrs_state.stability));
      if (String(url) === "/api/flashcards/reviews" && init?.method === "POST") {
        logIds.push(JSON.parse(String(init.body)).id);
        if (failLog) return new Response("db down", { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const { reviewCard } = await import("./session-manager");
      const { createNewCard } = await import("@/lib/fsrs/scheduler");
      const card = { id: "c1", word_id: "w", status: WordStatus.IN_BANK, created_at: new Date(), fsrs_state: createNewCard() };
      const session = {
        id: "s", cards: [card], current_index: 0, start_time: new Date(), algorithm: "fsrs" as const,
        stats: { total_cards: 1, cards_reviewed: 0, new_cards: 1, review_cards: 0, again_count: 0, hard_count: 0, good_count: 0, easy_count: 0, total_time_ms: 0 },
      };
      const attempt = "attempt-1";
      await assert.rejects(reviewCard(session, "c1", 3, 0, attempt));
      failLog = false;
      const { updatedSession } = await reviewCard(session, "c1", 3, 0, attempt);
      assert.equal(updatedSession.stats.cards_reviewed, 1);
      // Both attempts start from the same card state, and reuse one log id
      // (the server ignores a duplicate id), so nothing is applied twice.
      assert.equal(patches.length, 2);
      assert.equal(patches[0], patches[1]);
      assert.deepEqual(logIds, [attempt, attempt]);
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }

    // The page shows a word only for the card it was loaded for.
    const { wordForCard } = await import("./session-manager");
    const entry = { id: "w", type: "NOUN", canonical_form: "x", translation: "t", examples: [], source: "s" } as unknown as LexicalEntry;
    assert.equal(wordForCard({ key: "c1@0", word: entry }, "c1@0"), entry);
    assert.equal(wordForCard({ key: "c1@0", word: entry }, "c2@1"), null);
    assert.equal(wordForCard(null, "c2@1"), null);
  });

  await runCase("L7: word lookups never return a different word, surface load errors and share one load", async () => {
    const lexicalPath = "../corpus/lexical-db.ts";
    const freshLexicalDb = () => {
      delete load.cache[load.resolve(lexicalPath)];
      return load(lexicalPath) as typeof import("@/lib/corpus/lexical-db");
    };
    const verb = (id: string, lemma: string, translation: string) => ({
      id, type: "VERB", canonical_form: lemma, root: "ك ت ب", lemma, translation, examples: [], source: "corpus",
    });
    const entries = [verb("v_ك_ت_ب_كَت", "كَتَبَ", "to write"), verb("v_ك_ت_ب_كات_2", "كاتَبَ", "to correspond")];
    const realFetch = globalThis.fetch;
    let fetches = 0;
    let fail = false;
    globalThis.fetch = (async () => {
      fetches++;
      if (fail) throw new TypeError("network down");
      return new Response(JSON.stringify({ entries }), { status: 200 });
    }) as typeof fetch;
    try {
      // Fuzzy fallback (the entry's id changed in a later build): only a word
      // with the same root AND lemma prefix may match, not the root's first verb.
      let db = freshLexicalDb();
      assert.equal((await db.getWordById("v_ك_ت_ب_كات"))?.translation, "to correspond");
      // An id whose lemma matches nothing must not silently become another verb of the root.
      assert.equal(await db.getWordById("v_ك_ت_ب_مكت"), null);

      // Concurrent first loads share one request.
      db = freshLexicalDb();
      fetches = 0;
      await Promise.all([db.getWordById("v_ك_ت_ب_كَت"), db.getWordById("v_ك_ت_ب_كات"), db.loadLexicalDB()]);
      assert.equal(fetches, 1);

      // A failed load is reported (no mock data in its place) and retried later.
      db = freshLexicalDb();
      fail = true;
      await assert.rejects(db.getWordById("v_ك_ت_ب_كَت"));
      fail = false;
      assert.equal((await db.getWordById("v_ك_ت_ب_كَت"))?.translation, "to write");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await runCase("L21: algorithm choice and FSRS parameters sync through the preferences API", async () => {
    const prefsRoute = "../../app/api/flashcards/preferences/route.ts";
    const supabase = fakeSupabase();
    const route = loadRoute<{ PUT: Handler }>(prefsRoute, supabase);
    const params = { ...DEFAULT_FSRS_PARAMETERS, request_retention: 0.85 };
    await route.PUT(jsonRequest("PUT", { ...DEFAULT_PREFERENCES, algorithm: "sm2", fsrs_params: params }));
    const written = supabase.ops.find((op) => op.table === "user_preferences")?.payload as Record<string, unknown>;
    assert.equal(written.algorithm, "sm2");
    assert.deepEqual(written.fsrs_params, params);

    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    let serverRow: Record<string, unknown> = { ...DEFAULT_PREFERENCES, algorithm: "fsrs", fsrs_params: null };
    const puts: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/flashcards/preferences" && init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (String(url) === "/api/flashcards/preferences") return new Response(JSON.stringify(serverRow), { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    try {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      // A row never saved by this version (fsrs_params null) must not override
      // the choice an existing user made on this device.
      store.set("qalamspace_algorithm", "sm2");
      assert.equal((await storage.getPreferences()).algorithm, "sm2");

      // Saving sends both to the server.
      await storage.savePreferences({ ...DEFAULT_PREFERENCES, algorithm: "sm2" }, params);
      assert.equal(puts[0].algorithm, "sm2");
      assert.deepEqual(puts[0].fsrs_params, params);

      // On another device (empty localStorage) the server values win and are
      // cached for the scheduler.
      store.clear();
      serverRow = { ...DEFAULT_PREFERENCES, algorithm: "sm2", fsrs_params: params };
      assert.equal((await storage.getPreferences()).algorithm, "sm2");
      assert.equal(storage.getFSRSParameters().request_retention, 0.85);
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
  });

  await runCase("A1-review #2: a PUT batch never clears a stored sm2_state it doesn't carry", async () => {
    const supabase = fakeSupabase();
    const route = loadRoute<{ PUT: Handler }>("../../app/api/flashcards/cards/route.ts", supabase);
    const card = (word: string, extra: Record<string, unknown>) => ({
      id: `id-${word}`, word_id: word, status: "IN_BANK", created_at: "2026-10-27T00:00:00.000Z",
      fsrs_state: { due: "2026-10-27T00:00:00.000Z", state: 0 }, ...extra,
    });
    const sm2 = { phase: "review", step: 0, interval: 3, repetitions: 2, easiness: 2.5, lapses: 0, due: "2026-10-30T10:00:00.000Z" };
    const response = await route.PUT(jsonRequest("PUT", [
      card("w1", { sm2_state: sm2 }),
      card("w2", {}),                 // never studied in Classic (no key)
      card("w3", { sm2_state: null }), // exports carry null for these
    ]));
    assert.equal(response.status, 200);

    // supabase-js sends one column list per batch (the union of the rows'
    // keys) and fills a missing key with NULL, so model that here.
    const sm2Written = new Map<string, unknown>();
    for (const op of supabase.ops.filter((o) => o.action === "upsert" && !o.options?.ignoreDuplicates)) {
      const rows = op.payload as Array<Record<string, unknown>>;
      const columns = new Set(rows.flatMap((row) => Object.keys(row)));
      if (!columns.has("sm2_state")) continue;
      for (const row of rows) sm2Written.set(row.word_id as string, row.sm2_state ?? null);
    }
    assert.deepEqual(sm2Written.get("w1"), sm2);
    assert.equal(sm2Written.has("w2"), false, "w2's stored Classic state would be set to NULL");
    assert.equal(sm2Written.has("w3"), false, "w3's stored Classic state would be set to NULL");
  });

  // A fake server for the client-side migration: cards keyed by word, merged
  // the way PUT /cards merges them (fix #2), plus the PATCH and preferences routes.
  type ServerCard = Record<string, unknown> & { id: string; word_id: string };
  function fakeServer(initial: ServerCard[], prefsRow: Record<string, unknown> | null = null) {
    const cards = new Map(initial.map((c) => [c.word_id, { ...c }]));
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url: String(url), body });
      const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url === "/api/flashcards/cards" && method === "GET") return new Response(JSON.stringify([...cards.values()]), { status: 200 });
      if (url === "/api/flashcards/cards" && method === "PUT") {
        for (const card of body as ServerCard[]) {
          const existing = cards.get(card.word_id);
          if (!existing) cards.set(card.word_id, { ...card });
          else if (card.sm2_state != null) existing.sm2_state = card.sm2_state;
        }
        return ok();
      }
      if (String(url).startsWith("/api/flashcards/cards/") && method === "PATCH") {
        const id = String(url).split("/").pop();
        const card = [...cards.values()].find((c) => c.id === id);
        if (card && body.sm2_state !== undefined) card.sm2_state = body.sm2_state;
        return ok();
      }
      if (url === "/api/flashcards/preferences" && method === "GET") return new Response(JSON.stringify(prefsRow), { status: 200 });
      return init?.method ? ok() : new Response("[]", { status: 200 });
    }) as typeof fetch;
    return { cards, requests, fetchImpl };
  }
  const fsrsNew = { due: "2026-10-01T00:00:00.000Z", stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0 };
  const deckCard = (id: string, word: string): ServerCard => ({
    id, word_id: word, status: "IN_BANK", created_at: "2026-10-01T00:00:00.000Z", fsrs_state: fsrsNew,
    sm2_state: null, source_surah_id: null, source_ayah_number: null, source_juz_number: null, source_page_number: null,
  });
  const legacyState = (interval: number) => ({ phase: "review", step: 0, interval, repetitions: 2, easiness: 2.5, lapses: 0, due: "2026-11-02T10:00:00.000Z" });
  async function withBrowser(store: Map<string, string>, fetchImpl: typeof fetch, fn: () => Promise<void>) {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    globalThis.fetch = fetchImpl;
    try {
      await fn();
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
  }

  await runCase("A1-review #1: legacy Classic states survive sign-in, also for a card that merged into a server card", async () => {
    // A guest studied w1 and w2 in Classic with an older version, then signs
    // in. The account already has w1 (under another id); w2 is new.
    const server = fakeServer([deckCard("srv-1", "w1")]);
    const store = new Map<string, string>([
      ["qalamspace_flashcards", JSON.stringify([deckCard("local-1", "w1"), deckCard("local-2", "w2")])],
      ["qalamspace_sm2_states", JSON.stringify({ "local-1": legacyState(6), "local-2": legacyState(9), gone: legacyState(4) })],
    ]);
    await withBrowser(store, server.fetchImpl, async () => {
      const { migrateFromLocalStorage } = await import("@/lib/storage/flashcard-storage-supabase");
      assert.equal(await migrateFromLocalStorage(), true);
    });
    assert.equal((server.cards.get("w1")?.sm2_state as { interval: number } | null)?.interval, 6, "w1 (merged into srv-1) lost its Classic state");
    assert.equal(server.cards.get("w2")?.id, "local-2");
    assert.equal((server.cards.get("w2")?.sm2_state as { interval: number } | null)?.interval, 9, "w2 lost its Classic state");
    // Every state found its card (the one for a card that no longer exists anywhere is dropped).
    assert.equal(store.has("qalamspace_sm2_states"), false);
  });

  await runCase("A1-review #9: legacy states go up in one request, and device preferences are checked once", async () => {
    const server = fakeServer(
      [deckCard("c1", "w1"), deckCard("c2", "w2"), deckCard("c3", "w3")],
      { ...DEFAULT_PREFERENCES, algorithm: "fsrs", fsrs_params: null }
    );
    const store = new Map<string, string>([
      ["qalamspace_migrated_to_supabase", "true"],
      ["qalamspace_algorithm", "sm2"],
      ["qalamspace_sm2_states", JSON.stringify({ c1: legacyState(2), c2: legacyState(3), c3: legacyState(4) })],
    ]);
    await withBrowser(store, server.fetchImpl, async () => {
      const { migrateFromLocalStorage } = await import("@/lib/storage/flashcard-storage-supabase");
      await migrateFromLocalStorage();
      const writes = server.requests.filter((r) => r.url.startsWith("/api/flashcards/cards") && r.method !== "GET");
      assert.deepEqual(writes.map((r) => r.method), ["PUT"], "one batched write instead of a PATCH per card");
      assert.deepEqual((writes[0].body as ServerCard[]).map((c) => (c.sm2_state as { interval: number }).interval), [2, 3, 4]);
      const prefPuts = server.requests.filter((r) => r.url === "/api/flashcards/preferences" && r.method === "PUT");
      assert.equal((prefPuts[0]?.body as Record<string, unknown> | undefined)?.algorithm, "sm2");

      // Later loads don't ask the server again.
      server.requests.length = 0;
      await migrateFromLocalStorage();
      assert.equal(server.requests.filter((r) => r.url === "/api/flashcards/preferences").length, 0);
    });
  });

  await runCase("A1-review #6: preferences without an algorithm never store \"undefined\", and bad stored values heal", async () => {
    const server = fakeServer([], { ...DEFAULT_PREFERENCES, algorithm: "sm2", fsrs_params: null });
    const store = new Map<string, string>([["qalamspace_algorithm", "sm2"]]);
    await withBrowser(store, server.fetchImpl, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      // Old exports and old local preferences have no algorithm field.
      const { algorithm: _omitted, ...oldPrefs } = DEFAULT_PREFERENCES;
      void _omitted;
      await storage.savePreferences(oldPrefs as typeof DEFAULT_PREFERENCES);
      assert.equal(store.get("qalamspace_algorithm"), "sm2");

      // A value written by the old code is ignored instead of read as an algorithm.
      store.set("qalamspace_algorithm", "undefined");
      assert.equal(storage.getAlgorithmPreference(), "fsrs");
      assert.equal((await storage.getPreferences()).algorithm, "fsrs");
    });
  });

  // N1 follow-up (user decision): everyone's saved 365-day maximum interval,
  // the old default, moves to 36500. Other values are kept.
  const savedParams = (maximum_interval: number) => JSON.stringify({ ...DEFAULT_FSRS_PARAMETERS, request_retention: 0.85, maximum_interval });

  await runCase("N1 follow-up: a saved 365-day maximum interval moves to 36500 once per device; other values stay", async () => {
    const server = fakeServer([], null);
    const store = new Map<string, string>([["qalamspace_fsrs_params", savedParams(365)]]);
    await withBrowser(store, server.fetchImpl, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      const params = storage.getFSRSParameters();
      assert.equal(params.maximum_interval, 36500, "the old default 365 was not upgraded");
      assert.equal(params.request_retention, 0.85, "other saved parameters must be kept");
      assert.equal(JSON.parse(store.get("qalamspace_fsrs_params")!).maximum_interval, 36500, "the device copy still says 365");

      // Once only: a 365 the user picks afterwards is their choice and stays.
      storage.saveFSRSParameters({ ...params, maximum_interval: 365 });
      assert.equal(storage.getFSRSParameters().maximum_interval, 365);
      assert.equal(storage.getFSRSParameters().maximum_interval, 365);
    });

    // A value cached from the server after the upgrade is not touched either
    // (server rows are upgraded by migration 013).
    store.delete("qalamspace_fsrs_params");
    const row = { ...DEFAULT_PREFERENCES, algorithm: "fsrs", fsrs_params: { ...DEFAULT_FSRS_PARAMETERS, maximum_interval: 365 } };
    await withBrowser(store, fakeServer([], row).fetchImpl, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      await storage.getPreferences();
      assert.equal(storage.getFSRSParameters().maximum_interval, 365);
    });

    // Any other saved value, and a device with nothing saved, stay as they are.
    for (const custom of [180, 364, 366, 1000, 36500]) {
      const other = new Map<string, string>([["qalamspace_fsrs_params", savedParams(custom)]]);
      await withBrowser(other, server.fetchImpl, async () => {
        const storage = await import("@/lib/storage/flashcard-storage-supabase");
        assert.equal(storage.getFSRSParameters().maximum_interval, custom);
        assert.equal(JSON.parse(other.get("qalamspace_fsrs_params")!).maximum_interval, custom);
      });
    }
    const empty = new Map<string, string>();
    await withBrowser(empty, server.fetchImpl, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      assert.equal(storage.getFSRSParameters().maximum_interval, 36500);
      assert.equal(empty.has("qalamspace_fsrs_params"), false);
    });
  });

  await runCase("N1 follow-up: the one-time device upload and imports never send the old 365", async () => {
    // L21's one-time upload of device-only parameters.
    const server = fakeServer([], { ...DEFAULT_PREFERENCES, algorithm: "fsrs", fsrs_params: null });
    const store = new Map<string, string>([
      ["qalamspace_migrated_to_supabase", "true"],
      ["qalamspace_algorithm", "sm2"],
      ["qalamspace_fsrs_params", savedParams(365)],
    ]);
    await withBrowser(store, server.fetchImpl, async () => {
      const { migrateFromLocalStorage } = await import("@/lib/storage/flashcard-storage-supabase");
      await migrateFromLocalStorage();
    });
    const uploads = server.requests.filter((r) => r.url === "/api/flashcards/preferences" && r.method === "PUT");
    assert.equal(uploads.length, 1);
    const uploaded = (uploads[0].body as { fsrs_params: { maximum_interval: number; request_retention: number } }).fsrs_params;
    assert.equal(uploaded.maximum_interval, 36500, "the stale 365 was uploaded to the server");
    assert.equal(uploaded.request_retention, 0.85);

    // Importing an old backup. Exports carry no FSRS parameters, and import
    // sends the device's own (upgraded) parameters even if a backup has some.
    const importServer = fakeServer([], { ...DEFAULT_PREFERENCES, algorithm: "fsrs", fsrs_params: null });
    const device = new Map<string, string>([["qalamspace_fsrs_params", savedParams(365)]]);
    await withBrowser(device, importServer.fetchImpl, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      const backup = { preferences: { ...DEFAULT_PREFERENCES, fsrs_params: { ...DEFAULT_FSRS_PARAMETERS, maximum_interval: 365 } }, version: "1.0.0" };
      await storage.importData(JSON.stringify(backup));
    });
    const imported = importServer.requests.filter((r) => r.url === "/api/flashcards/preferences" && r.method === "PUT");
    assert.equal(imported.length, 1);
    assert.equal((imported[0].body as { fsrs_params: { maximum_interval: number } }).fsrs_params.maximum_interval, 36500, "an import re-sent 365");
  });

  await runCase("N1 follow-up: migration 013 moves exactly 365 to 36500 in user_preferences.fsrs_params, idempotently", async () => {
    const dir = "supabase/migrations";
    const files = readdirSync(dir).filter((f) => f.startsWith("013_"));
    assert.deepEqual(files, ["013_flashcard_max_interval_36500.sql"], "expected one new migration numbered 013");
    // Comments removed, whitespace collapsed.
    const sql = readFileSync(`${dir}/${files[0]}`, "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ").trim().toLowerCase();
    const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(statements, [
      "update public.user_preferences " +
        "set fsrs_params = jsonb_set(fsrs_params, '{maximum_interval}', '36500'::jsonb) " +
        "where jsonb_typeof(fsrs_params) = 'object' " +
        "and fsrs_params -> 'maximum_interval' = '365'::jsonb",
    ]);
  });

  await runCase("A1-review #8: a guest's batch add writes the deck once and keeps words already in it", async () => {
    const studied = { ...deckCard("old", "w1"), status: "IN_BANK", fsrs_state: { ...fsrsNew, reps: 5, state: 2 } };
    const store = new Map<string, string>([["qalamspace_flashcards", JSON.stringify([studied])]]);
    let deckWrites = 0;
    const guestFetch = (async () => new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })) as typeof fetch;
    await withBrowser(store, guestFetch, async () => {
      const g = globalThis as unknown as { localStorage: { setItem: (k: string, v: string) => void } };
      const setItem = g.localStorage.setItem;
      g.localStorage.setItem = (k, v) => { if (k === "qalamspace_flashcards") deckWrites++; setItem(k, v); };
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      const { createNewCard } = await import("@/lib/fsrs/scheduler");
      const fresh = (id: string, word: string) => ({ id, word_id: word, status: WordStatus.IN_BANK, created_at: new Date(), fsrs_state: createNewCard() });
      await storage.addFlashcards([fresh("new-1", "w1"), fresh("new-2", "w2"), fresh("new-3", "w3")]);
      const deck = await storage.getFlashcards();
      assert.deepEqual(deck.map((c) => [c.id, c.word_id]), [["old", "w1"], ["new-2", "w2"], ["new-3", "w3"]]);
      assert.equal(deck[0].fsrs_state.reps, 5, "the studied card was replaced");
      assert.equal(deckWrites, 1);
    });
  });

  await runCase("A1-review #4: reviews follow the user's card for their word; only reviews of words without a card are dropped", async () => {
    // The user's cards. A local card for w2 merged into srv-2 on upload, so
    // its reviews still carry the local id.
    const owned = [{ id: "c1", word_id: "w1" }, { id: "srv-2", word_id: "w2" }];
    const supabase = fakeSupabase((op) => {
      if (op.table !== "user_flashcards" || op.action !== "select") return {};
      const userId = op.filters.find(([, col]) => col === "user_id")?.[2];
      const words = op.filters.find(([kind, col]) => kind === "in" && col === "word_id")?.[2] as string[] | undefined;
      const ids = op.filters.find(([kind, col]) => kind === "in" && col === "id")?.[2] as string[] | undefined;
      if (userId !== "player-1") return { data: [] };
      return { data: owned.filter((c) => (words ? words.includes(c.word_id) : true) && (ids ? ids.includes(c.id) : true)) };
    });
    const route = loadRoute<{ POST: Handler }>("../../app/api/flashcards/reviews/route.ts", supabase);
    const review = (id: string, cardId: string, wordId: string) => ({
      id: uid(id), card_id: cardId, word_id: wordId, rating: 3, timestamp: "2026-10-27T10:00:00.000Z",
      session_id: SESSION_UUID, review_duration_ms: 100, state_before: 0, state_after: 1,
    });
    const response = await route.POST(jsonRequest("POST", [
      review("r1", "c1", "w1"),
      review("r2", "local-2", "w2"),        // remapped to srv-2
      review("r3", "someone-elses", "w1"),  // a foreign id is never written; the user's own card is
      review("r4", "someone-elses", "w9"),  // no card for w9: dropped
    ]));
    assert.equal(response.status, 200);
    const write = supabase.ops.find((op) => op.table === "review_log");
    assert.deepEqual(
      (write?.payload as Array<{ id: string; card_id: string; user_id: string }>).map((r) => [r.id, r.card_id, r.user_id]),
      [[uid("r1"), "c1", "player-1"], [uid("r2"), "srv-2", "player-1"], [uid("r3"), "c1", "player-1"]]
    );
  });

  await runCase("A1-review #5: Unlearn also resets the Classic state, signed in and as a guest", async () => {
    // Signed in: one PATCH that clears sm2_state too.
    const server = fakeServer([{ ...deckCard("c1", "w1"), sm2_state: legacyState(30) }]);
    await withBrowser(new Map(), server.fetchImpl, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      await storage.unlearnFlashcard("c1");
    });
    const patch = server.requests.find((r) => r.method === "PATCH");
    assert.equal((patch?.body as { fsrs_state: { state: number } }).fsrs_state.state, 0);
    assert.equal(server.cards.get("w1")?.sm2_state, null, "the Classic state survived Unlearn");

    // Guest: the local card and any legacy copy of its state are cleared.
    const store = new Map<string, string>([
      ["qalamspace_flashcards", JSON.stringify([{ ...deckCard("g1", "w1"), sm2_state: legacyState(30) }])],
      ["qalamspace_sm2_states", JSON.stringify({ g1: legacyState(30) })],
    ]);
    const guestFetch = (async () => new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })) as typeof fetch;
    await withBrowser(store, guestFetch, async () => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      await storage.unlearnFlashcard("g1");
      const [card] = await storage.getFlashcards();
      assert.equal(card.fsrs_state.state, 0);
      assert.equal(card.sm2_state ?? null, null, "a guest's Classic state survived Unlearn");
    });
  });

  await runCase("A1-review #7: noun id fallback compares like with like and never returns a longer, different word", async () => {
    const lexicalPath = "../corpus/lexical-db.ts";
    delete load.cache[load.resolve(lexicalPath)];
    const db = load(lexicalPath) as typeof import("@/lib/corpus/lexical-db");
    // Ids are built as n_{lemma.substring(0, 5)}_{root.substring(0, 3)} (canonicalization.ts).
    const kitab = "كِتَاب";             // كِتَاب
    const rabb = "رَبّ";                            // رَبّ (4 code units)
    const rabbani = rabb + "انِيّ";            // رَبّانِيّ
    const salah = "صلاة";                           // صلاة
    const noun = (lemma: string, root: string, translation: string) => ({
      id: `n_${lemma.substring(0, 5)}_${root.substring(0, 3)}`, type: "NOUN", canonical_form: lemma,
      root, lemma, translation, examples: [], source: "corpus",
    });
    const entries = [noun(kitab, "كتب", "book"), noun(rabbani, "ربب", "godly scholar"), noun(salah, "ص ل و", "prayer")];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ entries }), { status: 200 })) as typeof fetch;
    try {
      // An id built from a space-separated root ("ك ت ب" → "ك ت") still finds the word.
      assert.equal((await db.getWordById(`n_${kitab.substring(0, 5)}_ك ت`))?.translation, "book");
      // And the other way round (entry root has spaces, id doesn't).
      assert.equal((await db.getWordById(`n_${salah}_صلو`))?.translation, "prayer");
      // A removed short lemma (shorter than the 5-unit prefix) must not turn into a longer word.
      assert.equal(await db.getWordById(`n_${rabb}_ربب`), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

export { jsonRequest };
