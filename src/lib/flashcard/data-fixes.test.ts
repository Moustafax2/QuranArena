import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fakeSupabase, loadWithMocks } from "@/lib/flashcard/api-routes.test";

// The flashcard cases of fix/audit-remediation's A4 suites (a4-data-infra
// and a4-review), ported with the flashcard code: M4 (flashcard reads only),
// L10 (flashcard routes only), L18 (the Muyassar batch and the hub load),
// A4R4, A4R5, A4R7 and A4R10 (flashcard pages only).

const ROOT = path.resolve(__dirname, "../../..");

async function runCase(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`ok - ${name}`);
}

type Row = Record<string, unknown>;
type Filter = { kind: "eq" | "in"; column: string; value: unknown };

/** PostgREST's max_rows (supabase/config.toml, and the hosted default). */
const MAX_ROWS = 1000;

/**
 * The longest request URL the API gateway accepts. The local stack answers
 * 414 URI Too Long past about 8 KB, and supabase-js returns that as an error.
 */
const MAX_URL_BYTES = 8192;

/** Roughly the PostgREST URL supabase-js builds for a read: every filter value is in it. */
function requestUrlLength(table: string, filters: Filter[]) {
  return filters.reduce((length, f) => {
    const value = f.kind === "eq" ? `eq.${String(f.value)}` : `in.(${(f.value as unknown[]).join(",")})`;
    return length + `&${f.column}=${encodeURIComponent(value)}`.length;
  }, `/rest/v1/${table}?select=*`.length);
}

/**
 * A Supabase query-builder stand-in over in-memory tables that behaves like
 * PostgREST: filters, ordering and .range()/.limit() apply, no response
 * carries more than MAX_ROWS rows, whatever range was asked for, and a read
 * whose URL is longer than MAX_URL_BYTES fails with a 414 error. It records
 * the size of every .in() list (each value ends up in the request URL).
 */
export function cappedSupabase(tables: Record<string, Row[]>, failOn?: (table: string, call: number) => boolean) {
  const inSizes: Array<{ table: string; size: number }> = [];
  const calls = new Map<string, number>();
  const client = {
    from(table: string) {
      const filters: Filter[] = [];
      const orders: Array<{ column: string; ascending: boolean }> = [];
      let window: [number, number] | null = null;
      let limit: number | null = null;
      let single = false;
      let write = false;
      const builder = {
        select() { return builder; },
        update() { write = true; return builder; },
        eq(column: string, value: unknown) { filters.push({ kind: "eq", column, value }); return builder; },
        in(column: string, value: unknown[]) { inSizes.push({ table, size: value.length }); filters.push({ kind: "in", column, value }); return builder; },
        order(column: string, options?: { ascending?: boolean }) { orders.push({ column, ascending: options?.ascending ?? true }); return builder; },
        range(from: number, to: number) { window = [from, to]; return builder; },
        limit(n: number) { limit = n; return builder; },
        maybeSingle() { single = true; return builder; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          const call = (calls.get(table) ?? 0) + 1;
          calls.set(table, call);
          if (failOn?.(table, call)) {
            return Promise.resolve({ data: null, error: { message: `${table} is unavailable` } }).then(resolve, reject);
          }
          if (write) return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          if (requestUrlLength(table, filters) > MAX_URL_BYTES) {
            return Promise.resolve({ data: null, error: { message: "414 Request-URI Too Large", code: "414" } }).then(resolve, reject);
          }
          let rows = (tables[table] ?? []).filter((row) => filters.every((f) =>
            f.kind === "eq" ? row[f.column] === f.value : (f.value as unknown[]).includes(row[f.column])
          ));
          rows = [...rows].sort((a, b) => {
            for (const { column, ascending } of orders) {
              const x = a[column] as string | number;
              const y = b[column] as string | number;
              if (x < y) return ascending ? -1 : 1;
              if (x > y) return ascending ? 1 : -1;
            }
            return 0;
          });
          if (window) rows = rows.slice(window[0], window[1] + 1);
          if (limit !== null) rows = rows.slice(0, limit);
          rows = rows.slice(0, MAX_ROWS);
          const data = single ? rows[0] ?? null : rows;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client, inSizes };
}

const iso = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
// Many rows share each timestamp, so paging is stable only with a unique tie-breaker.
const sharedIso = (i: number) => iso(Math.floor(i / 7));

async function runM4FlashcardTests() {
  const cardsRoute = "../../app/api/flashcards/cards/route.ts";
  type Handler = (request?: Request) => Promise<Response>;
  const loadCards = (client: unknown) => loadWithMocks<{ GET: Handler }>(cardsRoute, {
    "@/lib/qf-user/session": { getUsableSession: async () => ({ player_id: "p1" }) },
    "@/lib/supabase/admin": { createAdminSupabaseClient: () => client },
  });

  await runCase("M4: flashcards GET returns every card past the 1000-row cap", async () => {
    const cards = Array.from({ length: 2500 }, (_, i) => ({ id: `c${String(i).padStart(4, "0")}`, user_id: "p1", word_id: `w${i}`, created_at: sharedIso(i) }));
    cards.push({ id: "other", user_id: "p2", word_id: "w0", created_at: iso(0) });
    const { client } = cappedSupabase({ user_flashcards: cards });
    const response = await loadCards(client).GET(new Request("https://app.test/api/flashcards/cards"));
    assert.equal(response.status, 200);
    const body = (await response.json()) as Row[];
    assert.equal(body.length, 2500, `got ${body.length} of 2500 cards`);
    assert.equal(new Set(body.map((c) => c.id)).size, 2500, "paging repeated or skipped cards");
    assert.ok(body.every((c) => c.user_id === "p1"));
  });

  await runCase("M4: a failed flashcard page is an error, not a silently short result", async () => {
    const cards = Array.from({ length: 1500 }, (_, i) => ({ id: `c${i}`, user_id: "p1", word_id: `w${i}`, created_at: iso(i) }));
    // The second page fails: the route must not return the first 1000 as if complete.
    const failing = cappedSupabase({ user_flashcards: cards }, (table, call) => table === "user_flashcards" && call === 2);
    assert.equal((await loadCards(failing.client).GET(new Request("https://app.test/api/flashcards/cards"))).status, 500);
  });
}

async function runL10Tests() {
  type Handler = (request: Request, context?: unknown) => Promise<Response>;
  const session = { player_id: "p1", access_token: "token", scopes: "openid bookmark" };
  const get = (url: string) => new Request(url);
  const json = (method: string, body: unknown) => new Request("https://app.test/api", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });


  await runCase("L10: reviews GET answers 400 to a non-numeric limit, offset or rating, and still caps the limit at 500", async () => {
    const reviews = Array.from({ length: 600 }, (_, i) => ({ id: `r${String(i).padStart(3, "0")}`, user_id: "p1", rating: 3, timestamp: iso(i) }));
    const { client } = cappedSupabase({ review_log: reviews });
    const route = loadWithMocks<{ GET: Handler }>("../../app/api/flashcards/reviews/route.ts", {
      "@/lib/qf-user/session": { getUsableSession: async () => session },
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => client },
    });
    for (const query of ["limit=abc", "offset=abc", "rating=abc", "limit=1.5", "offset=-1", "rating=9"]) {
      assert.equal((await route.GET(get(`https://app.test/api/flashcards/reviews?${query}`))).status, 400, `${query} was not refused`);
    }
    const capped = await route.GET(get("https://app.test/api/flashcards/reviews?limit=1000"));
    assert.equal(((await capped.json()) as unknown[]).length, 500);
    const defaults = await route.GET(get("https://app.test/api/flashcards/reviews"));
    assert.equal(((await defaults.json()) as unknown[]).length, 100);
  });


  await runCase("L10: card writes refuse a malformed fsrs_state or sm2_state", async () => {
    const good = { id: "c1", word_id: "w1", status: "IN_BANK", created_at: iso(0), fsrs_state: { due: iso(0), state: 0 } };
    const badStates: unknown[] = ["abc", null, [], {}, { due: "not a date", state: 0 }, { due: iso(0), state: 7 },
      { due: iso(0), state: 1, stability: "big" }, { due: iso(0), state: 1, last_review: 5 }];
    const badSm2: unknown[] = ["abc", { interval: 1 }, { interval: 1, repetitions: 0, easiness: "2.5", due: iso(0) },
      { interval: 1, repetitions: 0, easiness: 2.5, due: iso(0), phase: "sideways" }];

    const cards = fakeSupabase();
    const cardsRoute = loadWithMocks<{ POST: Handler; PUT: Handler }>("../../app/api/flashcards/cards/route.ts", {
      "@/lib/qf-user/session": { getUsableSession: async () => session },
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => cards.client },
    });
    for (const fsrs of badStates) {
      assert.equal((await cardsRoute.POST(json("POST", { ...good, fsrs_state: fsrs }))).status, 400, `POST fsrs_state ${JSON.stringify(fsrs)} was accepted`);
    }
    for (const sm2 of badSm2) {
      assert.equal((await cardsRoute.POST(json("POST", [good, { ...good, word_id: "w2", sm2_state: sm2 }]))).status, 400, `POST sm2_state ${JSON.stringify(sm2)} was accepted`);
    }
    assert.equal(cards.ops.length, 0, "a malformed card was written");

    // A batch import keeps the valid cards and reports the skipped ones, so one
    // corrupt local card can't block the sign-in migration for good.
    const putResponse = await cardsRoute.PUT(json("PUT", [good, { ...good, id: "c2", word_id: "w2", fsrs_state: "abc" }]));
    assert.equal(putResponse.status, 200);
    assert.equal(((await putResponse.json()) as { skipped?: number }).skipped, 1);
    const written = cards.ops.filter((op) => op.action === "upsert").flatMap((op) => op.payload as Row[]).map((row) => row.word_id);
    assert.deepEqual([...new Set(written)], ["w1"]);

    const patch = fakeSupabase();
    const patchRoute = loadWithMocks<{ PATCH: Handler }>("../../app/api/flashcards/cards/[id]/route.ts", {
      "@/lib/qf-user/session": { getUsableSession: async () => session },
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => patch.client },
    });
    const ctx = { params: Promise.resolve({ id: "c1" }) };
    assert.equal((await patchRoute.PATCH(json("PATCH", { fsrs_state: "abc" }), ctx)).status, 400);
    assert.equal((await patchRoute.PATCH(json("PATCH", { sm2_state: { interval: "x" } }), ctx)).status, 400);
    assert.deepEqual(patch.ops, []);
    assert.equal((await patchRoute.PATCH(json("PATCH", { fsrs_state: { due: iso(1), state: 2, stability: 3.1, last_review: iso(0) }, sm2_state: null }), ctx)).status, 200);
  });
}

async function runL18MuyassarTests() {
  await runCase("L18: Muyassar answers up to 8 verses in one request, the same as one at a time", async () => {
    const { NextRequest } = await import("next/server");
    const route = loadWithMocks<{ GET(r: InstanceType<typeof NextRequest>): Promise<Response> }>("../../app/api/muyassar/route.ts", {});
    const db = JSON.parse(readFileSync(path.join(ROOT, "data/al-muyassar-fi-al-gharib.json"), "utf8")) as Record<string, { text?: string }>;
    const keys = Object.keys(db).filter((k) => db[k]?.text).slice(0, 2).concat("1:999");
    const get = async (query: string) => {
      const response = await route.GET(new NextRequest(`https://app.test/api/muyassar?${query}`));
      return { status: response.status, body: await response.json() };
    };
    const batch = await get(`verses=${keys.join(",")}`);
    assert.equal(batch.status, 200);
    for (const key of keys) {
      const [surah, ayah] = key.split(":");
      const single = await get(`surah=${surah}&ayah=${ayah}`);
      assert.deepEqual(batch.body.results?.[key], single.body.entries, `verse ${key} differs between the batch and a single lookup`);
    }
    assert.equal((await get(`verses=${Array.from({ length: 9 }, (_, i) => `2:${i + 1}`).join(",")}`)).status, 400, "more than 8 verses were accepted");
    assert.equal((await get("verses=2:5,../x")).status, 400, "a malformed verse key was accepted");
  });

  await runCase("L18: a flashcard looks its Muyassar examples up in one request", () => {
    const source = readFileSync(path.join(ROOT, "src/components/flashcard/FlashcardReview.tsx"), "utf8");
    assert.doesNotMatch(source, /\/api\/muyassar\?surah=/, "the card still fetches one example at a time");
    assert.equal(source.match(/\/api\/muyassar\?verses=/g)?.length, 1);
  });
}

async function runL18HubTests() {
  await runCase("L18: the flashcards hub loads cards, preferences and the review log once each", async () => {
    const store = new Map<string, string>([["qalamspace_migrated_to_supabase", "true"]]);
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const now = new Date();
    const fsrs = (due: Date, state: number) => ({ due: due.toISOString(), stability: 3, difficulty: 5, elapsed_days: 1, scheduled_days: 1, learning_steps: 0, reps: state ? 2 : 0, lapses: 0, state });
    const card = (id: string, due: Date, state: number) => ({ id, word_id: `w-${id}`, status: "IN_BANK", created_at: iso(0), fsrs_state: fsrs(due, state), sm2_state: null, source_surah_id: null, source_ayah_number: null, source_juz_number: null, source_page_number: null });
    const cards = [card("a", new Date(now.getTime() - 3600_000), 2), card("b", now, 0), card("c", now, 0), card("d", new Date(now.getTime() + 86400_000 * 5), 2)];
    const reviews = [{ id: "r1", card_id: "a", word_id: "w-a", rating: 3, timestamp: new Date(now.getTime() - 86400_000).toISOString(), session_id: "s", review_duration_ms: 1, state_before: 2, state_after: 2 }];
    const gets: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      gets.push(u.split("?")[0]);
      if (u.startsWith("/api/flashcards/cards")) return new Response(JSON.stringify(cards), { status: 200 });
      if (u.startsWith("/api/flashcards/preferences")) return new Response(JSON.stringify(null), { status: 200 });
      if (u.startsWith("/api/flashcards/reviews")) {
        const start = new URL(u, "https://app.test").searchParams.get("start_date");
        return new Response(JSON.stringify(start ? reviews.filter((r) => r.timestamp >= start) : reviews), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const manager = await import("@/lib/flashcard/session-manager");
      const separate = { due: await manager.getDueCardsCount(), newCards: await manager.getNewCardsCount() };
      gets.length = 0;
      const summary = await manager.getHubSummary();
      const count = (path: string) => gets.filter((g) => g === path).length;
      assert.deepEqual(
        { cards: count("/api/flashcards/cards"), preferences: count("/api/flashcards/preferences"), reviews: count("/api/flashcards/reviews") },
        { cards: 1, preferences: 1, reviews: 1 },
        `the hub made ${JSON.stringify(gets)}`
      );
      assert.equal(summary.due, separate.due);
      assert.equal(summary.newCards, separate.newCards);
      assert.equal(summary.totalCards, 4);
      assert.equal(typeof summary.streak, "number");
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
    const page = readFileSync(path.join(ROOT, "src/app/train/flashcards/page.tsx"), "utf8");
    assert.match(page, /getHubSummary\(\)/);
    assert.doesNotMatch(page, /getDueCardsCount|getNewCardsCount|getReviewLog\(/, "the hub page still loads the data more than once");
  });
}

function unstableTiesSupabase(rows: Row[]) {
  let call = 0;
  return {
    from() {
      const filters: Array<[string, unknown]> = [];
      const orders: Array<{ column: string; ascending: boolean }> = [];
      let window: [number, number] = [0, Number.MAX_SAFE_INTEGER];
      const builder = {
        select() { return builder; },
        eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
        gte() { return builder; },
        lte() { return builder; },
        order(column: string, options?: { ascending?: boolean }) { orders.push({ column, ascending: options?.ascending ?? true }); return builder; },
        range(from: number, to: number) { window = [from, to]; return builder; },
        then(resolve: (value: unknown) => unknown) {
          call += 1;
          const matching = rows.filter((row) => filters.every(([c, v]) => row[c] === v));
          // Reverse on every other request before the (stable) sort, so ties
          // come out in a different order on consecutive pages.
          const rotated = call % 2 === 0 ? [...matching] : [...matching].reverse();
          rotated.sort((a, b) => {
            for (const { column, ascending } of orders) {
              const x = a[column] as string;
              const y = b[column] as string;
              if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          });
          return Promise.resolve({ data: rotated.slice(window[0], window[1] + 1), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

async function runA4R4Tests() {
  await runCase("A4R4: paging the review log neither repeats nor skips reviews that share a timestamp", async () => {
    const { loadWithMocks } = await import("@/lib/flashcard/api-routes.test");
    const stamp = (i: number) => new Date(Date.UTC(2026, 9, 1) + Math.floor(i / 7) * 60_000).toISOString();
    const reviews = Array.from({ length: 600 }, (_, i) => ({ id: `r${String(i).padStart(3, "0")}`, user_id: "p1", rating: 3, timestamp: stamp(i) }));
    const client = unstableTiesSupabase(reviews);
    const route = loadWithMocks<{ GET: (request: Request) => Promise<Response> }>("../../app/api/flashcards/reviews/route.ts", {
      "@/lib/qf-user/session": { getUsableSession: async () => ({ player_id: "p1" }) },
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => client },
    });
    const seen: string[] = [];
    for (let offset = 0; offset < 600; offset += 100) {
      const response = await route.GET(new Request(`https://app.test/api/flashcards/reviews?limit=100&offset=${offset}`));
      seen.push(...((await response.json()) as Row[]).map((r) => r.id as string));
    }
    assert.equal(seen.length, 600);
    assert.equal(new Set(seen).size, 600, `paging repeated ${600 - new Set(seen).size} reviews and skipped as many`);
    const times = seen.map((id) => reviews[Number(id.slice(1))].timestamp);
    assert.deepEqual(times, [...times].sort().reverse(), "the log is no longer newest-first");
  });
}

async function runA4R5Tests() {
  const { loadWithMocks, fakeSupabase } = await import("@/lib/flashcard/api-routes.test");
  type Handler = (request: Request) => Promise<Response>;
  const iso = "2026-10-01T00:00:00.000Z";
  const card = (word: string, fsrs: unknown, extra: Row = {}) => ({
    id: `local-${word}`, word_id: word, status: "IN_BANK", created_at: iso, fsrs_state: fsrs,
    source_surah_id: null, source_ayah_number: null, source_juz_number: null, source_page_number: null, ...extra,
  });
  const fsrs = { due: iso, stability: 2, difficulty: 5, elapsed_days: 1, scheduled_days: 2, learning_steps: 0, reps: 3, lapses: 0, state: 2 };
  const { state: _dropped, ...noState } = fsrs;
  void _dropped;
  const localDeck = [
    card("good", fsrs),
    card("no-state", noState), // recoverable: reviewed 3 times, so a review card
    card("broken", "abc"), // no usable state at all
    card("no-due", { ...fsrs, due: "someday" }),
  ];

  /** A browser whose card writes go through the real cards route (with a fake database). */
  async function withCardsBrowser(store: Map<string, string>, fn: (env: { upserted: () => string[] }) => Promise<void>) {
    const db = fakeSupabase();
    const route = loadWithMocks<{ PUT: Handler }>("../../app/api/flashcards/cards/route.ts", {
      "@/lib/qf-user/session": { getUsableSession: async () => ({ player_id: "p1" }) },
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => db.client },
    });
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/flashcards/cards" && method === "PUT") {
        return route.PUT(new Request("https://app.test/api/flashcards/cards", { method, headers: { "Content-Type": "application/json" }, body: init?.body }));
      }
      if (url === "/api/flashcards/preferences" && method === "GET") return new Response("null", { status: 200 });
      return new Response(method === "GET" ? "[]" : JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      await fn({
        upserted: () => [...new Set(db.ops.filter((op) => op.action === "upsert").flatMap((op) => (op.payload as Row[]).map((r) => r.word_id as string)))],
      });
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
  }

  await runCase("A4R5: the sign-in migration keeps the cards it can't upload on the device, reports them, and still completes", async () => {
    const store = new Map([["qalamspace_flashcards", JSON.stringify(localDeck)]]);
    await withCardsBrowser(store, async ({ upserted }) => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      assert.equal(await storage.migrateFromLocalStorage(), true, "the migration did not complete");
      assert.equal(store.get("qalamspace_migrated_to_supabase"), "true");
      assert.deepEqual(upserted().sort(), ["good", "no-state"], "the recoverable card was not uploaded, or a broken one was");
      assert.equal(storage.getUnsyncedFlashcardCount(), 2, "the skipped cards are not kept for the user");
      assert.deepEqual((JSON.parse(store.get("qalamspace_flashcards_unsynced") ?? "[]") as Row[]).map((c) => c.word_id), ["broken", "no-due"]);
      // Later loads don't upload again, and the kept cards stay.
      assert.equal(await storage.migrateFromLocalStorage(), false);
      assert.equal(storage.getUnsyncedFlashcardCount(), 2);
    });
  });

  await runCase("A4R5: an import reports how many cards were skipped, and fills in a missing state", async () => {
    await withCardsBrowser(new Map(), async ({ upserted }) => {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      const result = await storage.importData(JSON.stringify({ flashcards: localDeck, reviews: [], preferences: null }));
      assert.equal(result.skippedCards.length, 2, "the import does not say how many cards were skipped");
      assert.deepEqual(upserted().sort(), ["good", "no-state"]);
    });
    const { normalizeImportedCard } = await import("@/lib/flashcard/import-cards");
    assert.equal(normalizeImportedCard(card("x", noState))?.fsrs_state.state, 2, "a reviewed card without a state is not a review card");
    assert.equal(normalizeImportedCard(card("x", { due: iso }))?.fsrs_state.state, 0, "an unreviewed card without a state is not new");
    assert.ok(normalizeImportedCard(card("x", fsrs, { created_at: "garbage" }))?.created_at instanceof Date);
    assert.equal(Number.isNaN(normalizeImportedCard(card("x", fsrs, { created_at: "garbage" }))!.created_at.getTime()), false);
    for (const bad of [card("x", "abc"), card("x", null), card("", fsrs), card("x", fsrs, { status: "LEARNING" }), null, "card"]) {
      assert.equal(normalizeImportedCard(bad), null, `${JSON.stringify(bad)?.slice(0, 60)} was accepted`);
    }
  });

  await runCase("A4R5: the cards PUT says which cards it skipped, and a bad status or word is skipped, not a 500", async () => {
    const db = fakeSupabase();
    const route = loadWithMocks<{ PUT: Handler }>("../../app/api/flashcards/cards/route.ts", {
      "@/lib/qf-user/session": { getUsableSession: async () => ({ player_id: "p1" }) },
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => db.client },
    });
    const response = await route.PUT(new Request("https://app.test/api", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify([card("good", fsrs), card("bad-status", fsrs, { status: "LEARNING" }), card("", fsrs), card("broken", "abc")]) }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, skipped: 3, skipped_indexes: [1, 2, 3] });
  });

  await runCase("A4R5: the flashcards hub tells the user about cards kept on the device", () => {
    const source = readFileSync(path.join(ROOT, "src/app/train/flashcards/page.tsx"), "utf8");
    assert.match(source, /getUnsyncedFlashcardCount\(\)/, "the hub never reads the skipped-card count");
  });
}

async function runA4R7Tests() {
  await runCase("A4R7: the progress page loads cards, preferences and the review log once each", async () => {
    const store = new Map<string, string>([["qalamspace_migrated_to_supabase", "true"]]);
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const now = new Date();
    const fsrs = (due: Date, state: number) => ({ due: due.toISOString(), stability: 3, difficulty: 5, elapsed_days: 1, scheduled_days: 1, learning_steps: 0, reps: state ? 2 : 0, lapses: 0, state });
    const card = (id: string, due: Date, state: number, status = "IN_BANK") => ({ id, word_id: `w-${id}`, status, created_at: now.toISOString(), fsrs_state: fsrs(due, state), sm2_state: null, source_surah_id: null, source_ayah_number: null, source_juz_number: null, source_page_number: null });
    const cards = [card("a", new Date(now.getTime() - 3600_000), 2), card("b", now, 0), card("c", now, 0), card("k", now, 0, "KNOWN_NOT_IN_BANK")];
    const reviews = [
      { id: "r1", card_id: "a", word_id: "w-a", rating: 3, timestamp: new Date(now.getTime() - 86400_000).toISOString(), session_id: "s", review_duration_ms: 1, state_before: 2, state_after: 2 },
      { id: "r2", card_id: "b", word_id: "w-b", rating: 3, timestamp: now.toISOString(), session_id: "s", review_duration_ms: 1, state_before: 0, state_after: 1 },
    ];
    const gets: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      gets.push(u.split("?")[0]);
      if (u.startsWith("/api/flashcards/cards")) return new Response(JSON.stringify(cards), { status: 200 });
      if (u.startsWith("/api/flashcards/preferences")) return new Response(JSON.stringify(null), { status: 200 });
      if (u.startsWith("/api/flashcards/reviews")) {
        const start = new URL(u, "https://app.test").searchParams.get("start_date");
        return new Response(JSON.stringify(start ? reviews.filter((r) => r.timestamp >= start) : reviews), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const manager = await import("@/lib/flashcard/session-manager");
      const separate = { due: await manager.getDueCardsCount(), newCards: await manager.getNewCardsCount() };
      gets.length = 0;
      const overview = await manager.getFlashcardOverview();
      const count = (p: string) => gets.filter((x) => x === p).length;
      assert.deepEqual(
        { cards: count("/api/flashcards/cards"), preferences: count("/api/flashcards/preferences"), reviews: count("/api/flashcards/reviews") },
        { cards: 1, preferences: 1, reviews: 1 },
        `the overview made ${JSON.stringify(gets)}`
      );
      assert.equal(overview.due, separate.due);
      assert.equal(overview.newCards, separate.newCards);
      assert.equal(overview.cards.length, 4, "the overview must return every card, as getFlashcards does");
      assert.deepEqual(overview.reviews.map((r) => r.id), ["r1", "r2"]);
    } finally {
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
    const page = readFileSync(path.join(ROOT, "src/app/progress/ProgressPageClient.tsx"), "utf8");
    assert.match(page, /getFlashcardOverview\(\)/);
    assert.doesNotMatch(page, /getDueCardsCount|getNewCardsCount|getFlashcards\(|getReviewLog\(/, "the progress page still loads the flashcard data more than once");
  });
}

async function runA4R10FlashcardTests() {
  await runCase("A4R10: settle() never rejects, whatever the work does", async () => {
    const { settle } = await import("@/lib/settle");
    assert.deepEqual(await settle(async () => 5), { ok: true, value: 5 });
    const boom = new Error("boom");
    assert.deepEqual(await settle(async () => { throw boom; }), { ok: false, error: boom });
    assert.deepEqual(await settle(() => { throw "sync"; }), { ok: false, error: "sync" });
    assert.deepEqual(await settle(() => Promise.reject(undefined)), { ok: false, error: undefined });
  });

  await runCase("A4R10: the flashcard settings and stats pages reset busy and loading right after an await that cannot reject", () => {
    const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
    const settings = read("src/app/train/flashcards/settings/page.tsx");
    const stats = read("src/app/train/flashcards/stats/page.tsx");
    // `await call(...)` (its body may span lines, but not another call to it), then the reset.
    const resetAfter = (flag: string, call: string) => new RegExp(`await ${call}\\((?:(?!${call}\\()[\\s\\S])*?\\);\\s*${flag}\\(false\\);`, "g");
    assert.equal(settings.match(resetAfter("setBusy", "settle"))?.length, 2, "save and reset don't clear busy straight after a settled await");
    assert.equal(settings.match(resetAfter("setLoading", "settle"))?.length, 1, "the settings load doesn't clear loading straight after a settled await");
    assert.equal(stats.match(resetAfter("setLoading", "settle"))?.length, 1, "the stats load doesn't clear loading straight after a settled await");
  });
}

export async function runFlashcardDataTests() {
  await runM4FlashcardTests();
  await runL10Tests();
  await runL18MuyassarTests();
  await runL18HubTests();
  await runA4R4Tests();
  await runA4R5Tests();
  await runA4R7Tests();
  await runA4R10FlashcardTests();
}
