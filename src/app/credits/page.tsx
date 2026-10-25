import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Content Credits | QuranArena",
  description: "Sources and attributions for Quranic and language resources used by QuranArena.",
};

export default function CreditsPage() {
  return (
    <article className="mx-auto max-w-4xl px-4 py-12 text-gray-300 sm:px-6 sm:py-16">
      <Link href="/" className="text-sm text-emerald-400 underline underline-offset-4">
        Back to QuranArena
      </Link>
      <header className="mt-8">
        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
          QuranArena · Sources
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">
          Content credits
        </h1>
        <p className="mt-4 text-lg leading-8">
          QuranArena is an independent application. Third-party content remains owned by its
          respective authors and publishers.
        </p>
      </header>

      <div className="mt-10 space-y-10 leading-8 [&_a]:text-emerald-400 [&_a]:underline [&_a]:underline-offset-4">
        <section>
          <h2 className="mb-3 text-2xl font-semibold text-white">Quran Foundation content</h2>
          <p>
            Quran text, translations, metadata, recitation information, audio and Mushaf images are
            displayed through Quran Foundation, Quran.com and their documented content hosts. QuranArena
            credits the {" "}
            <a href="https://quran.foundation">Quran Foundation</a> and follows its {" "}
            <a href="https://api-docs.quran.foundation/legal/developer-terms/">Developer Terms</a>.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-2xl font-semibold text-white">Quranic Arabic Corpus</h2>
          <p>
            Morphological annotation is from Quranic Arabic Corpus morphology version 0.4,
            copyright © 2011 Kais Dukes, identified by its source as GNU General Public License.
            The unmodified source file and its complete copyright notice are retained. See the {" "}
            <a href="https://corpus.quran.com/download/">official download and terms</a>.
          </p>
          <p className="mt-4">
            The embedded Quran text named by that source is Tanzil Quran Text (Uthmani version 1.0.2),
            copyright © 2008–2009 Tanzil.info, Creative Commons BY-ND 3.0 Unported. QuranArena does
            not modify that source text. See the <a href="https://tanzil.net/docs/Text_License">Tanzil text license</a>.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-2xl font-semibold text-white">Vocabulary references</h2>
          <p>
            Al-Muyassar fi Al-Gharib was prepared by the Quranic Studies Center and published by the
            King Fahd Complex for the Printing of the Holy Quran. The structured copy used by QuranArena
            is distributed as resource 519 by the {" "}
            <a href="https://qul.tarteel.ai/resources/tafsir/519">Quranic Universal Library</a>.
            Rights in the underlying work and digital edition remain with their respective rights holders.
          </p>
          <p className="mt-4">
            The Hans Wehr dictionary database is sourced from the public {" "}
            <a href="https://github.com/GibreelAbdullah/HansWehrDictionary">GibreelAbdullah/HansWehrDictionary repository</a>,
            which credits Jamal Osman and Muhammad Abdurrahman for digitisation and Quran.com for its
            Quranic word breakdown. QuranArena does not claim ownership of the dictionary text.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-2xl font-semibold text-white">Corrections</h2>
          <p>
            To report a source, attribution or content correction, email {" "}
            <a href="mailto:support@quranarena.ca">support@quranarena.ca</a>.
          </p>
        </section>
      </div>
    </article>
  );
}
