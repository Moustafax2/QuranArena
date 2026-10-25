import { NextResponse } from "next/server";
import { getUsableSession, writeSessionCookie, clearQfCookies } from "@/lib/qf-user/session";
import { getPlayerById } from "@/lib/qf-user/user-profile";

export async function GET() {
  const cookieCarrier = new NextResponse();

  try {
    const session = await getUsableSession(cookieCarrier.cookies);
    if (!session) {
      clearQfCookies(cookieCarrier.cookies);
      return NextResponse.json(
        {
          isAuthenticated: false,
          user: null,
          player: null,
        },
        { headers: cookieCarrier.headers }
      );
    }

    const player = await getPlayerById(session.player_id);
    if (!player || player.session_version !== session.session_version) throw new Error("Session no longer valid.");
    await writeSessionCookie(cookieCarrier.cookies, {
      ...session,
      player_id: player.id,
    });

    return NextResponse.json(
      {
        isAuthenticated: true,
        bookmarkSync: session.scopes?.split(" ").includes("bookmark") ?? false,
        user: session.user,
        player,
      },
      {
        headers: cookieCarrier.headers,
      }
    );
  } catch (error) {
    console.error("Failed to resolve Quran Foundation session.", error);
    clearQfCookies(cookieCarrier.cookies);
    return NextResponse.json(
      {
        isAuthenticated: false,
        user: null,
        player: null,
      },
      { headers: cookieCarrier.headers }
    );
  }
}
