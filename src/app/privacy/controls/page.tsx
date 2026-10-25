"use client";
import Link from "next/link";
import { useState } from "react";

async function clearDeviceData() {
  localStorage.clear(); sessionStorage.clear();
  if ("caches" in window) {
    for (const key of await caches.keys()) if (key.startsWith("quran-reader-")) await caches.delete(key);
  }
}

export default function PrivacyControls() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState("");
  async function action(name: "disconnect" | "delete" | "consent") {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/privacy/${name}`, {
        method: name === "consent" ? "DELETE" : "POST", headers: { "Content-Type": "application/json" },
        body: name === "delete" ? JSON.stringify({ confirmation }) : undefined,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Request failed.");
      let deviceWarning = "";
      if (name === "consent" || name === "delete") {
        try { await clearDeviceData(); } catch { deviceWarning = " Browser cleanup was incomplete. Clear this site's data in your browser settings."; }
      }
      setMessage((name === "consent" ? "Consent withdrawn for your verified account or guest and this browser. Other open browsers stop at their next server check. Existing server records remain until you delete them. Clear local site data on other devices too." :
        name === "disconnect" ? "This QF connection is revoked and existing QuranArena account sessions have been invalidated. Stored app data remains." :
        `${result.message} ${result.qfDisconnected ? "" : "QF token revocation could not be confirmed. Disconnect QuranArena through QF or contact support."}`) + deviceWarning);
      setConfirmation("");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Request failed."); }
    finally { setBusy(false); }
  }
  async function download() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/privacy/export", { cache: "no-store" });
      const server = await response.json();
      if (!response.ok && response.status !== 401) throw new Error(server.error ?? "Export failed.");
      const local: Record<string, string | null> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (/^(quran|qalamspace|memorization|flashcard|fsrs|sm2)/i.test(key)) local[key] = localStorage.getItem(key);
      }
      const blob = new Blob([JSON.stringify({ server: response.ok ? server : null, browserData: local }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = "quranarena-data.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(response.ok ? "Export downloaded. QF-hosted bookmarks are available through Quran.com." : "Browser data downloaded. Sign in or restore your guest session to export server records.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Export failed."); }
    finally { setBusy(false); }
  }
  const button = "rounded-lg border border-gray-600 px-4 py-3 text-sm disabled:opacity-50";
  return <div className="mx-auto max-w-2xl space-y-8 px-5 py-12 text-gray-200">
    <h1 className="text-3xl font-bold text-white">Privacy controls</h1>
    <p>These controls remain available if you withdraw consent. They act on your current signed-in account or verified guest session. For corrections, lost access or QF account deletion, email <a className="text-emerald-400 underline" href="mailto:QuranArena@protonmail.com">QuranArena@protonmail.com</a>.</p>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Download your data</h2><p>Includes this browser’s learning data and your verified account’s app records. Shared game records may include other participants’ identifiers; keep the download private.</p><button className={button} disabled={busy} onClick={() => void download()}>Download data</button></section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Connected permissions</h2><p>Disconnecting revokes this QF connection and signs your account out of QuranArena. It does not delete stored records. Other QF grants may need removal through QF.</p><button className={button} disabled={busy} onClick={() => void action("disconnect")}>Disconnect QF</button><p><Link className="text-emerald-400 underline" href="/login?next=/account">Sign in to add optional bookmark permission</Link></p></section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Withdraw consent</h2><p>This withdraws all existing consent receipts linked to your verified account or guest and pauses study/game features at the next server check. It clears this browser’s saved learning data and preferences; clear site data separately on other devices. Download anything you want to keep first. It does not delete server records; use the deletion control below for those.</p><button className={button} disabled={busy} onClick={() => void action("consent")}>Withdraw consent and clear this browser</button></section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Delete My Data</h2><p>Permanently delete your live QuranArena profile, learning history and social records, and clear this browser’s saved data. Shared rooms may pass to another player. Your main QF account and QF-hosted bookmarks are not deleted. Backup expiry still requires the operator’s retention process.</p><label className="block">Type DELETE to confirm<input className="mt-2 block w-full rounded border border-gray-600 bg-gray-900 p-3" value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" /></label><button className={button + " border-red-500 text-red-300"} disabled={busy || confirmation !== "DELETE"} onClick={() => void action("delete")}>Permanently delete app data</button></section>
    {message && <p role="status" className="rounded border border-gray-700 p-4">{message}</p>}
    <nav className="flex gap-5 text-emerald-400 underline"><Link href="/privacy">Privacy Policy</Link><Link href="/terms">Terms</Link><Link href="/">Home</Link></nav>
  </div>;
}
