import assert from "node:assert/strict";
import { loadWithMocks } from "@/lib/flashcard/api-routes.test";
import { cappedSupabase } from "@/lib/flashcard/data-fixes.test";

// M4 (the non-flashcard reads): PostgREST returns at most 1000 rows per
// request and refuses a URL longer than about 8 KB. The memorization GET and
// the play progress read must page past the first, keep their .in() lookups
// under the second, and treat any failed query as an error. The fake client
// enforces both limits; scripts/test-m4-row-cap-local.mjs runs the same reads
// against the local stack's real PostgREST.

async function runCase(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`ok - ${name}`);
}

type Row = Record<string, unknown>;

const iso = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
// Many rows share each timestamp, so paging is stable only with a unique tie-breaker.
const sharedIso = (i: number) => iso(Math.floor(i / 7));
const uuid = (prefix: string, i: number) => `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;

const attemptsRoute = "../../app/api/memorization/attempts/route.ts";
const playServer = "../../lib/progress/play-server.ts";
type Handler = (request: Request) => Promise<Response>;
type Progress = { events: Array<{ id: string }>; player: unknown; hotspots: unknown[] };

const loadAttempts = (client: unknown) => loadWithMocks<{ GET: Handler }>(attemptsRoute, {
  "@/lib/multiplayer/resolve-player": { resolvePlayerId: async () => "p1" },
  "@/lib/supabase/admin": { createAdminSupabaseClient: () => client },
});
const loadProgress = (client: unknown) => loadWithMocks<{ getPlayerPlayProgress(id: string): Promise<Progress> }>(
  playServer,
  { "@/lib/supabase/admin": { createAdminSupabaseClient: () => client } },
);

/** Runs `fn` with fetch refused, so no verse lookup can leave the test. */
async function withoutNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("no network in tests"); }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

export async function runRowCapTests() {
  await runCase("M4: memorization GET returns every attempt, not only the oldest 1000", async () => {
    const attempts = Array.from({ length: 1500 }, (_, i) => ({
      id: uuid("aaaaaaaa", i), player_id: "p1", client_attempt_id: `k${i}`, tested_at: sharedIso(i),
    }));
    attempts.push({ id: uuid("bbbbbbbb", 0), player_id: "p2", client_attempt_id: "other", tested_at: iso(0) });
    const { client } = cappedSupabase({ memorization_attempts: attempts });
    const response = await loadAttempts(client).GET(new Request("https://app.test/api/memorization/attempts"));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { attempts: Row[] };
    assert.equal(body.attempts.length, 1500, `got ${body.attempts.length} of 1500 attempts`);
    assert.equal(new Set(body.attempts.map((a) => a.id)).size, 1500, "paging repeated or skipped attempts");
    assert.ok(body.attempts.every((a) => a.player_id === "p1"));
    assert.equal(body.attempts.at(-1)?.client_attempt_id, "k1499", "the newest attempt is missing");
    const times = body.attempts.map((a) => a.tested_at as string);
    assert.deepEqual(times, [...times].sort(), "attempts are not oldest-first");
  });

  await runCase("M4: progress loads every answer and looks rounds up in URLs the API accepts", async () => {
    const rounds = Array.from({ length: 900 }, (_, i) => ({
      id: uuid("cccccccc", i), game_mode: "multiple-choice",
      prompt_verse_key: "1:1", prompt_surah_id: 1, prompt_juz_number: 1, prompt_page_number: 1, options: [],
    }));
    const answers = Array.from({ length: 1800 }, (_, i) => ({
      id: uuid("dddddddd", i), player_id: "p1", round_id: rounds[i % 900].id,
      is_correct: i % 2 === 0, points_awarded: 10, server_received_at: sharedIso(i),
    }));
    const { client, inSizes } = cappedSupabase({
      players: [{ id: "p1", display_name: "P", total_points: 0, total_wins: 0, created_at: iso(0) }],
      round_answers: answers, game_rounds: rounds, verse_mistakes: [],
    });
    const progress = await withoutNetwork(() => loadProgress(client).getPlayerPlayProgress("p1"));
    assert.equal(progress.events.length, 1800, `got ${progress.events.length} of 1800 play events`);
    assert.equal(new Set(progress.events.map((e) => e.id)).size, 1800, "paging repeated or skipped answers");
    const roundLookups = inSizes.filter((s) => s.table === "game_rounds");
    assert.ok(roundLookups.length > 0);
    assert.ok(
      roundLookups.every((s) => s.size <= 100),
      `a round lookup put ${Math.max(...roundLookups.map((s) => s.size))} ids in one URL`,
    );
  });

  await runCase("M4: a failed memorization page is an error, not a silently short result", async () => {
    const attempts = Array.from({ length: 1200 }, (_, i) => ({ id: uuid("aaaaaaaa", i), player_id: "p1", client_attempt_id: `k${i}`, tested_at: iso(i) }));
    // The second page fails: the route must not return the first 1000 as if complete.
    const failing = cappedSupabase({ memorization_attempts: attempts }, (table, call) => table === "memorization_attempts" && call === 2);
    const response = await loadAttempts(failing.client).GET(new Request("https://app.test/api/memorization/attempts"));
    assert.equal(response.status, 500);
  });

  await runCase("M4: a failed progress query is an error, not an empty play history", async () => {
    for (const table of ["players", "round_answers", "game_rounds", "verse_mistakes"]) {
      const broken = cappedSupabase({
        players: [{ id: "p1" }],
        round_answers: [{ id: "a", player_id: "p1", round_id: "r", server_received_at: iso(0) }],
        game_rounds: [{ id: "r", game_mode: "multiple-choice", prompt_verse_key: "1:1", prompt_surah_id: 1, prompt_juz_number: 1, prompt_page_number: 1 }],
        verse_mistakes: [],
      }, (t) => t === table);
      await assert.rejects(
        withoutNetwork(() => loadProgress(broken.client).getPlayerPlayProgress("p1")),
        `a ${table} error was ignored`,
      );
    }
  });
}
