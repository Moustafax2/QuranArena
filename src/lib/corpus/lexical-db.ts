import type { LexicalEntry } from "@/lib/types/flashcard";
import { CardType } from "@/lib/types/flashcard";

let cachedDB: LexicalEntry[] = [];
// Shared by concurrent callers so the 5.5 MB file is fetched once.
let loading: Promise<LexicalEntry[]> | null = null;

/**
 * Loads the lexical database. A failed load is thrown to the caller (and
 * retried on the next call) instead of silently serving sample data.
 */
export async function loadLexicalDB(): Promise<LexicalEntry[]> {
  if (cachedDB.length > 0) return cachedDB;
  if (!loading) {
    loading = (async () => {
      const response = await fetch("/data/lexical-db.json");
      if (!response.ok) throw new Error(`Lexical DB could not be loaded (${response.status}).`);
      const data = await response.json();
      cachedDB = data.entries || [];
      return cachedDB;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

const stripRoot = (root: string) => root.replace(/[\s_]/g, "");

/** The single entry matching, or null when there is none or more than one. */
function unique(candidates: LexicalEntry[]): LexicalEntry | null {
  return candidates.length === 1 ? candidates[0] : null;
}

export async function getWordById(id: string): Promise<LexicalEntry | null> {
  await loadLexicalDB();
  if (cachedDB.length === 0) return null;

  // Exact match
  const exact = cachedDB.find((entry) => entry.id === id);
  if (exact) return exact;

  // Fallback for IDs that changed after a DB rebuild.
  // ID formats:
  //   verb:     v_{root_underscores}_{lemma_prefix3}
  //   noun:     n_{lemma_prefix5}_{root_prefix3}
  //   particle: p_{text_prefix5}_001
  // A root alone is not enough (many verbs/nouns share one), so the lemma
  // prefix must match too, and the match must be unambiguous; otherwise the
  // card would silently show a different word.
  // Each part is compared the way canonicalization.ts builds it: the lemma
  // prefix with the same substring (startsWith would let a short lemma match
  // a longer, different word), the root without its separators. With the
  // same root format an unchanged id is an exact match, so in practice this
  // only finds words whose root was written with different separators
  // ("ك ت ب" vs "كتب"); no shipped build has used spaced roots so far.
  const parts = id.split("_");
  if (parts.length >= 3) {
    const typePrefix = parts[0];
    if (typePrefix === "v") {
      const root = stripRoot(parts.slice(1, -1).join("_"));
      const lemmaPrefix = parts[parts.length - 1];
      const match = unique(
        cachedDB.filter(
          (e) => e.type === CardType.VERB && e.root && stripRoot(e.root) === root && e.lemma?.substring(0, 3) === lemmaPrefix
        )
      );
      if (match) return match;
    } else if (typePrefix === "n") {
      const lemmaPrefix = parts[1];
      // root.substring(0, 3) of the root as it was then; of a spaced root that
      // is fewer letters ("ك ت"), so it is compared as a prefix.
      const rootPrefix = stripRoot(parts[parts.length - 1]);
      const match = rootPrefix
        ? unique(
            cachedDB.filter(
              (e) =>
                e.type === CardType.NOUN &&
                e.root &&
                stripRoot(e.root).startsWith(rootPrefix) &&
                e.lemma?.substring(0, 5) === lemmaPrefix
            )
          )
        : null;
      if (match) return match;
    }
  }

  // Cards saved while the sample DB was active: use the real entry only when
  // exactly one has the same type, root and lemma; otherwise show the sample.
  const mockEntry = getMockData().find((entry) => entry.id === id);
  if (mockEntry) {
    if (mockEntry.root) {
      const root = stripRoot(mockEntry.root);
      const realEntry = unique(
        cachedDB.filter(
          (e) =>
            e.type === mockEntry.type &&
            e.root &&
            stripRoot(e.root) === root &&
            (e.lemma ?? e.canonical_form) === (mockEntry.lemma ?? mockEntry.canonical_form)
        )
      );
      if (realEntry) return realEntry;
    }
    return mockEntry;
  }

  return null;
}

export async function getWordsBySurah(surahNumber: number): Promise<LexicalEntry[]> {
  await loadLexicalDB();
  if (cachedDB.length === 0) return [];
  return cachedDB.filter((entry) =>
    entry.examples.some((ex) => ex.surah === surahNumber)
  );
}

export async function searchWords(query: string): Promise<LexicalEntry[]> {
  await loadLexicalDB();
  if (cachedDB.length === 0) return [];
  const lowerQuery = query.toLowerCase();
  return cachedDB.filter(
    (entry) =>
      entry.canonical_form.includes(query) ||
      entry.translation.toLowerCase().includes(lowerQuery) ||
      entry.root?.includes(query)
  );
}

function getMockData(): LexicalEntry[] {
  return [
    {
      id: "v_amana_001",
      type: CardType.VERB,
      canonical_form: "آمَنَ",
      root: "ء م ن",
      forms: {
        past: "آمَنَ",
        present: "يُؤْمِنُ",
        imperative: "آمِنْ",
        verbal_noun: "إِيمَانٌ",
      },
      translation: "to believe",
      examples: [{ surah: 2, ayah: 3, position: 2 }],
      source: "mock",
      frequency: 100,
    },
    {
      id: "n_kitab_001",
      type: CardType.NOUN,
      canonical_form: "كِتَابٌ",
      root: "ك ت ب",
      lemma: "كتاب",
      forms: {
        singular: "كِتَابٌ",
        plural: "كُتُبٌ",
      },
      translation: "book",
      examples: [{ surah: 2, ayah: 2, position: 3 }],
      source: "mock",
      frequency: 80,
    },
    {
      id: "p_min_001",
      type: CardType.PARTICLE,
      canonical_form: "مِنْ",
      translation: "from",
      examples: [{ surah: 1, ayah: 1, position: 1 }],
      source: "mock",
      frequency: 200,
    },
    {
      id: "v_kataba_001",
      type: CardType.VERB,
      canonical_form: "كَتَبَ",
      root: "ك ت ب",
      forms: {
        past: "كَتَبَ",
        present: "يَكْتُبُ",
        imperative: "اكْتُبْ",
        verbal_noun: "كِتَابَةٌ",
      },
      translation: "to write",
      examples: [{ surah: 2, ayah: 282, position: 5 }],
      source: "mock",
      frequency: 50,
    },
    {
      id: "n_salat_001",
      type: CardType.NOUN,
      canonical_form: "صَلَاةٌ",
      root: "ص ل و",
      lemma: "صلاة",
      forms: {
        singular: "صَلَاةٌ",
        plural: "صَلَوَاتٌ",
      },
      translation: "prayer",
      examples: [{ surah: 2, ayah: 3, position: 5 }],
      source: "mock",
      frequency: 70,
    },
  ];
}
