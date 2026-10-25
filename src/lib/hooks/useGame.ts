"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { INITIAL_GAME_STATE, type GameState } from "@/lib/game/state-machine";

export function useGame(gameId: string | null, playerId: string | null, guestPlayerId?: string | null) {
  const [gameState, setGameState] = useState<GameState>(INITIAL_GAME_STATE);
  const lastRound = useRef<string | null>(null);
  const shownResult = useRef<string | null>(null);
  useEffect(() => {
    if (!gameId || !playerId) return;
    lastRound.current = null;
    shownResult.current = null;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch('/api/multiplayer/state?game=' + encodeURIComponent(gameId!), { cache: 'no-store' });
        if (!response.ok) { if (!cancelled) setGameState(INITIAL_GAME_STATE); return; }
        const data = await response.json();
        let round = data.rounds.find((r: { ended_at: string | null }) => !r.ended_at) ?? data.rounds.at(-1);
        const finished = data.rounds.find((r: { id: string; ended_at: string | null }) => r.id === lastRound.current && r.ended_at);
        if (finished && shownResult.current !== finished.id && !data.game.ended_at) {
          round = finished;
          shownResult.current = finished.id;
        } else if (round && !round.ended_at) lastRound.current = round.id;
        const scores = Object.fromEntries(data.players.map((p: { player_id: string; score: number }) => [p.player_id, p.score]));
        const options = (round?.options ?? []).map((o: unknown) => typeof o === 'string' ? JSON.parse(o) : o);
        if (!cancelled) setGameState({
          phase: data.game.ended_at ? 'game_over' : round?.ended_at ? 'round_result' : round ? 'round_active' : 'lobby',
          game_id: gameId,
          current_round: round ? { round_id: round.id, round_number: round.round_number, total_rounds: data.game.total_rounds, prompt_verse_key: round.prompt_verse_key, prompt_text: round.prompt_text ?? '', options } : null,
          round_result: round?.ended_at ? { correct_verse_key: round.correct_verse_key, correct_text: round.correct_text ?? '', answers: data.answers.filter((a: { round_id: string }) => a.round_id === round.id), scores } : null,
          scores, winner_id: data.game.winner_id,
        });
      } catch { if (!cancelled) setGameState(INITIAL_GAME_STATE); }
      finally { if (!cancelled) timer = setTimeout(poll, 1000); }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [gameId, playerId]);
  const buildHeaders = useCallback(() => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (guestPlayerId) headers["X-Guest-Player-Id"] = guestPlayerId;
    return headers;
  }, [guestPlayerId]);

  const submitAnswer = useCallback(
    async (roundId: string, answerVerseKey: string): Promise<{ ok: boolean; error?: string }> => {
      if (!gameId || !playerId) return { ok: false };
      try {
        const res = await fetch("/api/multiplayer/submit-answer", {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({
            game_id: gameId,
            round_id: roundId,
            answer_verse_key: answerVerseKey,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { ok: false, error: body.error ?? "Failed to submit answer" };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: "Network error — answer may not have been recorded" };
      }
    },
    [gameId, playerId, buildHeaders]
  );

  const pressBuzzer = useCallback(
    async (roundId: string): Promise<{ ok: boolean; error?: string }> => {
      if (!gameId || !playerId) return { ok: false };
      try {
        const res = await fetch("/api/multiplayer/submit-answer", {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({
            game_id: gameId,
            round_id: roundId,
            is_buzzer: true,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { ok: false, error: body.error ?? "Failed to buzz" };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: "Network error — buzz may not have been recorded" };
      }
    },
    [gameId, playerId, buildHeaders]
  );

  return { gameState, submitAnswer, pressBuzzer };
}
