import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getGuestPlayer } from "@/lib/multiplayer/guest-session";
import { attachConsent } from "@/lib/privacy/consent";
import { COOKIE_OPTIONS, GUEST_COOKIE, sameOrigin, signPrivacyToken } from "@/lib/privacy/tokens";

export async function GET() {
  return NextResponse.json(await getGuestPlayer(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  let player = await getGuestPlayer();
  let created = false;
  if (!player) {
    await signPrivacyToken("guest", {}, 1);
    const result = await createAdminSupabaseClient().from("players")
      .insert({ display_name: `Guest ${Math.floor(1000 + Math.random() * 9000)}` })
      .select().single();
    if (result.error) return NextResponse.json({ error: "Could not create guest session." }, { status: 500 });
    player = result.data;
    created = true;
  }
  const response = NextResponse.json(player);
  try {
    await attachConsent(player.id);
  } catch {
    // A failed receipt attachment must not leave a new guest identity usable.
    if (created) await createAdminSupabaseClient().from("players").delete().eq("id", player.id);
    return NextResponse.json({ error: "Could not record guest consent. Please retry." }, { status: 503 });
  }
  response.cookies.set(GUEST_COOKIE, await signPrivacyToken("guest", { playerId: player.id }, 604800),
    { ...COOKIE_OPTIONS, maxAge: 604800 });
  response.cookies.set("qalamspace_guest_player_id", "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return response;
}
