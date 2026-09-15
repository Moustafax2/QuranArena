import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-gray-800 bg-gray-950">
      <div className="mx-auto max-w-6xl px-4 py-8 text-center text-sm text-gray-400">
        <nav aria-label="Legal" className="mb-4 flex flex-wrap justify-center gap-x-6 gap-y-2">
          <Link href="/privacy" className="underline underline-offset-4 hover:text-emerald-400">Privacy Policy</Link>
          <Link href="/terms" className="underline underline-offset-4 hover:text-emerald-400">Terms of Service</Link>
        </nav>
        <p>
          Powered by{" "}
          <a
            href="https://quran.foundation"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-emerald-600"
          >
            Quran Foundation Content API
          </a>
        </p>
      </div>
    </footer>
  );
}
