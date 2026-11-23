import { NextResponse } from "next/server";
import { resolvePlayerSession } from "@/lib/multiplayer/resolve-player";
import { invokeSupabaseEdgeFunction } from "@/lib/multiplayer/server";
import { listAcceptedFriendQfUserIds } from "@/lib/social/friends";
import { createGameInvitations } from "@/lib/social/invitations";

export async function POST(request: Request) {
  const cookieCarrier = new NextResponse();
  // One session lookup per request: a second one would refresh again with the
  // same refresh token and sign the user out (audit H2).
  let resolved: Awaited<ReturnType<typeof resolvePlayerSession>>;
  try {
    resolved = await resolvePlayerSession(cookieCarrier.cookies);
  } catch {
    // The sign-in could not be checked right now (QF or the database is
    // unreachable); the cookies are kept for the next attempt.
    return NextResponse.json({ error: "Your session could not be checked. Please try again." }, { status: 503, headers: cookieCarrier.headers });
  }
  if (!resolved) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401, headers: cookieCarrier.headers });
  }
  const { playerId, session } = resolved;

  const body = (await request.json().catch(() => null)) as
    | {
        game_mode?: string;
        settings?: Record<string, unknown>;
        invitees?: Array<{
          id?: string;
          displayName?: string;
          username?: string | null;
          avatarUrl?: string | null;
        }>;
      }
    | null;

  if (!body?.game_mode) {
    return NextResponse.json({ error: "game_mode is required." }, { status: 400, headers: cookieCarrier.headers });
  }

  try {
    const invitees = (body.invitees ?? [])
      .filter((invitee) => Boolean(invitee?.id && invitee.displayName))
      .filter((invitee) => invitee.id !== session?.user.sub)
      .map((invitee) => ({
        qfUserId: invitee.id as string,
        displayName: invitee.displayName as string,
        username: invitee.username ?? null,
        avatarUrl: invitee.avatarUrl ?? null,
      }));

    if (session && invitees?.length) {
      const acceptedFriendIds = await listAcceptedFriendQfUserIds(session.player_id);
      const invalidInvitees = invitees.filter(
        (invitee) => !acceptedFriendIds.has(invitee.qfUserId)
      );

      if (invalidInvitees.length) {
        return NextResponse.json(
          { error: "You can only invite users who are already on your friends list." },
          { status: 403, headers: cookieCarrier.headers }
        );
      }
    }

    const data = await invokeSupabaseEdgeFunction<{ room_id: string; code: string }>(
      "create-room",
      {
        player_id: playerId,
        game_mode: body.game_mode,
        settings: body.settings,
      }
    );

    if (session && invitees?.length) {
      await createGameInvitations({
        roomId: data.room_id,
        inviterPlayerId: session.player_id,
        recipients: invitees,
      });
    }

    return NextResponse.json(data, { headers: cookieCarrier.headers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create room." },
      { status: 500, headers: cookieCarrier.headers }
    );
  }
}
