import "server-only";
import { cookies } from "next/headers";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { CONSENT_COOKIE, CONSENT_VERSION, hasPrivacyConsent, verifyPrivacyToken } from "./tokens";

export async function getConsentReceipt(raw?: string) {
  const value = raw ?? (await cookies()).get(CONSENT_COOKIE)?.value;
  if (!await hasPrivacyConsent(value)) return null;
  const token = await verifyPrivacyToken(value, "consent");
  if (typeof token?.receiptId !== "string") return null;
  const { data, error } = await createAdminSupabaseClient().from("privacy_consents")
    .select("*").eq("id", token.receiptId).is("withdrawn_at", null).maybeSingle();
  if (error) throw new Error("Privacy controls are temporarily unavailable.");
  return data?.version === CONSENT_VERSION ? data : null;
}

export async function attachConsent(playerId: string) {
  const receipt = await getConsentReceipt();
  if (!receipt) throw new Error("Privacy consent is required.");
  const { error } = await createAdminSupabaseClient().from("privacy_consents")
    .update({ player_id: playerId }).eq("id", receipt.id).is("withdrawn_at", null).select("id").single();
  if (error) throw new Error("Could not record consent.");
}
