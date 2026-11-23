import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  joinRoomReply,
  malformedSubmitReply,
  startGameReply,
  submitAnswerReply,
  toRoundRows,
} from "../../../supabase/functions/_shared/multiplayer-rpc";
import { effectiveTimePerQuestion } from "./room-settings";
import { loadWithMocks } from "@/lib/flashcard/api-routes.test";

// H1 / M3 / H5: the races themselves need real concurrent transactions, so
// they run against the local stack in scripts/test-multiplayer-races-local.mjs
// (outside npm test). These cases check the pieces that need no database: the
// edge functions route every transition through one SQL call and check its
// error, the replies keep main's status codes and messages, and the deadline
// the app shows uses the same clamp as the SQL.

const root = process.cwd();
const source = (file: string) => readFileSync(path.join(root, file), "utf8");
/** Source without line and block comments, for "the code no longer does X" checks. */
const code = (file: string) => source(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(--|\/\/).*$/gm, "");

async function runCase(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`ok - ${name}`);
}

export async function runMultiplayerTests() {
  await runCase("H1/M3: the edge functions make each transition one SQL call and check its error", () => {
    const gameState = code("supabase/functions/_shared/game-state.ts");
    assert.doesNotMatch(gameState, /increment_player_score|increment_player_stats|endRound/, "game-state.ts still adds points outside the claim");
    assert.match(gameState, /rpc\("mp_advance_round"/);

    const submit = code("supabase/functions/submit-answer/index.ts");
    assert.match(submit, /rpc\("mp_submit_answer"/, "submit-answer does not use mp_submit_answer");
    assert.doesNotMatch(submit, /from\("round_answers"\)|from\("verse_mistakes"\)|endRound/, "submit-answer still reads or writes answers itself");

    const start = code("supabase/functions/start-game/index.ts");
    assert.match(start, /rpc\("mp_start_game"/, "start-game does not use mp_start_game");
    assert.doesNotMatch(start, /from\("games"\)|from\("game_rounds"\)/, "start-game still inserts the game itself");

    const join = code("supabase/functions/join-room/index.ts");
    assert.match(join, /rpc\("mp_join_room"/, "join-room does not use mp_join_room");
    assert.doesNotMatch(join, /from\("room_players"\)/, "join-room still counts and inserts players itself");

    for (const file of ["supabase/functions/_shared/game-state.ts", "supabase/functions/submit-answer/index.ts", "supabase/functions/start-game/index.ts", "supabase/functions/join-room/index.ts"]) {
      const body = code(file);
      assert.ok(/\.rpc\(/.test(body), `${file} makes no RPC call`);
      for (const call of body.matchAll(/const \{ (?:data(?:: \w+)?, )?error(?:: (\w+))? \} = await admin\s*\.rpc\(/g)) {
        assert.match(body, new RegExp(`if \\(${call[1] ?? "error"}\\)`), `${file} ignores the RPC error`);
      }
    }
  });

  await runCase("H1/M3: the edge replies keep main's status codes and messages", () => {
    assert.deepEqual(submitAnswerReply({ status: "ok", is_correct: true, points_awarded: 8, round_ended: false }), { status: 200, body: { is_correct: true, points_awarded: 8 } });
    assert.deepEqual(submitAnswerReply({ status: "buzzer_winner" }), { status: 200, body: { buzzer_winner: true } });
    assert.deepEqual(submitAnswerReply({ status: "buzzer_taken" }), { status: 409, body: { error: "Someone else buzzed first" } });
    assert.deepEqual(submitAnswerReply({ status: "already_answered" }), { status: 400, body: { error: "Already answered this round" } });
    assert.deepEqual(submitAnswerReply({ status: "game_ended" }), { status: 400, body: { error: "Game has already ended" } });
    assert.deepEqual(submitAnswerReply({ status: "game_not_found" }), { status: 404, body: { error: "Game not found" } });
    assert.deepEqual(submitAnswerReply({ status: "round_not_found" }), { status: 404, body: { error: "Round not found" } });
    assert.deepEqual(submitAnswerReply({ status: "not_participant" }), { status: 403, body: { error: "You are no longer an active participant in this game" } });
    // The two new refusals: answers main wrongly accepted (H1, H5).
    assert.equal(submitAnswerReply({ status: "round_not_open" }).status, 409);
    assert.equal(submitAnswerReply({ status: "time_up" }).status, 409);
    assert.deepEqual(submitAnswerReply(null), { status: 500, body: { error: "Unexpected multiplayer result" } });

    assert.deepEqual(startGameReply({ status: "ok", game_id: "g", total_rounds: 3, first_round_id: "r" }), { status: 200, body: { game_id: "g", total_rounds: 3 } });
    assert.deepEqual(startGameReply({ status: "room_not_found" }), { status: 404, body: { error: "Room not found" } });
    assert.deepEqual(startGameReply({ status: "not_host" }), { status: 403, body: { error: "Only the host can start the game" } });
    assert.deepEqual(startGameReply({ status: "already_started" }), { status: 400, body: { error: "Game already started" } });
    assert.deepEqual(startGameReply({ status: "no_players" }), { status: 400, body: { error: "No active players remain in this room" } });
    assert.deepEqual(startGameReply({ status: "invalid_rounds" }), { status: 400, body: { error: "questions array is required" } });

    assert.deepEqual(joinRoomReply({ status: "room_full" }), { status: 400, body: { error: "Room is full (max 8 players)" } });
    assert.deepEqual(joinRoomReply({ status: "not_lobby" }), { status: 400, body: { error: "Game already in progress" } });
    assert.deepEqual(joinRoomReply({ status: "room_not_found" }), { status: 404, body: { error: "Room not found" } });
    assert.deepEqual(joinRoomReply({ status: "left_room" }), { status: 403, body: { error: "You already left this game and cannot rejoin it." } });
    assert.deepEqual(
      joinRoomReply({ status: "ok", room_id: "r", code: "ABC123", host_id: "h", game_mode: "trivia", settings: { num_rounds: 5 } }),
      { status: 200, body: { room_id: "r", code: "ABC123", host_id: "h", game_mode: "trivia", settings: { num_rounds: 5 } } },
    );

    // A malformed id gets the reply its lookup gave before, in main's order.
    const id = "11111111-1111-4111-8111-111111111111";
    assert.deepEqual(malformedSubmitReply({ game_id: "x", player_id: id, round_id: id }), { status: 404, body: { error: "Game not found" } });
    assert.equal(malformedSubmitReply({ game_id: id, player_id: 5, round_id: id })?.status, 403);
    assert.deepEqual(malformedSubmitReply({ game_id: id, player_id: id, round_id: "r1" }), { status: 404, body: { error: "Round not found" } });
    assert.equal(malformedSubmitReply({ game_id: id, player_id: id, round_id: id }), null);
  });

  await runCase("M3: start-game shapes the rounds as it always stored them", () => {
    const rows = toRoundRows([
      { prompt_verse_key: "1:1", prompt_text: "p", correct_verse_key: "1:2", correct_text: "c", options: [{ verse_key: "1:2", text: "c" }], game_mode: "trivia", prompt_surah_id: 1 },
      { prompt_verse_key: "2:1", prompt_text: "p2", correct_verse_key: "2:2", correct_text: "c2", options: [] },
    ]);
    assert.deepEqual(rows[0], {
      game_mode: "trivia", prompt_verse_key: "1:1", prompt_surah_id: 1, prompt_juz_number: null, prompt_page_number: null,
      correct_verse_key: "1:2", prompt_text: "p", correct_text: "c", options: ['{"verse_key":"1:2","text":"c"}'],
    });
    assert.equal(rows[1].options, null);
    assert.equal(rows[1].game_mode, null);
  });

  await runCase("H5: the app's time per question uses the same clamp as the SQL deadline", () => {
    const sql = source("supabase/migrations/014_multiplayer_atomic_transitions.sql");
    const clamp = /least\(greatest\(\(settings ->> 'time_per_question'\)::numeric, (\d+)\), (\d+)\)\)::integer\s+else (\d+)/.exec(sql);
    assert.ok(clamp, "mp_time_per_question's clamp not found in 014");
    const [min, max, fallback] = clamp!.slice(1).map(Number);
    assert.equal(effectiveTimePerQuestion({ time_per_question: 1 }), min);
    assert.equal(effectiveTimePerQuestion({ time_per_question: 10_000 }), max);
    assert.equal(effectiveTimePerQuestion({}), fallback);
    assert.equal(effectiveTimePerQuestion(null), fallback);
    assert.equal(effectiveTimePerQuestion({ time_per_question: "45" }), fallback, "a string is not a number in jsonb_typeof either");
    assert.equal(effectiveTimePerQuestion({ time_per_question: 45 }), 45);
  });

  await runCase("H1/M3/H5: migration 014 is service-role only and leaves out the non-Part-1 rules", () => {
    const sql = code("supabase/migrations/014_multiplayer_atomic_transitions.sql");
    assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated;/);
    assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/i);
    assert.doesNotMatch(sql, /alter table|add column|create table/i, "014 adds no table or column");
    // Coordinator decision 2: no 50-round cap (M2), no rejoin of a left lobby (L19), no tie wins (L6).
    assert.doesNotMatch(sql, /between 1 and 50/);
    assert.match(sql, /'left_room'/);
    assert.doesNotMatch(sql, /winner_ids|v_top > 0/);
  });

  await runCase("H5: the state route sends each round's deadline and the server clock", async () => {
    const roomId = "11111111-1111-4111-8111-111111111111";
    const gameId = "22222222-2222-4222-8222-222222222222";
    const started = "2026-10-27T10:00:00.000Z";
    const tables: Record<string, Array<Record<string, unknown>>> = {
      games: [{ id: gameId, room_id: roomId, total_rounds: 2, ended_at: null, winner_id: null, started_at: started }],
      rooms: [{ id: roomId, code: "ABC123", host_id: "me", status: "in_progress", game_mode: "trivia", settings: { time_per_question: 45 } }],
      room_players: [{ room_id: roomId, player_id: "me", status: "active", score: 0, joined_at: started, players: { display_name: "Me" } }],
      game_rounds: [
        { id: "r1", game_id: gameId, round_number: 1, started_at: started, ended_at: null, correct_verse_key: "k", correct_text: "t", prompt_verse_key: "p", prompt_text: "q", options: [] },
        { id: "r2", game_id: gameId, round_number: 2, started_at: null, ended_at: null, correct_verse_key: "k2", correct_text: "t2", prompt_verse_key: "p2", prompt_text: "q2", options: [] },
      ],
      round_answers: [],
    };
    const from = (table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let single = false;
      const builder = {
        select: () => builder,
        eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return builder; },
        not: (k: string, _op: string, v: unknown) => { filters.push((r) => r[k] !== v); return builder; },
        in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return builder; },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => { single = true; return builder; },
        then: (resolve: (value: unknown) => unknown) => {
          const rows = tables[table].filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
        },
      };
      return builder;
    };
    const route = loadWithMocks<{ GET: (request: Request) => Promise<Response> }>(path.join(root, "src/app/api/multiplayer/state/route.ts"), {
      "@/lib/supabase/admin": { createAdminSupabaseClient: () => ({ from }) },
      "@/lib/multiplayer/resolve-player": { resolvePlayerId: async () => "me" },
    });
    const { NextRequest } = await import("next/server");
    const before = Date.now();
    const data = await (await route.GET(new NextRequest(`https://app.test/api/multiplayer/state?game=${gameId}`))).json();
    assert.deepEqual(data.rounds.map((r: { id: string }) => r.id), ["r1"]);
    assert.equal(data.rounds[0].deadline_at, "2026-10-27T10:00:45.000Z", "the round has no deadline");
    assert.ok(Date.parse(data.server_now) >= before - 1000, "no server clock in the response");
    assert.equal("correct_verse_key" in data.rounds[0], false, "the open round's answer key leaked");
  });

  await runCase("H5: the countdown follows the server's deadline, not the device clock", async () => {
    const { localDeadline, secondsLeft } = await import("./round-client");
    // The device clock is 10 minutes fast; 20 s remain on the server.
    const deviceNow = Date.parse("2026-10-27T10:10:00.000Z");
    const deadline = localDeadline("2026-10-27T10:00:30.000Z", "2026-10-27T10:00:10.000Z", deviceNow);
    assert.equal(deadline, deviceNow + 20_000);
    assert.equal(secondsLeft(deadline, deviceNow), 20);
    assert.equal(secondsLeft(deadline, deviceNow + 19_001), 1);
    assert.equal(secondsLeft(deadline, deviceNow + 25_000), 0);
    assert.equal(localDeadline(null, "2026-10-27T10:00:10.000Z", deviceNow), null);
    assert.equal(secondsLeft(null, deviceNow), null);
  });

  await runCase("H5: a failed answer can be retried; only an answer the server already has stays locked", async () => {
    const { answerStateAfterSubmit } = await import("./round-client");
    assert.deepEqual(answerStateAfterSubmit({ ok: true }, "1:2"), { answered: true, selected: "1:2", error: null });
    assert.deepEqual(
      answerStateAfterSubmit({ ok: false, error: "Network error — answer may not have been recorded" }, "1:2"),
      { answered: false, selected: null, error: "Network error — answer may not have been recorded" },
      "a failed submission locked the player out",
    );
    assert.equal(answerStateAfterSubmit({ ok: false, error: "Failed to submit answer." }, "1:2").answered, false);
    assert.equal(answerStateAfterSubmit({ ok: false }, "1:2").error, "Failed to submit answer");
    // A retry after a lost response: the first try did reach the server.
    assert.deepEqual(answerStateAfterSubmit({ ok: false, error: "Already answered this round" }, "1:2"), { answered: true, selected: "1:2", error: null });

    const page = code("src/app/play/[roomId]/page.tsx");
    const handleSelect = page.slice(page.indexOf("async function handleSelect"), page.indexOf("async function handleBuzzer"));
    assert.ok(handleSelect.includes("answerStateAfterSubmit("), "handleSelect does not use answerStateAfterSubmit");
    assert.ok(handleSelect.includes("setAnswered(next.answered)"), "a failed answer keeps the options locked");
    assert.ok(page.includes("secondsLeft("), "the game screen shows no countdown");
    assert.ok(page.includes("disabled={answered || timeUp}"), "options stay clickable after the time is up");
    assert.ok(
      code("src/lib/hooks/useGame.ts").includes("deadline_ms: localDeadline(round.deadline_at, data.server_now, Date.now())"),
      "the poll does not pass the deadline on",
    );
  });
}
