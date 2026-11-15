import assert from "node:assert/strict";
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
}
