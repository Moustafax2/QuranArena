"use client";

import { AudioProvider, AudioPlayerBar } from "@/components/quran/AudioPlayer";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PrivacyGate } from "@/components/legal/PrivacyGate";

export function Providers({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const publicPage = pathname === "/privacy" || pathname === "/terms" || pathname === "/privacy/controls";
  return (
    <>
      <ServiceWorkerRegister />
      {publicPage ? children : <PrivacyGate><AudioProvider>{children}<AudioPlayerBar /></AudioProvider></PrivacyGate>}
    </>
  );
}
