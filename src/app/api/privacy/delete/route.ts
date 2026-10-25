import { NextRequest, NextResponse } from "next/server";
import { privacyIdentity, revokeQfSession } from "@/lib/privacy/account";
import { purgePlayerData } from "@/lib/privacy/deletion";
import { clearQfCookies } from "@/lib/qf-user/session";
import { CONSENT_COOKIE, COOKIE_OPTIONS, GUEST_COOKIE } from "@/lib/privacy/tokens";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (body?.confirmation !== "DELETE") return NextResponse.json({ error: "Type DELETE to confirm." }, { status: 400 });
  try {
    const identity = await privacyIdentity();
    if (!identity) return NextResponse.json({ error: "No verified app account or guest session. Contact support for help." }, { status: 401 });
    // Delete local app records even if QF is temporarily unavailable, but report
    // revocation separately so partial success is never presented as complete.
    let qfDisconnected = !identity.session;
    if (identity.session) {
      try { await revokeQfSession(identity.session); qfDisconnected = true; } catch { /* report below */ }
    }
    await purgePlayerData(identity.playerId);
    const response = NextResponse.json({ deleted: true, qfDisconnected,
      message: "Live QuranArena account records deleted. Your QF account/bookmarks are unchanged. Backup deletion follows the operator's retention process." });
    clearQfCookies(response.cookies);
    for (const name of [GUEST_COOKIE, CONSENT_COOKIE, "qalamspace_guest_player_id"]) {
      response.cookies.set(name, "", { ...COOKIE_OPTIONS, maxAge: 0 });
    }
    return response;
  } catch {
    return NextResponse.json({ error: "Deletion was not completed. Please retry or email support@quranarena.ca." }, { status: 503 });
  }
}
