import type { LexicalEntry, UserFlashcard, WordStatus } from "@/lib/types/flashcard";
import { getWordsBySurah } from "@/lib/corpus/lexical-db";
import { getFlashcards, addFlashcards } from "@/lib/storage/flashcard-storage-supabase";
import { createNewCard } from "@/lib/fsrs/scheduler";

const QURAN_API = "https://api.quran.com/api/v4";

async function getSurahVerseLocationMap(surahNumber: number): Promise<
  Map<number, { pageNumber: number; juzNumber: number }>
> {
  const response = await fetch(
    `${QURAN_API}/verses/by_chapter/${surahNumber}?language=en&fields=page_number,juz_number&per_page=300`
  );
  if (!response.ok) {
    throw new Error(`Failed to load verse metadata for surah ${surahNumber}.`);
  }

  const payload = (await response.json()) as {
    verses: Array<{
      verse_number: number;
      page_number: number;
      juz_number: number;
    }>;
  };

  return new Map(
    (payload.verses ?? []).map((verse) => [
      verse.verse_number,
      {
        pageNumber: verse.page_number,
        juzNumber: verse.juz_number,
      },
    ])
  );
}

export async function getSurahWords(surahNumber: number): Promise<LexicalEntry[]> {
  return await getWordsBySurah(surahNumber);
}

export async function filterNewWords(
  words: LexicalEntry[],
  userBank?: UserFlashcard[]
): Promise<LexicalEntry[]> {
  const bank = userBank || (await getFlashcards());
  const existingWordIds = new Set(bank.map((card) => card.word_id));
  return words.filter((word) => !existingWordIds.has(word.id));
}

export async function addWordsToBank(
  wordIds: string[],
  status: WordStatus,
  surahNumber?: number
): Promise<void> {
  const words = surahNumber ? await getSurahWords(surahNumber) : [];
  const wordMap = new Map(words.map((word) => [word.id, word]));
  const verseLocationMap = surahNumber
    ? await getSurahVerseLocationMap(surahNumber).catch(() => new Map<number, { pageNumber: number; juzNumber: number }>())
    : new Map<number, { pageNumber: number; juzNumber: number }>();

  // The server lists cards by created_at, then id. Cards of one batch are a
  // millisecond apart, so new words keep the order they were added in rather
  // than the random order of their ids (verification D5).
  const batchStart = Date.now();
  const cards = wordIds.map((wordId, index): UserFlashcard => {
    const sourceExample = surahNumber
      ? wordMap.get(wordId)?.examples.find((example) => example.surah === surahNumber) ?? null
      : null;
    const verseLocation = sourceExample
      ? verseLocationMap.get(sourceExample.ayah) ?? null
      : null;

    return {
      id: crypto.randomUUID(),
      word_id: wordId,
      fsrs_state: createNewCard(),
      created_at: new Date(batchStart + index),
      status,
      source_surah_id: sourceExample?.surah ?? null,
      source_ayah_number: sourceExample?.ayah ?? null,
      source_page_number: verseLocation?.pageNumber ?? null,
      source_juz_number: verseLocation?.juzNumber ?? null,
    };
  });

  // One request for the whole batch instead of one per word.
  await addFlashcards(cards);
}

export async function getWordIntakeStats(surahNumber: number): Promise<{
  total: number;
  inBank: number;
  new: number;
}> {
  const words = await getSurahWords(surahNumber);
  const bank = await getFlashcards();
  const existingWordIds = new Set(bank.map((card) => card.word_id));

  return {
    total: words.length,
    inBank: words.filter((w) => existingWordIds.has(w.id)).length,
    new: words.filter((w) => !existingWordIds.has(w.id)).length,
  };
}
