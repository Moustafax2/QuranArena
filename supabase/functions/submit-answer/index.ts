import { requireAppServer } from "../_shared/server-auth.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createAdminClient,
  corsHeaders,
} from "../_shared/supabase-admin.ts";
import { malformedSubmitReply, submitAnswerReply } from "../_shared/multiplayer-rpc.ts";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const denied = await requireAppServer(req);
  if (denied) return denied;

  try {
    const { game_id, round_id, player_id, answer_verse_key, is_buzzer } =
      await req.json();

    if (!game_id || !round_id || !player_id) {
      return new Response(
        JSON.stringify({ error: "game_id, round_id, and player_id are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // The SQL function takes uuids; a malformed id gets the reply its lookup
    // gave before (not found / not a participant).
    const malformed = malformedSubmitReply({ game_id, player_id, round_id });
    if (malformed) {
      return new Response(
        JSON.stringify(malformed.body),
        { status: malformed.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const admin = createAdminClient();

    // One transaction (migration 014): checks the round is open and in time,
    // records the answer with its speed bonus or the buzz, counts a mistake,
    // and ends the round once everyone has answered (audit H1, M3, H5).
    const { data, error } = await admin.rpc("mp_submit_answer", {
      p_game_id: game_id,
      p_round_id: round_id,
      p_player_id: player_id,
      p_answer_verse_key: typeof answer_verse_key === "string" ? answer_verse_key : null,
      p_is_buzzer: Boolean(is_buzzer),
    });

    if (error) {
      throw new Error(`mp_submit_answer failed: ${error.message}`);
    }

    const reply = submitAnswerReply(data as Record<string, unknown> | null);
    return new Response(
      JSON.stringify(reply.body),
      { status: reply.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
