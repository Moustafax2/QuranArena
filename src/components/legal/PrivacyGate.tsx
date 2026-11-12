"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { checkGuestStorage, touchGuestStorage } from "@/lib/privacy/browser-storage";
import { CONSENT_VERSION } from "@/lib/privacy/tokens";

export function PrivacyGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState("loading");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let guest = false;
    const activity = () => { if (guest) touchGuestStorage(); };
    const check = () => fetch("/api/privacy/consent", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("Privacy controls are temporarily unavailable. Please reload to try again.");
      const data = await response.json();
      guest = data.accepted && !data.account;
      if (guest) checkGuestStorage();
      if (active) setStatus(data.underage ? "underage" : data.accepted ? "accepted" : "pending");
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

  // One explicit, unticked opt-in for religious-data processing (QF Developer
  // Privacy Policy 2.D: separate from Terms acceptance). Continuing confirms age
  // eligibility and acknowledges the Terms and Privacy Policy, linked below.
  async function submit(eligible: boolean) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/privacy/consent", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(eligible
          ? { eligible: true, religiousData: consent, noticeRead: true, version: CONSENT_VERSION }
          : { eligible: false }) });
      const data = await response.json();
      if (!eligible && response.status === 403) { setStatus("underage"); return; }
      if (!response.ok) throw new Error(data.error ?? "Could not save your choice.");
      touchGuestStorage();
      window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save your choice."); }
    finally { setBusy(false); }
  }
  if (status === "accepted") return children;
  return <main className="flex min-h-screen items-center justify-center px-4 py-10 text-gray-200">
    <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900/70 p-6 shadow-xl">
      <h1 className="text-2xl font-bold text-white">Welcome to QuranArena</h1>
      {status === "loading" ? <p className="mt-4 text-gray-400">Loading…</p> : status === "underage" ?
        <p className="mt-4 leading-7">QuranArena is for ages 13 and older. You can still read our <Link className="text-emerald-400 underline" href="/privacy">Privacy Policy</Link> and <Link className="text-emerald-400 underline" href="/terms">Terms</Link>. If this was a mistake, contact support@quranarena.ca.</p> : <>
        <label className="mt-5 flex cursor-pointer items-start gap-3 leading-6">
          <input className="mt-1 h-4 w-4 shrink-0 accent-emerald-500" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
          <span>I agree to QuranArena saving my Quran study and game activity, which can reveal religious beliefs.</span>
        </label>
        {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
        <button disabled={busy || !consent} onClick={() => void submit(true)} className="mt-5 w-full rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50">{busy ? "Saving…" : "Continue"}</button>
        <p className="mt-4 text-sm leading-6 text-gray-400">
          By continuing, you confirm you&apos;re 13 or older and agree to our <Link className="text-emerald-400 underline" href="/terms">Terms</Link> and <Link className="text-emerald-400 underline" href="/privacy">Privacy Policy</Link>. You can withdraw consent anytime in <Link className="text-emerald-400 underline" href="/privacy/controls">Privacy controls</Link>.
        </p>
        <button type="button" disabled={busy} onClick={() => void submit(false)} className="mt-3 text-sm text-gray-500 underline hover:text-gray-300">I&apos;m under 13</button>
      </>}
    </div>
  </main>;
}
