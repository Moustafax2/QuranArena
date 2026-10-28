import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function createAdminClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

// Clients now read authoritative state through membership-checked Next routes.
// Never publish game or player data to unauthenticated public channels.
export async function broadcastGameEvent(_gameId: string, _event: { type: string; payload: Record<string, unknown> }) {}
export async function broadcastRoomEvent(_roomId: string, _event: { type: string; payload: Record<string, unknown> }) {}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
