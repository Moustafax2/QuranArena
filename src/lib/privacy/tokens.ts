import { SignJWT, jwtVerify } from "jose";

export const CONSENT_VERSION = "2026-10-24";
export const CONSENT_COOKIE = "quranarena_privacy";
export const GUEST_COOKIE = "quranarena_guest_session";
export const COOKIE_OPTIONS = {
  httpOnly: true, sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production", path: "/",
};

function signingKey() {
  const secret = process.env.QF_SESSION_SECRET?.trim();
  if (!secret) throw new Error("Session signing is not configured.");
  return new TextEncoder().encode(secret);
}

export async function signPrivacyToken(purpose: "consent" | "guest", data: Record<string, unknown>, seconds: number) {
  return new SignJWT(data).setProtectedHeader({ alg: "HS256" })
    .setIssuer("quranarena").setAudience(purpose).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(signingKey());
}

export async function verifyPrivacyToken(raw: string | undefined, purpose: "consent" | "guest") {
  if (!raw) return null;
  try {
    return (await jwtVerify(raw, signingKey(), {
      algorithms: ["HS256"], issuer: "quranarena", audience: purpose,
    })).payload;
  } catch { return null; }
}

export async function hasPrivacyConsent(raw: string | undefined) {
  const consent = await verifyPrivacyToken(raw, "consent");
  return consent?.version === CONSENT_VERSION && consent.eligible === true && consent.religiousData === true;
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}
