"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { Database } from "@/lib/supabase/types";
import { forgetAccountSchedulerCopy } from "@/lib/privacy/browser-storage";
import { clearSessionExpired, isSessionExpired, noteSessionExpired } from "@/lib/flashcard/session-expiry";
import { AUTH_STORAGE_REFRESH_DELAY_MS, createSingleFlight, shouldRefreshAuthOnStorage } from "@/lib/auth-refresh";

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

const AuthContext = createContext<AuthState | null>(null);

/**
 * Holds the one client-side copy of the auth state. Every useAuth() caller
 * used to fetch the session itself, so one page load sent several parallel
 * requests that each tried to refresh the same token (audit H2).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
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
        // The session could not be read (a 503 while QF or the database is
        // down, or offline). It says nothing about who is signed in (H2).
        unavailable: true,
      };
    }
  }, []);

  // At most one session request in flight; every trigger below shares it, so
  // following navigation and focus doesn't bring back the request storms of
  // per-component fetching (audit H2).
  const requests = useMemo(() => createSingleFlight(loadSession), [loadSession]);

  // Whether a session read in this page view has had an answer. A failed
  // re-read (focus, navigation) then keeps what is shown, so a QF outage does
  // not make a signed-in page look signed out; the next read decides (H2).
  const answered = useRef(false);
  const apply = useCallback((payload: Awaited<ReturnType<typeof loadSession>>) => {
    if ("unavailable" in payload) {
      if (answered.current) return;
    } else {
      answered.current = true;
    }
    setState({
      player: payload.player,
      user: payload.user,
      isAuthenticated: payload.isAuthenticated,
      bookmarkSync: "bookmarkSync" in payload && payload.bookmarkSync === true,
      isGuest: payload.isGuest,
      sessionExpired: payload.sessionExpired,
      loading: false,
    });
  }, []);

  /** Re-reads the session after a change this page made (sign-in, a finished game). */
  const refresh = useCallback(async () => {
    apply(await requests.fresh());
  }, [apply, requests]);

  // Client-side navigation (the account page after a game or a dev sign-in)
  // shows the current session and points, not the ones from the first load.
  const pathname = usePathname();
  useEffect(() => {
    let cancelled = false;
    void requests.join().then(payload => { if (!cancelled) apply(payload); });
    return () => { cancelled = true; };
  }, [pathname, requests, apply]);

  // Returning to the tab, and a privacy-controls clear() in another tab.
  useEffect(() => {
    let storageTimer: number | undefined;
    const reload = () => { void requests.join().then(apply); };
    const onVisible = () => { if (document.visibilityState === "visible") reload(); };
    const onStorage = (event: StorageEvent) => {
      if (!shouldRefreshAuthOnStorage(event.key)) return;
      window.clearTimeout(storageTimer);
      storageTimer = window.setTimeout(reload, AUTH_STORAGE_REFRESH_DELAY_MS);
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(storageTimer);
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
    };
  }, [requests, apply]);

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

  const value = useMemo<AuthState>(() => ({ ...state, logout, refresh }), [state, logout, refresh]);
  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth() must be used inside <AuthProvider>.");
  return value;
}
