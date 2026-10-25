import "server-only";
import { cookies } from "next/headers";
import { GUEST_COOKIE, verifyPrivacyToken } from "@/lib/privacy/tokens";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export async function getGuestPlayer(touch = true) {
  const token = await verifyPrivacyToken((await cookies()).get(GUEST_COOKIE)?.value, "guest");
  if (typeof token?.playerId !== "string") return null;
  const { data, error } = await createAdminSupabaseClient().from("players")
    .select("*").eq("id", token.playerId).is("quran_foundation_uid", null).maybeSingle();
  if (error) throw new Error("Could not verify guest session.");
  if (!data || Date.parse(data.last_active_at) <= Date.now() - 86400000) return null;
  if (touch) {
    const result = await createAdminSupabaseClient().rpc("touch_guest_player", { target_player: data.id });
    if (result.error) throw new Error("Could not verify guest activity.");
    if (!result.data) return null;
  }
  return data;
}
