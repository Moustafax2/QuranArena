import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getConsentReceipt } from "@/lib/privacy/consent";
import { CONSENT_COOKIE, CONSENT_VERSION, COOKIE_OPTIONS, signPrivacyToken, verifyPrivacyToken } from "@/lib/privacy/tokens";
import { privacyIdentity } from "@/lib/privacy/account";

export async function GET(request: NextRequest) {
  try {
    const raw = request.cookies.get(CONSENT_COOKIE)?.value;
    const token = await verifyPrivacyToken(raw, "consent");
    const receipt = await getConsentReceipt(raw ?? "");
    const identity = receipt ? await privacyIdentity() : null;
    return NextResponse.json({ accepted: Boolean(receipt), account: Boolean(identity?.session), underage: token?.eligible === false, version: CONSENT_VERSION });
  } catch {
    return NextResponse.json({ error: "Privacy controls are temporarily unavailable." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const existing = await verifyPrivacyToken(request.cookies.get(CONSENT_COOKIE)?.value, "consent");
  const body = await request.json().catch(() => null);
  if (existing?.eligible === false || body?.eligible === false) {
    const response = NextResponse.json({ error: "QuranArena is available to people aged 13 and older." }, { status: 403 });
    response.cookies.set(CONSENT_COOKIE, await signPrivacyToken("consent", { eligible: false }, 86400 * 365),
      { ...COOKIE_OPTIONS, maxAge: 86400 * 365 });
    return response;
  }
  if (body?.eligible !== true || body?.religiousData !== true || body?.noticeRead !== true || body?.version !== CONSENT_VERSION) {
    return NextResponse.json({ error: "Confirm your age and make each privacy choice." }, { status: 400 });
  }
  try {
    const receiptId = crypto.randomUUID();
    const token = await signPrivacyToken("consent", {
      receiptId, eligible: true, religiousData: true, version: CONSENT_VERSION,
    }, 86400 * 365);
    const identity = await privacyIdentity();
    const playerId = identity?.playerId ?? null;
    const { error } = await createAdminSupabaseClient().from("privacy_consents").insert({
      id: receiptId, version: CONSENT_VERSION, player_id: playerId,
    });
    if (error) throw error;
    const response = NextResponse.json({ accepted: true });
    response.cookies.set(CONSENT_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: 86400 * 365 });
    return response;
  } catch {
    return NextResponse.json({ error: "Could not save your choices. Please try again later." }, { status: 503 });
  }
}

export async function DELETE() {
  try {
    const identity = await privacyIdentity();
    if (identity) {
      const { error } = await createAdminSupabaseClient().rpc("withdraw_player_consent", { target_player: identity.playerId });
      if (error) throw error;
    }
    const receipt = await getConsentReceipt();
    if (receipt) {
      const { error } = await createAdminSupabaseClient().from("privacy_consents")
        .update({ withdrawn_at: new Date().toISOString() }).eq("id", receipt.id);
      if (error) throw error;
    }
    const response = NextResponse.json({ withdrawn: true });
    response.cookies.set(CONSENT_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
    return response;
  } catch {
    return NextResponse.json({ error: "Could not record withdrawal. Please retry or contact support." }, { status: 503 });
  }
}
