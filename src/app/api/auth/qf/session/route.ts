import { NextResponse } from "next/server";
import { getUsableAccount, writeSessionCookie, clearQfCookies } from "@/lib/qf-user/session";
import { carriesSessionCookie } from "@/lib/flashcard/auth-required";

export async function GET(request: Request) {
  const cookieCarrier = new NextResponse();

  try {
    // The players row comes back with the session, already checked against
    // its session_version; no second lookup.
    const account = await getUsableAccount(cookieCarrier.cookies);
    if (!account) {
      // No session, or one that is definitively over (QF refused the refresh,
      // or the account's sessions were ended). The reply signs the browser
      // out, and if it sent a sign-in cookie it also says the session expired,
      // so the flashcard pages can ask the user to sign in again instead of
      // studying as a guest on this device (M10, Phase 2 D1). A response field
      // only: no cookie, no storage, no personal data.
      clearQfCookies(cookieCarrier.cookies);
      return NextResponse.json(
        {
          isAuthenticated: false,
          user: null,
          player: null,
          ...(carriesSessionCookie(request) ? { sessionExpired: true } : {}),
        },
        { headers: cookieCarrier.headers }
      );
    }

    const { session, player } = account;
    await writeSessionCookie(cookieCarrier.cookies, session);

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
    // A transient failure (the database or QF unreachable, a QF 5xx) is not a
    // sign-out and not an expired session: keep the cookies so the next
    // request can succeed (audit H2).
    console.error("Failed to resolve Quran Foundation session.", error);
    return NextResponse.json(
      {
        isAuthenticated: false,
        user: null,
        player: null,
        error: "Your session could not be checked. Please try again.",
      },
      { status: 503, headers: cookieCarrier.headers }
    );
  }
}
