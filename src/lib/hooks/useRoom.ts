"use client";
import { useEffect, useState } from "react";
export interface RoomPlayer { player_id: string; display_name: string; is_host: boolean }
export function useRoom(roomId: string | null) {
  const [players, setPlayers] = useState<RoomPlayer[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`/api/multiplayer/state?room=${encodeURIComponent(roomId!)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Room unavailable or membership expired.");
        const data = await response.json();
        if (!cancelled) { setPlayers(data.players); setIsConnected(true); setError(null); }
      } catch (e) { if (!cancelled) { setPlayers([]); setIsConnected(false); setError(e instanceof Error ? e.message : "Room unavailable."); } }
      finally { if (!cancelled) timer = setTimeout(poll, 2000); }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [roomId]);
  return { players: roomId ? players : [], isConnected: Boolean(roomId && isConnected), error };
}
