import { NextResponse } from "next/server";
import { getUsableSession, writeSessionCookie, clearQfCookies } from "@/lib/qf-user/session";
import { getPlayerById } from "@/lib/qf-user/user-profile";
import { carriesSessionCookie } from "@/lib/flashcard/auth-required";

export async function GET(request: Request) {
  const cookieCarrier = new NextResponse();
  // The browser sent a sign-in that can't be used any more. The reply still
  // signs it out (the cookies are cleared below), and also says the session
  // expired, so the flashcard pages can ask the user to sign in again instead
  // of studying as a guest on this device (M10, Phase 2 D1). A response field
  // only: no cookie, no storage, no personal data.
  const expired = carriesSessionCookie(request) ? { sessionExpired: true } : {};

  try {
    const session = await getUsableSession(cookieCarrier.cookies);
    if (!session) {
      clearQfCookies(cookieCarrier.cookies);
      return NextResponse.json(
        {
          isAuthenticated: false,
          user: null,
          player: null,
          ...expired,
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
        ...expired,
      },
      { headers: cookieCarrier.headers }
    );
  }
}
