"use client";

import { AudioProvider, AudioPlayerBar } from "@/components/quran/AudioPlayer";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PrivacyGate } from "@/components/legal/PrivacyGate";
import { AuthProvider } from "@/lib/hooks/useAuth";

export function Providers({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const publicPage = pathname === "/privacy" || pathname === "/terms" || pathname === "/privacy/controls" || pathname === "/credits";
  // One shared auth state (audit H2). It sits inside the gate, so the session
  // is still only fetched once the gate shows the app, as before.
  return (
    <>
      <ServiceWorkerRegister />
      {publicPage ? <AuthProvider>{children}</AuthProvider> : <PrivacyGate><AuthProvider><AudioProvider>{children}<AudioPlayerBar /></AudioProvider></AuthProvider></PrivacyGate>}
    </>
  );
}
