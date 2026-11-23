// Shared by the flashcard API routes and their browser client (audit M10).
// A guest's request gets a plain 401 and the client falls back to this
// browser's storage. A request that still carries a sign-in cookie the server
// can no longer use (the session lapsed, its refresh failed, or it was ended
// elsewhere) gets SESSION_EXPIRED instead, so the client asks the user to sign
// in again rather than quietly writing account data into the browser.

export const SESSION_EXPIRED_CODE = "SESSION_EXPIRED";

// The QF session cookie (see qf-user/session.ts; proxy.ts reads it by name too).
const SESSION_COOKIE = "qf_session";

/** The request carries a non-empty QF session cookie (usable or not). */
export function carriesSessionCookie(request: Request): boolean {
  const header = request.headers.get("cookie") ?? "";
  return header.split(";").some((part) => {
    const [name, ...value] = part.trim().split("=");
    return name === SESSION_COOKIE && value.join("=") !== "";
  });
}

/** The JSON body of the 401 for a request without a usable session. */
export function authRequiredBody(request: Request): { error: string; code?: string } {
  return carriesSessionCookie(request)
    ? { error: "Your sign-in has expired. Sign in again to keep your progress in sync.", code: SESSION_EXPIRED_CODE }
    : { error: "Authentication required." };
}

/** The JSON body of the 503 when the sign-in can't be checked right now. */
export const SESSION_UNAVAILABLE_BODY = { error: "Your sign-in could not be checked right now. Please try again." };

/**
 * The account session of a flashcard request, or the reply to send instead.
 * `carrier` is the route's cookie carrier; every reply here carries its
 * headers, so a definitive sign-out clears the cookies. The session lookup is
 * passed in, so this file stays free of server code (the browser client
 * imports it too).
 *
 * - No usable session: 401, SESSION_EXPIRED when the request carried a sign-in
 *   cookie (M10, Phase 2 D1).
 * - The lookup threw (QF or the database unreachable while the access token
 *   has expired): a retryable 503, never SESSION_EXPIRED, and the cookies are
 *   kept for the next attempt (audit H2).
 */
export async function flashcardSession<Cookies, Session>(
  request: Request,
  carrier: { cookies: Cookies; headers: Headers },
  getSession: (cookies: Cookies) => Promise<Session | null>
): Promise<{ session: Session; response?: undefined } | { session?: undefined; response: Response }> {
  let session: Session | null;
  try {
    session = await getSession(carrier.cookies);
  } catch (error) {
    console.error("Could not check the account session.", error);
    return { response: Response.json(SESSION_UNAVAILABLE_BODY, { status: 503, headers: carrier.headers }) };
  }
  if (!session) return { response: Response.json(authRequiredBody(request), { status: 401, headers: carrier.headers }) };
  return { session };
}
