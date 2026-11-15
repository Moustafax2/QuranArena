import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeSupabase, loadWithMocks } from "@/lib/flashcard/api-routes.test";
import type { RecordedOp } from "@/lib/flashcard/api-routes.test";

// Regression tests for the code review of the flashcard port onto main
// (git diff 1818c0a..HEAD). Each was seen failing before its fix.

async function runCase(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`ok - ${name}`);
}

type Handler = (request: Request) => Promise<Response>;
type Row = Record<string, unknown>;

function jsonRequest(method: string, body: unknown) {
  return new Request("https://app.test/api", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function inListSizes(ops: RecordedOp[], table: string): number[] {
  return ops
    .filter((op) => op.table === table)
    .flatMap((op) => op.filters.filter(([kind]) => kind === "in").map(([, , value]) => (value as unknown[]).length));
}

export async function runFlashcardReviewFixTests() {
  await runCase("Review #1: the reviews upload looks cards up at most 100 word ids per request", async () => {
    const words = Array.from({ length: 500 }, (_, i) => `w${i}`);
    const db = fakeSupabase((op) =>
      op.table === "user_flashcards" && op.action === "select"
        ? { data: (op.filters.find(([kind]) => kind === "in")![2] as string[]).map((w) => ({ id: `card-${w}`, word_id: w })) }
        : {}
    );
    const route = loadWithMocks<{ POST: Handler }>("../../app/api/flashcards/reviews/route.ts", {
      "@/lib/qf-user/session": { getUsableSession: async () => ({ player_id: "p1" }) },
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => db.client },
    });
    const reviews = words.map((w, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, card_id: `local-${w}`, word_id: w, rating: 3,
      timestamp: "2026-11-01T10:00:00.000Z", session_id: "00000000-0000-4000-8000-000000000999",
      review_duration_ms: 1000, state_before: 0, state_after: 1,
    }));
    const response = await route.POST(jsonRequest("POST", reviews));
    assert.equal(response.status, 200);
    const sizes = inListSizes(db.ops, "user_flashcards");
    // Each id goes into the request URL; 500 encoded word ids can pass URL limits.
    assert.ok(sizes.length > 0 && Math.max(...sizes) <= 100, `a card lookup put ${Math.max(...sizes)} word ids in one request`);
    const written = db.ops.filter((op) => op.table === "review_log" && op.action === "upsert").flatMap((op) => op.payload as Row[]);
    assert.equal(written.length, 500, "a review was lost in the chunked lookup");
  });

  await runReviewUploadValidationTests();
  await runUnknownWordTests();
  await runReviewPageLockTests();
}

async function runReviewUploadValidationTests() {
  const good = {
    id: "00000000-0000-4000-8000-000000000001", card_id: "local-w1", word_id: "w1", rating: 3,
    timestamp: "2026-11-01T10:00:00.000Z", session_id: "00000000-0000-4000-8000-000000000999",
    review_duration_ms: 1000, state_before: 0, state_after: 1,
  };
  const bad = [
    { ...good, id: "00000000-0000-4000-8000-000000000002", rating: 7 },
    { ...good, id: "00000000-0000-4000-8000-000000000003", state_after: 9 },
    { ...good, id: "not-a-uuid" },
    { ...good, id: "00000000-0000-4000-8000-000000000004", timestamp: "garbage" },
    { ...good, id: "00000000-0000-4000-8000-000000000005", session_id: "s" },
    { ...good, id: "00000000-0000-4000-8000-000000000006", review_duration_ms: 1.5 },
  ];

  await runCase("Review #4: one malformed review no longer fails the whole reviews upload", async () => {
    const db = fakeSupabase((op) =>
      op.table === "user_flashcards" && op.action === "select" ? { data: [{ id: "card-w1", word_id: "w1" }] } : {}
    );
    const route = loadWithMocks<{ POST: Handler }>("../../app/api/flashcards/reviews/route.ts", {
      "@/lib/qf-user/session": { getUsableSession: async () => ({ player_id: "p1" }) },
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => db.client },
    });
    const response = await route.POST(jsonRequest("POST", [good, ...bad]));
    assert.equal(response.status, 200, "a malformed review failed the batch");
    assert.equal(((await response.json()) as { skipped?: number }).skipped, bad.length);
    const written = db.ops.filter((op) => op.table === "review_log" && op.action === "upsert").flatMap((op) => op.payload as Row[]);
    assert.deepEqual(written.map((r) => r.id), [good.id]);
    // A single review (the review page's own save) that is malformed is still refused.
    assert.equal((await route.POST(jsonRequest("POST", bad[0]))).status, 400);
  });

  await runCase("Review #4: an import with a review whose time can't be read uploads the others", async () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
    g.window = globalThis;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/flashcards/reviews" && init?.method === "POST") posted.push(...(JSON.parse(String(init.body)) as Row[]));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const warn = console.warn;
    console.warn = () => {};
    try {
      const storage = await import("@/lib/storage/flashcard-storage-supabase");
      await storage.importData(JSON.stringify({ reviews: [good, { ...good, id: "00000000-0000-4000-8000-000000000007", timestamp: "garbage" }] }));
      assert.deepEqual(posted.map((r) => r.id), [good.id]);
    } finally {
      console.warn = warn;
      g.window = saved.window;
      g.localStorage = saved.localStorage;
      globalThis.fetch = saved.fetch;
    }
  });
}

async function runUnknownWordTests() {
  await runCase("Review #3: a card whose word is not in the word list is skipped and reported, not a failed import", async () => {
    const known = new Set(["w-known"]);
    const db = fakeSupabase((op) => {
      if (op.table !== "lexical_entries") return {};
      const words = (op.filters.find(([kind]) => kind === "in")?.[2] ?? []) as string[];
      return { data: words.filter((w) => known.has(w)).map((word_id) => ({ word_id })) };
    });
    const route = loadWithMocks<{ PUT: Handler }>("../../app/api/flashcards/cards/route.ts", {
      "@/lib/qf-user/session": { getUsableSession: async () => ({ player_id: "p1" }) },
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => db.client },
    });
    const card = (id: string, word: string) => ({
      id, word_id: word, status: "IN_BANK", created_at: "2026-10-01T00:00:00.000Z",
      fsrs_state: { due: "2026-10-01T00:00:00.000Z", state: 0 },
    });
    // user_flashcards.word_id references lexical_entries, so an unknown word
    // (an id from an older word list) would fail the whole insert.
    const response = await route.PUT(jsonRequest("PUT", [card("a", "w-known"), card("b", "w-renamed"), card("c", "w-known-2")]));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, skipped: 2, skipped_indexes: [1, 2] });
    const written = db.ops.filter((op) => op.table === "user_flashcards" && op.action === "upsert").flatMap((op) => (op.payload as Row[]).map((r) => r.word_id));
    assert.deepEqual([...new Set(written)], ["w-known"]);
    const sizes = inListSizes(db.ops, "lexical_entries");
    assert.ok(sizes.length > 0 && Math.max(...sizes) <= 100);
  });
}

async function runReviewPageLockTests() {
  await runCase("Review #5: deleting or skipping a card waits for a rating save in flight, and vice versa", () => {
    const page = readFileSync("src/app/train/flashcards/review/page.tsx", "utf8");
    // The same lock as rating and undo (A1-review #3): a save that finishes
    // after a delete would otherwise put the deleted card back in the session.
    for (const handler of ["handleReview", "handleUndo", "handleDelete", "handleSkipMissing"]) {
      assert.match(page, new RegExp(`const ${handler} = [^\\n]*runExclusive\\(busyRef,`), `${handler} does not take the review lock`);
    }
  });
}
