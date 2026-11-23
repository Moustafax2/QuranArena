import "server-only";

import { cookies } from "next/headers";
import type { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";
import { getQfSessionSecret } from "./config";
import { QfRefreshRejectedError, refreshAccessToken, verifyIdToken } from "./oidc";
import type {
  QfLoginTransaction,
  QfSession,
  QfSessionSummary,
  QfTokenResponse,
} from "./types";
import { upsertPlayerFromQfUser } from "./user-profile";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import { attachConsent } from "@/lib/privacy/consent";

const SESSION_COOKIE = "qf_session";
const ID_TOKEN_COOKIE = "qf_id_token";
const TXN_COOKIE = "qf_login_txn";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const TXN_TTL_SECONDS = 60 * 15;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

async function getAesKey() {
  const secret = getQfSessionSecret();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptValue<T>(value: T): Promise<string> {
  const key = await getAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const payload = new Uint8Array(iv.length + ciphertext.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(ciphertext), iv.length);
  return toBase64Url(payload);
}

async function decryptValue<T>(value: string): Promise<T | null> {
  try {
    const bytes = fromBase64Url(value);
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const key = await getAesKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    return null;
  }
}

function getCookieSecurityOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export async function writeEncryptedCookie(
  cookieStore: ResponseCookies,
  name: string,
  value: unknown,
  maxAge: number
) {
  const encrypted = await encryptValue(value);
  // Browsers commonly reject individual cookies around 4 KiB. Keep a small
  // margin for the cookie name and attributes so a successful OAuth callback
  // cannot silently produce a session that the browser refuses to store.
  if (Buffer.byteLength(`${name}=${encrypted}`, "utf8") > 3800) {
    throw new Error(`Encrypted ${name} cookie is too large.`);
  }
  cookieStore.set(name, encrypted, getCookieSecurityOptions(maxAge));
}

export function clearQfCookies(cookieStore: ResponseCookies) {
  cookieStore.set(SESSION_COOKIE, "", { ...getCookieSecurityOptions(0), maxAge: 0 });
  cookieStore.set(ID_TOKEN_COOKIE, "", { ...getCookieSecurityOptions(0), maxAge: 0 });
  cookieStore.set(TXN_COOKIE, "", { ...getCookieSecurityOptions(0), maxAge: 0 });
}

export function clearLoginTransactionCookie(cookieStore: ResponseCookies) {
  cookieStore.set(TXN_COOKIE, "", { ...getCookieSecurityOptions(0), maxAge: 0 });
}

export async function writeLoginTransactionCookie(
  cookieStore: ResponseCookies,
  txn: QfLoginTransaction
) {
  await writeEncryptedCookie(cookieStore, TXN_COOKIE, txn, TXN_TTL_SECONDS);
}

export async function readLoginTransactionCookie(): Promise<QfLoginTransaction | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(TXN_COOKIE)?.value;
  if (!raw) return null;
  return decryptValue<QfLoginTransaction>(raw);
}

export async function writeSessionCookie(cookieStore: ResponseCookies, session: QfSession) {
  const { id_token: idToken, ...storedSession } = session;
  await writeEncryptedCookie(cookieStore, SESSION_COOKIE, storedSession, SESSION_TTL_SECONDS);
  if (idToken) {
    await writeEncryptedCookie(cookieStore, ID_TOKEN_COOKIE, idToken, SESSION_TTL_SECONDS);
  } else {
    cookieStore.set(ID_TOKEN_COOKIE, "", { ...getCookieSecurityOptions(0), maxAge: 0 });
  }
}

export async function readSessionCookie(): Promise<QfSession | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  // Accept the legacy single-cookie shape during the rollout, then rewrite it
  // in the split form the next time the session route succeeds.
  const stored = await decryptValue<QfSession | Omit<QfSession, "id_token">>(raw);
  if (!stored) return null;
  const separateIdToken = cookieStore.get(ID_TOKEN_COOKIE)?.value;
  const idToken = "id_token" in stored
    ? stored.id_token
    : separateIdToken
      ? await decryptValue<string>(separateIdToken)
      : null;
  const session: QfSession = { ...stored, id_token: idToken ?? "" };
  if (!session || !Number.isFinite(session.issued_at) || session.issued_at > Date.now() || Date.now() - session.issued_at > SESSION_TTL_SECONDS * 1000) return null;
  return session;
}

export function isSessionRefreshNeeded(session: QfSession): boolean {
  return session.expires_at - Date.now() <= REFRESH_WINDOW_MS;
}

export async function createSessionFromTokenResponse(
  tokens: QfTokenResponse,
  nonce: string,
  requestedScopes?: string
): Promise<QfSession> {
  if (!tokens.id_token) {
    throw new Error("Quran Foundation response did not include id_token.");
  }

  const verifiedUser = await verifyIdToken(tokens.id_token, nonce);
  const player = await upsertPlayerFromQfUser(verifiedUser);
  await attachConsent(player.id);

  return {
    issued_at: Date.now(),
    session_version: player.session_version ?? 0,
    scopes: tokens.scope ?? requestedScopes ?? "openid user",
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    id_token: tokens.id_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    user: verifiedUser,
    player_id: player.id,
  };
}

/** The session cannot continue: there is no refresh token, or the account's sessions were invalidated. */
class QfSessionEndedError extends Error {}

/**
 * A refresh failed for a transient reason (network, timeout, QF 5xx, 408 or
 * 429) after the access token had expired. The cookies are kept so a later
 * request can retry; the caller answers with a temporary error (audit H2).
 */
export class QfSessionUnavailableError extends Error {
  constructor() {
    super("Could not refresh the account session. Please try again.");
    this.name = "QfSessionUnavailableError";
  }
}

function isDefinitiveRefreshFailure(error: unknown): boolean {
  return error instanceof QfRefreshRejectedError || error instanceof QfSessionEndedError;
}

/** The players row a session was checked against, read once per request. */
export type SessionPlayer = Database["public"]["Tables"]["players"]["Row"];

/**
 * `player` is the row the caller has just read for this session. The account
 * is checked before the refresh token is spent: QF rotates refresh tokens, so
 * a failure after the refresh would lose the new one.
 */
export async function refreshSession(session: QfSession, player: SessionPlayer): Promise<QfSession> {
  if (!session.refresh_token) {
    throw new QfSessionEndedError("No refresh token available.");
  }

  if (player.id !== session.player_id || player.session_version !== session.session_version) throw new QfSessionEndedError("Session no longer valid.");

  const refreshed = await refreshAccessToken(session.refresh_token);
  // The tokens are rotated by now. If the new id_token can't be verified (for
  // example the JWKS fetch fails), keep the profile and id_token we already
  // verified rather than throwing the new tokens away.
  const verifiedUser = refreshed.id_token
    ? await verifyIdToken(refreshed.id_token).catch((error: unknown) => {
        console.error("Could not verify the refreshed Quran Foundation id_token.", error);
        return null;
      })
    : null;

  return {
    issued_at: session.issued_at,
    session_version: session.session_version,
    scopes: refreshed.scope ?? session.scopes,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? session.refresh_token,
    id_token: verifiedUser ? refreshed.id_token ?? session.id_token : session.id_token,
    expires_at: Date.now() + refreshed.expires_in * 1000,
    user: {
      ...session.user,
      ...verifiedUser,
    },
    player_id: player.id,
  };
}

// Refreshes in flight or just finished, keyed by the refresh token they spent.
// Requests that arrive with the same (now rotated) refresh token share the one
// result instead of each refreshing it again. This is per server process: it
// serializes the requests one instance handles, not requests spread over
// several instances (audit H2).
//
// Handing the rotated session to whoever presents the spent token hides a
// replay from QF's reuse detection. So a finished refresh is shared only for
// REFRESH_REUSE_MS, just long enough for requests the browser had already sent
// with the old cookie, and only with a cookie for the same session (player,
// session_version and QF subject). After that the spent token goes to QF,
// which rejects the reuse, and the browser is signed out.
const REFRESH_REUSE_MS = 5 * 1000;
// A refresh that is somehow still pending after this (the token request itself
// times out after 15 s) stops being shared, so it can't hold requests forever.
const REFRESH_PENDING_MAX_MS = 30 * 1000;
const sharedRefreshes = new Map<string, { identity: string; result: Promise<QfSession>; expiresAt: number }>();

function sessionIdentity(session: QfSession): string {
  return JSON.stringify([session.player_id, session.session_version, session.user?.sub ?? null]);
}

function refreshOnce(session: QfSession, player: SessionPlayer): Promise<QfSession> {
  const key = session.refresh_token;
  if (!key) return refreshSession(session, player);
  const now = Date.now();
  for (const [token, entry] of sharedRefreshes) {
    if (entry.expiresAt <= now) sharedRefreshes.delete(token);
  }
  const identity = sessionIdentity(session);
  const existing = sharedRefreshes.get(key);
  if (existing?.identity === identity) return existing.result;
  // Another session presenting this token never receives its tokens; QF decides.
  if (existing) return refreshSession(session, player);

  const entry = { identity, result: refreshSession(session, player), expiresAt: now + REFRESH_PENDING_MAX_MS };
  sharedRefreshes.set(key, entry);
  entry.result.then(
    () => { entry.expiresAt = Date.now() + REFRESH_REUSE_MS; },
    // Failures are shared only with requests already waiting; the next one retries.
    () => { if (sharedRefreshes.get(key) === entry) sharedRefreshes.delete(key); }
  );
  return entry.result;
}

export async function getSessionSummary(cookieStore: ResponseCookies): Promise<QfSessionSummary> {
  const account = await getUsableAccount(cookieStore);
  if (!account) {
    return {
      isAuthenticated: false,
      user: null,
      player: null,
    };
  }

  const { session, player } = account;
  return {
    isAuthenticated: true,
    user: session.user,
    player: {
      id: player.id,
      display_name: player.display_name,
      avatar_url: player.avatar_url,
      total_points: player.total_points,
      total_wins: player.total_wins,
    },
  };
}

/**
 * The request's account session, refreshed when it is about to expire. Call it
 * once per request, and return `cookieStore`'s headers on every response,
 * errors included: a refresh rotates the tokens, and a response that drops
 * them leaves the browser with a spent refresh token (audit H2).
 *
 * Returns null for no session, and clears the cookies only when the session is
 * definitively over. Throws on a transient failure once the access token has
 * expired (QfSessionUnavailableError), so the caller answers with a temporary
 * error instead of signing the user out.
 */
export async function getUsableSession(
  cookieStore: ResponseCookies
): Promise<QfSession | null> {
  return (await getUsableAccount(cookieStore))?.session ?? null;
}

/**
 * getUsableSession plus the players row it was checked against, read once per
 * request. Same cookie and error rules as getUsableSession.
 */
export async function getUsableAccount(
  cookieStore: ResponseCookies
): Promise<{ session: QfSession; player: SessionPlayer } | null> {
  const session = await readSessionCookie();
  if (!session) return null;

  const { data: player, error } = await createAdminSupabaseClient().from("players")
    .select("*").eq("id", session.player_id).maybeSingle();
  if (error) throw new Error("Could not verify account session.");
  if (!player || player.session_version !== session.session_version) {
    clearQfCookies(cookieStore);
    return null;
  }

  if (!isSessionRefreshNeeded(session)) {
    return { session, player };
  }

  let refreshed: QfSession;
  try {
    refreshed = await refreshOnce(session, player);
  } catch (refreshError) {
    if (isDefinitiveRefreshFailure(refreshError)) {
      clearQfCookies(cookieStore);
      return null;
    }
    console.error("Quran Foundation token refresh failed; keeping the session for a retry.", refreshError);
    // The access token still works for a few minutes; the next request retries.
    if (session.expires_at > Date.now()) return { session, player };
    throw new QfSessionUnavailableError();
  }
  await writeSessionCookie(cookieStore, refreshed);
  return { session: refreshed, player };
}
