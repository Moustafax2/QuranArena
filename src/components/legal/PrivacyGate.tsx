"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { checkGuestStorage, touchGuestStorage } from "@/lib/privacy/browser-storage";
import { CONSENT_VERSION } from "@/lib/privacy/tokens";

export function PrivacyGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState("loading");
  const [age, setAge] = useState("");
  const [consent, setConsent] = useState(false);
  const [noticeRead, setNoticeRead] = useState(false);
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

  async function submit() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/privacy/consent", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eligible: age === "yes", religiousData: consent, noticeRead, version: CONSENT_VERSION }) });
      const data = await response.json();
      if (age === "no" && response.status === 403) { setStatus("underage"); return; }
      if (!response.ok) throw new Error(data.error ?? "Could not save choices.");
      touchGuestStorage();
      window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save choices."); }
    finally { setBusy(false); }
  }
  if (status === "accepted") return children;
  return <main className="mx-auto max-w-xl px-5 py-16 text-gray-200">
    <h1 className="text-3xl font-bold text-white">Before you use QuranArena</h1>
    {status === "loading" ? <p className="mt-6">Checking your privacy choices…</p> : status === "underage" ?
      <p className="mt-6">QuranArena is for ages 13 and older. You can still read our privacy and terms pages. If this age choice was a mistake, contact QuranArena@protonmail.com.</p> : <>
      <p className="mt-5 leading-7">Bookmarks, learning history and game activity can reveal religious beliefs. With your permission, we use them for study tools, progress, syncing and multiplayer. Guest play can also save data on our servers. Existing local learning history may be uploaded when a player identity becomes available.</p>
      <fieldset className="mt-6 space-y-3"><legend className="mb-3 font-semibold">Are you at least 13 and old enough to use this service under your local law?</legend>
        <label className="block"><input type="radio" name="age" value="yes" checked={age === "yes"} onChange={() => setAge("yes")} /> Yes</label>
        <label className="block"><input type="radio" name="age" value="no" checked={age === "no"} onChange={() => setAge("no")} /> No</label>
      </fieldset>
      {age !== "no" && <div className="mt-6 space-y-4">
        <label className="flex items-start gap-3"><input className="mt-1" type="checkbox" checked={noticeRead} onChange={e => setNoticeRead(e.target.checked)} /><span>I have read the <Link className="text-emerald-400 underline" href="/privacy">Privacy Policy</Link> and <Link className="text-emerald-400 underline" href="/terms">Terms</Link>. If I am below the age of majority, I have a parent or guardian’s permission.</span></label>
        <label className="flex items-start gap-3"><input className="mt-1" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>I explicitly consent to QuranArena processing my religious learning data for these features, including saving and syncing my activity. I can withdraw this consent in Privacy controls.</span></label>
      </div>}
      {error && <p role="alert" className="mt-4 text-red-300">{error}</p>}
      <button disabled={busy || !age || (age === "yes" && (!consent || !noticeRead))} onClick={() => void submit()} className="mt-6 rounded-lg bg-emerald-600 px-5 py-3 font-semibold disabled:opacity-50">{busy ? "Saving…" : "Continue"}</button>
      <p className="mt-4 text-sm">You may decline by leaving this page. Study and game features remain unavailable without consent.</p>
    </>}
    <nav className="mt-8 flex flex-wrap gap-5 text-emerald-400 underline"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/privacy/controls">Privacy controls</Link></nav>
  </main>;
}
