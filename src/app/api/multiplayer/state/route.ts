import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { resolvePlayerId } from "@/lib/multiplayer/resolve-player";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function GET(request: NextRequest) {
  try {
    const admin = createAdminSupabaseClient();
    const playerId = await resolvePlayerId(request);
    const code = request.nextUrl.searchParams.get("code");
    const roomId = request.nextUrl.searchParams.get("room");
    const gameId = request.nextUrl.searchParams.get("game");
    if (code ? !/^[A-Z0-9]{6}$/i.test(code) : !uuid.test(gameId ?? roomId ?? "")) {
      return NextResponse.json({ error: "Invalid room or game." }, { status: 400 });
    }
    let targetRoom = roomId;
    let game = null;
    if (gameId) {
      const result = await admin.from("games").select("*").eq("id", gameId).maybeSingle();
      if (result.error) throw result.error;
      game = result.data;
      targetRoom = game?.room_id ?? null;
    }
    let query = admin.from("rooms").select("*");
    query = code ? query.eq("code", code.toUpperCase()) : query.eq("id", targetRoom ?? "00000000-0000-0000-0000-000000000000");
    const { data: room, error } = await query.maybeSingle();
    if (error) throw error;
    if (!room) return NextResponse.json({ error: "Room unavailable." }, { status: 404 });
    const membership = playerId ? await admin.from("room_players").select("status")
      .eq("room_id", room.id).eq("player_id", playerId).maybeSingle() : { data: null, error: null };
    if (membership.error) throw membership.error;
    const active = membership.data?.status === "active";
    if (!active) {
      // A share code reveals only the minimum information needed to join.
      if (code) return NextResponse.json({ room: { id: room.id, code: room.code, status: room.status, game_mode: room.game_mode, settings: room.settings, host_id: "", created_at: room.created_at }, membership: membership.data?.status ?? "missing", game: null, players: [] });
      return NextResponse.json({ error: "Active room membership required." }, { status: 403 });
    }
    if (!game) {
      const result = await admin.from("games").select("*").eq("room_id", room.id).order("started_at", { ascending: false }).limit(1).maybeSingle();
      if (result.error) throw result.error;
      game = result.data;
    }
    const roster = await admin.from("room_players").select("player_id, score, joined_at, players!inner(display_name)")
      .eq("room_id", room.id).eq("status", "active").order("joined_at");
    if (roster.error) throw roster.error;
    const players = (roster.data as unknown as { player_id: string; score: number; players: { display_name: string } | { display_name: string }[] }[]).map(row => ({
      player_id: row.player_id, score: row.score, is_host: row.player_id === room.host_id,
      display_name: (Array.isArray(row.players) ? row.players[0] : row.players)?.display_name ?? "Player",
    }));
    if (!gameId || !game) return NextResponse.json({ room, membership: "active", game, players });
    const roundsResult = await admin.from("game_rounds").select("*").eq("game_id", gameId)
      .not("started_at", "is", null).order("round_number");
    if (roundsResult.error) throw roundsResult.error;
    // Explicit projection: never send future questions or active answer keys.
    const rounds = (roundsResult.data ?? []).map(r => ({ id: r.id, round_number: r.round_number,
      prompt_verse_key: r.prompt_verse_key, prompt_text: r.prompt_text, options: r.options,
      started_at: r.started_at, ended_at: r.ended_at,
      ...(r.ended_at || game.ended_at ? { correct_verse_key: r.correct_verse_key, correct_text: r.correct_text } : {}),
    }));
    const completed = rounds.filter(r => r.ended_at || game.ended_at).map(r => r.id);
    const answersResult = completed.length ? await admin.from("round_answers")
      .select("round_id, player_id, answer_verse_key, is_correct, points_awarded").in("round_id", completed).eq("player_id", playerId!) : { data: [], error: null };
    if (answersResult.error) throw answersResult.error;
    return NextResponse.json({ room, membership: "active", game, players, rounds, answers: answersResult.data });
  } catch {
    return NextResponse.json({ error: "Could not load multiplayer state." }, { status: 503 });
  }
}
