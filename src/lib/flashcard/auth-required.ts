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
