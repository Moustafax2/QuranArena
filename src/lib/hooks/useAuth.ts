"use client";

import { useCallback, useEffect, useState } from "react";
import type { Database } from "@/lib/supabase/types";
import { forgetAccountSchedulerCopy } from "@/lib/privacy/browser-storage";
import { clearSessionExpired, isSessionExpired, noteSessionExpired } from "@/lib/flashcard/session-expiry";

type Player = Database["public"]["Tables"]["players"]["Row"];

interface AuthUser {
  sub: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
}

interface AuthState {
  player: Player | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  bookmarkSync: boolean;
  isGuest: boolean;
  /** This page view found a sign-in that could no longer be used (M10, Phase 2 D1). */
  sessionExpired: boolean;
  loading: boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface SessionResponse {
  bookmarkSync?: boolean;
  isAuthenticated: boolean;
  user: AuthUser | null;
  player: Player | null;
  sessionExpired?: boolean;
}

const GUEST_STORAGE_KEY = "qalamspace_guest_player";

export function useAuth(): AuthState {
  const [state, setState] = useState<Omit<AuthState, "logout" | "refresh">>({
    player: null,
    user: null,
    isAuthenticated: false,
    bookmarkSync: false,
    isGuest: false,
    sessionExpired: false,
    loading: true,
  });

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/qf/session", { cache: "no-store" });
      if (!response.ok) throw new Error("Session unavailable.");
      const parsed = (await response.json()) as SessionResponse;
      // The route signs out a sign-in it can't use and says so; another hook
      // on the page may have seen that first, so the page view keeps it.
      if (parsed.isAuthenticated) clearSessionExpired();
      else if (parsed.sessionExpired === true) noteSessionExpired();
      const payload = { ...parsed, sessionExpired: isSessionExpired() };

      if (!payload.isAuthenticated && typeof window !== "undefined") {
        const guestResponse = await fetch("/api/multiplayer/guest-token", { cache: "no-store" });
        const guestPlayer = guestResponse.ok ? await guestResponse.json() as Player | null : null;
        if (guestPlayer) {
          sessionStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(guestPlayer));
          return { ...payload, player: guestPlayer, isGuest: true };
        }
        sessionStorage.removeItem(GUEST_STORAGE_KEY);
      }

      return { ...payload, isGuest: false };
    } catch {
      return {
        player: null,
        user: null,
        isAuthenticated: false,
        isGuest: false,
        sessionExpired: isSessionExpired(),
      };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      const payload = await loadSession();
      if (cancelled) return;

      setState({
        player: payload.player,
        user: payload.user,
        isAuthenticated: payload.isAuthenticated,
        bookmarkSync: "bookmarkSync" in payload && payload.bookmarkSync === true,
        isGuest: payload.isGuest,
        sessionExpired: payload.sessionExpired,
        loading: false,
      });
    }

    void hydrate();

    return () => {
      cancelled = true;
    };
  }, [loadSession]);

  const refresh = useCallback(async () => {
    const payload = await loadSession();
    setState({
      player: payload.player,
      user: payload.user,
      isAuthenticated: payload.isAuthenticated,
      bookmarkSync: "bookmarkSync" in payload && payload.bookmarkSync === true,
      isGuest: payload.isGuest,
      sessionExpired: payload.sessionExpired,
      loading: false,
    });
  }, [loadSession]);

  const logout = useCallback(async () => {
    // The device copy of the account's flashcard scheduler settings stays
    // with the account, not with this browser.
    try {
      forgetAccountSchedulerCopy();
    } catch {
      // Storage unavailable: nothing was stored.
    }
    window.location.href = "/api/auth/qf/logout";
  }, []);

  return {
    ...state,
    logout,
    refresh,
  };
}
