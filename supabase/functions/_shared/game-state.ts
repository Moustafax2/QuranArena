import { createAdminClient } from "./supabase-admin.ts";

type AdminClient = ReturnType<typeof createAdminClient>;

interface ActiveRoomPlayer {
  player_id: string;
  score: number;
  joined_at: string;
}

async function listActiveRoomPlayers(
  admin: AdminClient,
  roomId: string,
): Promise<ActiveRoomPlayer[]> {
  const { data, error } = await admin
    .from("room_players")
    .select("player_id, score, joined_at")
    .eq("room_id", roomId)
    .eq("status", "active")
    .order("joined_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load active room players: ${error.message}`);
  }

  return (data ?? []) as ActiveRoomPlayer[];
}

/**
 * Moves the game on after a heartbeat or a departure. mp_advance_round
 * (migration 014) ends the open round once every live player has answered or
 * its time per question has run out, and ends the game when no live player is
 * left. Rounds and games are claimed inside the database, so overlapping
 * callers add points and lifetime stats exactly once (audit H1, H5).
 */
export async function maybeAdvanceGameAfterParticipantChange(
  admin: AdminClient,
  gameId: string,
) {
  const { error } = await admin.rpc("mp_advance_round", { p_game_id: gameId });
  if (error) {
    throw new Error(`Failed to advance game: ${error.message}`);
  }
}

export async function reassignHostIfNeeded(
  admin: AdminClient,
  roomId: string,
  departingPlayerId: string,
) {
  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("host_id")
    .eq("id", roomId)
    .single();

  if (roomError || !room) {
    throw new Error("Room not found while reassigning host.");
  }

  const activePlayers = await listActiveRoomPlayers(admin, roomId);

  if (activePlayers.length === 0) {
    await admin
      .from("rooms")
      .update({ status: "finished" })
      .eq("id", roomId);
    return;
  }

  if (room.host_id !== departingPlayerId) {
    return;
  }

  const nextHostId = activePlayers[0]?.player_id;
  if (!nextHostId) {
    return;
  }

  await admin
    .from("rooms")
    .update({ host_id: nextHostId })
    .eq("id", roomId);
}
