import { NextRequest, NextResponse } from "next/server";
import { CONSENT_COOKIE, sameOrigin } from "@/lib/privacy/tokens";
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
  if (!exempt) {
    try {
      if (!await getConsentReceipt(request.cookies.get(CONSENT_COOKIE)?.value ?? "")) {
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
