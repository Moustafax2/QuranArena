// What the edge functions answer for each result of the multiplayer SQL
// functions in migration 014. Plain TypeScript with no Deno imports, so the
// Node tests check the same mapping the edge functions use.
//
// The status codes and messages are the ones these edge functions gave before
// 014. Only two are new, for answers the old code wrongly accepted:
// round_not_open (audit H1) and time_up (audit H5).

export interface RpcReply {
  status: number;
  body: Record<string, unknown>;
}

// The 4xx messages are shown to players (the Next routes pass the message on).
export const ALREADY_ANSWERED_MESSAGE = "Already answered this round";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FAILURES: Record<string, { status: number; error: string }> = {
  // mp_submit_answer
  game_not_found: { status: 404, error: "Game not found" },
  game_ended: { status: 400, error: "Game has already ended" },
  not_participant: { status: 403, error: "You are no longer an active participant in this game" },
  round_not_found: { status: 404, error: "Round not found" },
  round_not_open: { status: 409, error: "This round is not open for answers" },
  already_answered: { status: 400, error: ALREADY_ANSWERED_MESSAGE },
  time_up: { status: 409, error: "Time is up for this round" },
  buzzer_taken: { status: 409, error: "Someone else buzzed first" },
  // mp_start_game
  invalid_rounds: { status: 400, error: "questions array is required" },
  room_not_found: { status: 404, error: "Room not found" },
  not_host: { status: 403, error: "Only the host can start the game" },
  already_started: { status: 400, error: "Game already started" },
  no_players: { status: 400, error: "No active players remain in this room" },
  // mp_join_room (room_not_found as above)
  not_lobby: { status: 400, error: "Game already in progress" },
  room_full: { status: 400, error: "Room is full (max 8 players)" },
  left_room: { status: 403, error: "You already left this game and cannot rejoin it." },
};

type RpcResult = Record<string, unknown> | null | undefined;

/** Maps a submit result to the reply the edge function always gave. */
export function submitAnswerReply(result: RpcResult): RpcReply {
  const status = String(result?.status ?? "");
  if (status === "ok") {
    return { status: 200, body: { is_correct: result!.is_correct, points_awarded: result!.points_awarded } };
  }
  if (status === "buzzer_winner") return { status: 200, body: { buzzer_winner: true } };
  return failureReply(status);
}

export function startGameReply(result: RpcResult): RpcReply {
  const status = String(result?.status ?? "");
  if (status === "ok") {
    return { status: 200, body: { game_id: result!.game_id, total_rounds: result!.total_rounds } };
  }
  return failureReply(status);
}

export function joinRoomReply(result: RpcResult): RpcReply {
  const status = String(result?.status ?? "");
  if (status === "ok") {
    const { room_id, code, host_id, game_mode, settings } = result!;
    return { status: 200, body: { room_id, code, host_id, game_mode, settings } };
  }
  return failureReply(status);
}

/**
 * The reply for a submit whose ids are not ids. The old code looked each id up
 * in turn (game, then player, then round) and answered with the first miss;
 * the SQL function takes uuid arguments, so a malformed id is answered here
 * the same way instead of as a database error.
 */
export function malformedSubmitReply(ids: { game_id: unknown; player_id: unknown; round_id: unknown }): RpcReply | null {
  const isId = (value: unknown) => typeof value === "string" && UUID_PATTERN.test(value);
  if (!isId(ids.game_id)) return failureReply("game_not_found");
  if (!isId(ids.player_id)) return failureReply("not_participant");
  if (!isId(ids.round_id)) return failureReply("round_not_found");
  return null;
}

export function failureReply(status: string): RpcReply {
  const known = FAILURES[status];
  if (known) return { status: known.status, body: { error: known.error } };
  // An unknown result is a server fault; its text stays out of the reply.
  return { status: 500, body: { error: "Unexpected multiplayer result" } };
}

export interface QuestionInput {
  prompt_verse_key: string;
  prompt_text: string;
  prompt_surah_id?: number | null;
  prompt_juz_number?: number | null;
  prompt_page_number?: number | null;
  correct_verse_key: string;
  correct_text: string;
  options: { verse_key: string; text: string }[];
  game_mode?: string;
}

/** The p_rounds argument of mp_start_game, shaped as start-game stored rounds before. */
export function toRoundRows(questions: QuestionInput[]) {
  return questions.map((q) => ({
    game_mode: q.game_mode ?? null,
    prompt_verse_key: q.prompt_verse_key,
    prompt_surah_id: q.prompt_surah_id ?? null,
    prompt_juz_number: q.prompt_juz_number ?? null,
    prompt_page_number: q.prompt_page_number ?? null,
    correct_verse_key: q.correct_verse_key,
    prompt_text: q.prompt_text,
    correct_text: q.correct_text,
    options: Array.isArray(q.options) && q.options.length > 0
      ? q.options.map((o) => JSON.stringify(o))
      : null,
  }));
}
