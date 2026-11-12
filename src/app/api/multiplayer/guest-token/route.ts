import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getGuestPlayer } from "@/lib/multiplayer/guest-session";
import { COOKIE_OPTIONS, GUEST_COOKIE, sameOrigin, signPrivacyToken } from "@/lib/privacy/tokens";

export async function GET() {
  return NextResponse.json(await getGuestPlayer(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  // Guests are anonymous (random "Guest 1234" name, no account), so no consent
  // receipt is attached; consent is collected when someone signs in.
  let player = await getGuestPlayer();
  if (!player) {
    await signPrivacyToken("guest", {}, 1);
    const result = await createAdminSupabaseClient().from("players")
      .insert({ display_name: `Guest ${Math.floor(1000 + Math.random() * 9000)}` })
      .select().single();
    if (result.error) return NextResponse.json({ error: "Could not create guest session." }, { status: 500 });
    player = result.data;
  }
  const response = NextResponse.json(player);
  response.cookies.set(GUEST_COOKIE, await signPrivacyToken("guest", { playerId: player.id }, 604800),
    { ...COOKIE_OPTIONS, maxAge: 604800 });
  response.cookies.set("qalamspace_guest_player_id", "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return response;
}
