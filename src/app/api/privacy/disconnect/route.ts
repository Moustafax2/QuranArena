import { NextResponse } from "next/server";
import { privacyIdentity, revokeQfSession } from "@/lib/privacy/account";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { clearQfCookies } from "@/lib/qf-user/session";

export async function POST() {
  try {
    const identity = await privacyIdentity();
    if (!identity?.session) return NextResponse.json({ error: "No connected QF account." }, { status: 401 });
    await revokeQfSession(identity.session);
    const { error } = await createAdminSupabaseClient().rpc("invalidate_player_sessions", { target_player: identity.playerId });
    if (error) throw error;
    const response = NextResponse.json({ disconnected: true });
    clearQfCookies(response.cookies);
    return response;
  } catch {
    return NextResponse.json({ error: "Could not finish disconnection. Please retry or contact support." }, { status: 503 });
  }
}
