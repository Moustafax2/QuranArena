import "server-only";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export async function purgePlayerData(playerId: string) {
  const { error } = await createAdminSupabaseClient().rpc("delete_player_data", { target_player: playerId });
  if (error) throw new Error("App data deletion failed. Retry is safe.");
}

/** Call only after verifying the provider's signature, issuer, audience, event
 * type and replay requirements. No public webhook accepts arbitrary subjects.
 * The eventual QF transport adapter belongs outside this deletion service.
 * It must use the same issuer/client subject mapping as our QF login.
 */
export async function purgeVerifiedQfAccount(input: { subject: string; eventId: string }) {
  if (!input.subject.trim() || !input.eventId.trim() || input.subject.length > 512 || input.eventId.length > 512) {
    throw new Error("Invalid deletion identifiers.");
  }
  const { error } = await createAdminSupabaseClient().rpc("purge_qf_user_data", {
    subject_id: input.subject, delivery_id: input.eventId,
  });
  if (error) throw new Error("QF-linked data deletion failed. Retry is safe.");
}
