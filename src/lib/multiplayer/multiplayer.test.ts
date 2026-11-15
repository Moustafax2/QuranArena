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
}
