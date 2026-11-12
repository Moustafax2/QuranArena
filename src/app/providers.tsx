"use client";

import { AudioProvider, AudioPlayerBar } from "@/components/quran/AudioPlayer";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PrivacyGate } from "@/components/legal/PrivacyGate";

const DATA_FEATURE_PREFIXES = ["/play", "/train", "/progress", "/friends", "/account"];

export function Providers({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const publicPage = pathname === "/privacy" || pathname === "/terms" || pathname === "/privacy/controls" || pathname === "/credits";
  // Study and game features save religious learning data (guests included), so
  // they need consent first. Reading, search and audio stay open; sign-in asks
  // for consent on the login page.
  const dataFeature = DATA_FEATURE_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return (
    <>
      <ServiceWorkerRegister />
      {publicPage ? children : <PrivacyGate required={dataFeature}><AudioProvider>{children}<AudioPlayerBar /></AudioProvider></PrivacyGate>}
    </>
  );
}
