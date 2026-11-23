import { requireAppServer } from "../_shared/server-auth.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createAdminClient,
  corsHeaders,
} from "../_shared/supabase-admin.ts";
import { startGameReply, toRoundRows, type QuestionInput } from "../_shared/multiplayer-rpc.ts";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const denied = await requireAppServer(req);
  if (denied) return denied;

  try {
    const { room_id, player_id, questions } = await req.json() as {
      room_id: string;
      player_id: string;
      questions: QuestionInput[];
    };

    if (!room_id || !player_id) {
      return new Response(
        JSON.stringify({ error: "room_id and player_id are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return new Response(
        JSON.stringify({ error: "questions array is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const admin = createAdminClient();

    // One transaction (migration 014): host and lobby checks under a room
    // lock, the game, all its rounds, the first round's start, the room status
    // and the score reset. A second start finds the room no longer in the
    // lobby, and a failed insert leaves no game behind (audit M3).
    const { data, error } = await admin.rpc("mp_start_game", {
      p_room_id: room_id,
      p_player_id: player_id,
      p_rounds: toRoundRows(questions),
    });

    if (error) {
      throw new Error(`mp_start_game failed: ${error.message}`);
    }

    const reply = startGameReply(data as Record<string, unknown> | null);
    return new Response(
      JSON.stringify(reply.body),
      { status: reply.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
