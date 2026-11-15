import { requireAppServer } from "../_shared/server-auth.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createAdminClient,
  corsHeaders,
} from "../_shared/supabase-admin.ts";
import { joinRoomReply } from "../_shared/multiplayer-rpc.ts";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const denied = await requireAppServer(req);
  if (denied) return denied;

  try {
    const { player_id, room_code } = await req.json();

    if (!player_id || !room_code) {
      return new Response(
        JSON.stringify({ error: "player_id and room_code are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const admin = createAdminClient();

    // One transaction (migration 014), under a room lock: the lobby check, the
    // 8-player limit and the insert (audit M3). A player who left is still
    // refused, as before.
    const { data, error } = await admin.rpc("mp_join_room", {
      p_room_code: room_code,
      p_player_id: player_id,
    });

    if (error) {
      throw new Error(`mp_join_room failed: ${error.message}`);
    }

    const reply = joinRoomReply(data as Record<string, unknown> | null);
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
