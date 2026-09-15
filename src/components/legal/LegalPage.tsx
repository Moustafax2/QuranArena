import Link from "next/link";
import type { ReactNode } from "react";

export interface LegalSection {
  id: string;
  title: string;
  content: ReactNode;
}

export function LegalPage({ title, description, sections }: {
  title: string;
  description: string;
  sections: LegalSection[];
}) {
  return (
    <article className="mx-auto max-w-4xl px-4 py-12 text-gray-300 sm:px-6 sm:py-16">
      <Link href="/" className="text-sm text-emerald-400 underline underline-offset-4">Back to QuranArena</Link>
      <header className="mt-8">
        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">QuranArena · Legal</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">{title}</h1>
        <p className="mt-4 text-lg leading-8">{description}</p>
        <p className="mt-4 text-sm text-gray-400">Draft updated: September 15, 2026 · Effective date: pending publication</p>
      </header>
      <aside aria-label="Draft status" className="mt-8 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-5 text-sm leading-7 text-amber-100">
        Draft for review. Operator contact details and the safeguards described as proposed below
        still need confirmation before this policy takes effect. This draft is not a statement
        that QuranArena has completed Quran Foundation compliance review.
      </aside>
      <nav aria-label={`${title} contents`} className="my-10 rounded-2xl border border-gray-800 bg-gray-900/50 p-6">
        <h2 className="font-semibold text-white">On this page</h2>
        <ol className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          {sections.map((section, index) => (
            <li key={section.id}><a href={`#${section.id}`} className="text-emerald-400 underline underline-offset-4 hover:text-emerald-300">{index + 1}. {section.title}</a></li>
          ))}
        </ol>
      </nav>
      <div className="space-y-10 [&_a]:text-emerald-400 [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-emerald-300 [&_li]:pl-1 [&_p+p]:mt-4 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
        {sections.map((section, index) => (
          <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`} className="scroll-mt-24">
            <h2 id={`${section.id}-heading`} className="mb-4 text-2xl font-semibold text-white">{index + 1}. {section.title}</h2>
            <div className="leading-8">{section.content}</div>
          </section>
        ))}
      </div>
      <nav aria-label="Legal pages" className="mt-12 flex flex-wrap gap-6 border-t border-gray-800 pt-6 text-sm">
        <Link href="/privacy" className="text-emerald-400 underline underline-offset-4">Privacy Policy</Link>
        <Link href="/terms" className="text-emerald-400 underline underline-offset-4">Terms of Service</Link>
      </nav>
    </article>
  );
}
