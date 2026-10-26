import "server-only";
import { getUsableSession } from "@/lib/qf-user/session";
import { getGuestPlayer } from "./guest-session";
import type { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

export async function resolvePlayerId(_request: Request, cookieStore?: ResponseCookies): Promise<string | null> {
  const session = await getUsableSession(cookieStore);
  if (session) return session.player_id;
  // Never trust a supplied player ID or the legacy unsigned cookie.
  return (await getGuestPlayer())?.id ?? null;
}
