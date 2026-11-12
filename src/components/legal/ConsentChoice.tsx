"use client";

import Link from "next/link";

// The one consent box shown before features that save study or game data.
// Per the QF Developer Privacy Policy (2.D) it is unticked by default and kept
// separate from accepting the Terms, which is the fine print below it.
export function ConsentChoice({
  checked,
  onChange,
  onUnderage,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  onUnderage: () => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-3 leading-6 text-gray-200">
        <input
          className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>I agree to QuranArena saving my Quran study and game activity, which can reveal religious beliefs.</span>
      </label>
      <p className="mt-3 text-sm leading-6 text-gray-400">
        By continuing, you confirm you&apos;re 13 or older and agree to our{" "}
        <Link className="text-emerald-400 underline" href="/terms">Terms</Link> and{" "}
        <Link className="text-emerald-400 underline" href="/privacy">Privacy Policy</Link>. You can withdraw consent anytime in{" "}
        <Link className="text-emerald-400 underline" href="/privacy/controls">Privacy controls</Link>.
      </p>
      <button
        type="button"
        disabled={disabled}
        onClick={onUnderage}
        className="mt-2 text-sm text-gray-500 underline hover:text-gray-300"
      >
        I&apos;m under 13
      </button>
    </div>
  );
}

export function UnderageNotice() {
  return (
    <p className="leading-7 text-gray-200">
      QuranArena&apos;s study, game and sign-in features are for ages 13 and older. You can still read the Quran and our{" "}
      <Link className="text-emerald-400 underline" href="/privacy">Privacy Policy</Link> and{" "}
      <Link className="text-emerald-400 underline" href="/terms">Terms</Link>. If this was a mistake, contact support@quranarena.ca.
    </p>
  );
}
