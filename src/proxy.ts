import { NextRequest, NextResponse } from "next/server";
import { CONSENT_COOKIE, sameOrigin, verifyPrivacyToken } from "@/lib/privacy/tokens";
import { getConsentReceipt } from "@/lib/privacy/consent";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(request.method);
  const responseHeaders = { "Cache-Control": "private, no-store, max-age=0" };
  if (!safeMethod && !sameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403, headers: responseHeaders });
  }
  // Privacy rights remain available after consent is withdrawn. Each handler
  // still verifies identity and its own input; this is not an auth bypass.
  const exempt = path.startsWith("/api/privacy/") || path === "/api/auth/qf/logout" || path === "/api/auth/callback";
  // Consent is collected at sign-in, so it is required for signed-in requests
  // and to start sign-in. Guests play without an account or name and are not
  // asked; a visitor who declared they are under 13 stays blocked.
  const consentCookie = request.cookies.get(CONSENT_COOKIE)?.value ?? "";
  const signedIn = request.cookies.has("qf_session");
  const startsSignIn = path === "/api/auth/qf/login" || path === "/api/auth/qf/dev-login";
  if (!exempt) {
    try {
      const underage = (await verifyPrivacyToken(consentCookie, "consent"))?.eligible === false;
      if (underage && !path.startsWith("/api/quran/")) {
        return NextResponse.json({ error: "QuranArena is available to people aged 13 and older.", code: "UNDERAGE" },
          { status: 403, headers: responseHeaders });
      }
      if ((signedIn || startsSignIn) && !await getConsentReceipt(consentCookie)) {
        return NextResponse.json({ error: "Age confirmation and privacy consent are required.", code: "CONSENT_REQUIRED" },
          { status: 403, headers: responseHeaders });
      }
    } catch {
      return NextResponse.json({ error: "Privacy controls are temporarily unavailable." }, { status: 503, headers: responseHeaders });
    }
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", responseHeaders["Cache-Control"]);
  return response;
}

export const config = { matcher: ["/api/:path*"] };
