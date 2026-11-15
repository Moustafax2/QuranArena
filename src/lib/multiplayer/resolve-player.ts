import "server-only";
import { getUsableSession } from "@/lib/qf-user/session";
import { getGuestPlayer } from "./guest-session";
import type { QfSession } from "@/lib/qf-user/types";
import type { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

/**
 * The request's player, with the account session when there is one. Resolve it
 * once per request and pass the session on: a second getUsableSession call
 * would refresh again with the same refresh token (audit H2). Return the
 * cookie store's headers on every response.
 */
export async function resolvePlayerSession(
  cookieStore: ResponseCookies
): Promise<{ playerId: string; session: QfSession | null } | null> {
  const session = await getUsableSession(cookieStore);
  if (session) return { playerId: session.player_id, session };
  // Never trust a supplied player ID or the legacy unsigned cookie.
  const guest = await getGuestPlayer();
  return guest ? { playerId: guest.id, session: null } : null;
}

export async function resolvePlayerId(_request: Request, cookieStore: ResponseCookies): Promise<string | null> {
  return (await resolvePlayerSession(cookieStore))?.playerId ?? null;
}
