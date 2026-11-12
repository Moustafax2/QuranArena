"use client";
import { useEffect, useState, type ReactNode } from "react";
import { checkGuestStorage, touchGuestStorage } from "@/lib/privacy/browser-storage";
import { fetchConsentStatus, saveConsent } from "@/lib/privacy/consent-client";
import { ConsentChoice, UnderageNotice } from "./ConsentChoice";

type Status = "loading" | "accepted" | "pending" | "underage";

// Consent is collected on the sign-in page, so visitors and guests are never
// blocked. This only prompts a signed-in user whose consent was withdrawn or
// has expired, since their account features would otherwise fail.
export function PrivacyGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [signedIn, setSignedIn] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let guest = false;
    const activity = () => { if (guest) touchGuestStorage(); };
    const check = () => fetchConsentStatus().then(data => {
      // Guest browser data expires after inactivity, consent or not.
      guest = !data.signedIn;
      if (guest) checkGuestStorage();
      if (!active) return;
      setSignedIn(data.signedIn);
      setStatus(data.underage ? "underage" : data.accepted ? "accepted" : "pending");
    }).catch(e => { if (active) { setError(e.message); setStatus("pending"); } });
    void check();
    const recheck = () => { void check(); };
    const timer = window.setInterval(recheck, 30000);
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    window.addEventListener("focus", recheck);
    window.addEventListener("storage", recheck);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("pointerdown", activity); window.removeEventListener("keydown", activity); window.removeEventListener("focus", recheck); window.removeEventListener("storage", recheck); };
  }, []);

  async function submit(eligible: boolean) {
    setBusy(true); setError("");
    try {
      if (await saveConsent(eligible) === "underage") { setStatus("underage"); return; }
      touchGuestStorage();
      window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save your choice."); }
    finally { setBusy(false); }
  }

  if (status === "accepted") return children;
  if (!signedIn) return children;

  return <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10 text-gray-200">
    <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900/70 p-6 shadow-xl">
      {status === "loading" ? <p className="text-gray-400">Loading…</p> : status === "underage" ? <UnderageNotice /> : <>
        <h1 className="mb-4 text-xl font-bold text-white">Save your progress</h1>
        <ConsentChoice checked={consent} onChange={setConsent} onUnderage={() => void submit(false)} disabled={busy} />
        {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
        <button disabled={busy || !consent} onClick={() => void submit(true)} className="mt-5 w-full rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50">{busy ? "Saving…" : "Continue"}</button>
      </>}
    </div>
  </main>;
}
