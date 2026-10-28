import { NextRequest, NextResponse } from "next/server";
import {
  getAppBaseUrl,
  getQfCallbackUrl,
  getQfClientId,
  getQfRequestedScopes,
  getQfDiscoveryDocument,
} from "@/lib/qf-user/config";
import { writeLoginTransactionCookie } from "@/lib/qf-user/session";

export async function POST(request: NextRequest) {
  try {
    const configuredOrigin = new URL(getAppBaseUrl()).origin;
    if (request.nextUrl.origin !== configuredOrigin) {
      return NextResponse.json(
        {
          error: `Quran.com sign-in is temporarily available at ${configuredOrigin} while the new callback domain is being registered.`,
          loginUrl: `${configuredOrigin}/login`,
        },
        { status: 409 }
      );
    }

    const body = (await request.json().catch(() => null)) as
      | {
          state?: string;
          nonce?: string;
          code_verifier?: string;
          code_challenge?: string;
          redirect_to?: string;
          bookmarks?: boolean;
        }
      | null;

    if (!body?.state || !body.nonce || !body.code_verifier || !body.code_challenge) {
      return NextResponse.json(
        { error: "Missing PKCE or OIDC login parameters." },
        { status: 400 }
      );
    }

    const discovery = await getQfDiscoveryDocument();
    const redirectTo =
      body.redirect_to && body.redirect_to.startsWith("/") && !body.redirect_to.startsWith("//") && !body.redirect_to.includes("\\") ? body.redirect_to : "/";

    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.searchParams.set("client_id", getQfClientId());
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("redirect_uri", getQfCallbackUrl());
    const scopes = getQfRequestedScopes(body.bookmarks === true);
    authorizationUrl.searchParams.set("scope", scopes);
    authorizationUrl.searchParams.set("state", body.state);
    authorizationUrl.searchParams.set("nonce", body.nonce);
    authorizationUrl.searchParams.set("code_challenge", body.code_challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");

    const response = NextResponse.json({ authorizationUrl: authorizationUrl.toString() });
    await writeLoginTransactionCookie(response.cookies, {
      state: body.state,
      scopes,
      nonce: body.nonce,
      code_verifier: body.code_verifier,
      redirect_to: redirectTo,
      created_at: Date.now(),
    });

    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to start login.",
      },
      { status: 500 }
    );
  }
}
