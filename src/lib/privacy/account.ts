import "server-only";
import { readSessionCookie } from "@/lib/qf-user/session";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getGuestPlayer } from "@/lib/multiplayer/guest-session";
import { getQfClientId, getQfClientSecret, getQfDiscoveryDocument, getQfIssuerBaseUrl } from "@/lib/qf-user/config";
import type { QfSession } from "@/lib/qf-user/types";

export async function privacyIdentity() {
  // Prove ownership without requiring QF to be online or refreshing tokens
  // after consent has been withdrawn. readSessionCookie enforces the app TTL.
  const session = await readSessionCookie();
  if (session) {
    const { data, error } = await createAdminSupabaseClient().from("players")
      .select("id, session_version").eq("id", session.player_id).maybeSingle();
    if (error) throw new Error("Could not verify account.");
    if (data?.session_version === session.session_version) return { playerId: session.player_id, session };
  }
  const guest = await getGuestPlayer(false);
  return guest ? { playerId: guest.id, session: null } : null;
}

export async function revokeQfSession(session: QfSession) {
  const discovery = await getQfDiscoveryDocument();
  const endpoint = discovery.revocation_endpoint ?? `${getQfIssuerBaseUrl()}/oauth2/revoke`;
  for (const token of [session.refresh_token, session.access_token].filter((value): value is string => Boolean(value))) {
    const response = await fetch(endpoint, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${getQfClientId()}:${getQfClientSecret()}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }),
    });
    if (!response.ok) throw new Error("QF could not confirm disconnection. Please retry.");
  }
}
