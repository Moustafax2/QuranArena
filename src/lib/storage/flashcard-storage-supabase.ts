"use client";

// ── localStorage helpers (algorithm/SM2/FSRS params) ──────────────────────────
// The algorithm choice and FSRS parameters are stored with the preferences on
// the server for signed-in users; these keys are the device copy the
// scheduler reads synchronously (and the only copy for guests).

import type {
  UserFlashcard,
  ReviewLogEntry,
  ReviewLogFilters,
  UserPreferences,
  FSRSCard,
  WordStatus,
  Rating,
  FSRSParameters,
  SM2Card,
} from "@/lib/types/flashcard";
import { DEFAULT_PREFERENCES, DEFAULT_FSRS_PARAMETERS, FSRSState } from "@/lib/types/flashcard";
import * as localFlashcardStorage from "@/lib/storage/flashcard-storage";
import { SESSION_EXPIRED_CODE } from "@/lib/flashcard/auth-required";
import { normalizeImportedCard } from "@/lib/flashcard/import-cards";

const FSRS_PARAMS_KEY = "qalamspace_fsrs_params";
const SM2_STATES_KEY = "qalamspace_sm2_states";
const ALGORITHM_KEY = "qalamspace_algorithm";
const MAX_INTERVAL_UPGRADED_KEY = "qalamspace_max_interval_upgraded";
/** The maximum interval older versions used as their default (N1). */
const OLD_DEFAULT_MAXIMUM_INTERVAL = 365;

/**
 * N1 follow-up (user decision): parameters saved on this device with the old
 * default maximum interval of 365 days move to the new default. Any other
 * value is the user's own and is kept. This runs once per device, before this
 * version first reads or writes the device copy, so it only ever changes a
 * value saved by an older version: a 365 the user picks later, or one cached
 * from the server, stays. Server rows are moved by migration 013. Running
 * before every read also means the one-time upload of device parameters
 * (migrateDeviceSchedulerPreferences) and imports never send the old value.
 */
function upgradeStoredMaximumInterval(): void {
  if (localStorage.getItem(MAX_INTERVAL_UPGRADED_KEY) === "true") return;
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(FSRS_PARAMS_KEY) ?? "null");
  } catch {
    // Unreadable parameters are replaced by the defaults when read.
  }
  if (
    stored !== null &&
    typeof stored === "object" &&
    (stored as Partial<FSRSParameters>).maximum_interval === OLD_DEFAULT_MAXIMUM_INTERVAL
  ) {
    localStorage.setItem(
      FSRS_PARAMS_KEY,
      JSON.stringify({ ...stored, maximum_interval: DEFAULT_FSRS_PARAMETERS.maximum_interval })
    );
  }
  localStorage.setItem(MAX_INTERVAL_UPGRADED_KEY, "true");
}

export function getFSRSParameters(): FSRSParameters {
  if (typeof window === "undefined") return DEFAULT_FSRS_PARAMETERS;
  try {
    upgradeStoredMaximumInterval();
    const json = localStorage.getItem(FSRS_PARAMS_KEY);
    if (!json) return DEFAULT_FSRS_PARAMETERS;
    return { ...DEFAULT_FSRS_PARAMETERS, ...JSON.parse(json) };
  } catch {
    return DEFAULT_FSRS_PARAMETERS;
  }
}

export function saveFSRSParameters(params: FSRSParameters): void {
  if (typeof window === "undefined") return;
  upgradeStoredMaximumInterval();
  localStorage.setItem(FSRS_PARAMS_KEY, JSON.stringify(params));
}

export function getAlgorithmPreference(): "fsrs" | "sm2" {
  if (typeof window === "undefined") return "fsrs";
  // Anything else (e.g. "undefined" written by an older bug) means the default.
  return localStorage.getItem(ALGORITHM_KEY) === "sm2" ? "sm2" : "fsrs";
}

export function saveAlgorithmPreference(algo: "fsrs" | "sm2"): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ALGORITHM_KEY, algo);
}

/**
 * SM-2 states saved by older app versions, which kept them only in this
 * browser. New states are stored on each card (sm2_state); these are merged
 * into cards that have none and uploaded once by migrateFromLocalStorage.
 */
export function getAllSM2States(): Record<string, SM2Card> {
  if (typeof window === "undefined") return {};
  try {
    const json = localStorage.getItem(SM2_STATES_KEY);
    if (!json) return {};
    const raw = JSON.parse(json) as Record<string, SM2Card & { due: string; last_review?: string }>;
    const result: Record<string, SM2Card> = {};
    for (const [id, state] of Object.entries(raw)) {
      result[id] = {
        ...state,
        due: new Date(state.due),
        last_review: state.last_review ? new Date(state.last_review) : undefined,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export async function saveSM2State(cardId: string, state: SM2Card): Promise<void> {
  await updateFlashcard(cardId, { sm2_state: state });
}

export async function deleteSM2State(cardId: string): Promise<void> {
  await updateFlashcard(cardId, { sm2_state: null });
  forgetLegacySM2State(cardId);
}

/** Removes a card's legacy state, which would otherwise be merged back in on read. */
function forgetLegacySM2State(cardId: string): void {
  if (typeof window === "undefined") return;
  const legacy = getAllSM2States();
  if (legacy[cardId]) {
    delete legacy[cardId];
    localStorage.setItem(SM2_STATES_KEY, JSON.stringify(legacy));
  }
}

function hydrateSM2State(raw: unknown): SM2Card | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as SM2Card & { due: string | Date; last_review?: string | Date };
  return {
    ...state,
    due: new Date(state.due),
    last_review: state.last_review ? new Date(state.last_review) : undefined,
  };
}

function sm2StateToBody(state: SM2Card | null) {
  if (!state) return null;
  return {
    ...state,
    due: new Date(state.due).toISOString(),
    last_review: state.last_review ? new Date(state.last_review).toISOString() : undefined,
  };
}

/** Fills in SM-2 states that only exist in the legacy localStorage map. */
function withLegacySM2States(cards: UserFlashcard[]): UserFlashcard[] {
  const legacy = getAllSM2States();
  if (Object.keys(legacy).length === 0) return cards;
  return cards.map((card) => (card.sm2_state || !legacy[card.id] ? card : { ...card, sm2_state: legacy[card.id] }));
}

export function clearAllSM2States(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(SM2_STATES_KEY);
}

// ── API helpers ───────────────────────────────────────────────────────────────
// All flashcard data goes through server-side API routes authenticated via the
// QF session cookie. If the user is not signed in (401), we fall back to
// localStorage so unauthenticated users can still demo the app. A 401 that
// says the request carried a sign-in that is no longer usable means the
// session expired: that is reported instead, so the user's data isn't split
// between the server and this browser (audit M10). The server decides this
// from the session cookie, which outlives the browser-storage clean-up the
// privacy gate runs once a session has lapsed.

export class SessionExpiredError extends Error {
  constructor() {
    super("Your sign-in has expired. Sign in again to keep your progress in sync.");
    this.name = "SessionExpiredError";
  }
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T | null> {
  const res = await fetch(url, options);
  if (res.status === 401) {
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    if (body?.code === SESSION_EXPIRED_CODE) throw new SessionExpiredError();
    return null; // guest → localStorage fallback
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text);
  }
  return res.json() as Promise<T>;
}

// ── Date hydration ────────────────────────────────────────────────────────────

type RawCard = {
  id: string;
  word_id: string;
  status: string;
  fsrs_state: { due: string; last_review?: string; [k: string]: unknown };
  sm2_state?: unknown;
  created_at: string;
  source_surah_id: number | null;
  source_ayah_number: number | null;
  source_juz_number: number | null;
  source_page_number: number | null;
};

type RawReview = {
  id: string;
  card_id: string;
  word_id: string;
  rating: number;
  timestamp: string;
  session_id: string;
  review_duration_ms: number | null;
  state_before: number;
  state_after: number;
};

function hydrateCard(row: RawCard): UserFlashcard {
  return {
    id: row.id,
    word_id: row.word_id,
    status: row.status as WordStatus,
    fsrs_state: {
      ...(row.fsrs_state as unknown as FSRSCard),
      due: new Date(row.fsrs_state.due),
      last_review: row.fsrs_state.last_review
        ? new Date(row.fsrs_state.last_review)
        : undefined,
      learning_steps: ((row.fsrs_state as unknown as FSRSCard).learning_steps) ?? 0,
    },
    sm2_state: hydrateSM2State(row.sm2_state),
    created_at: new Date(row.created_at),
    source_surah_id: row.source_surah_id,
    source_ayah_number: row.source_ayah_number,
    source_juz_number: row.source_juz_number,
    source_page_number: row.source_page_number,
  };
}

function hydrateReview(row: RawReview): ReviewLogEntry {
  return {
    id: row.id,
    card_id: row.card_id,
    word_id: row.word_id,
    rating: row.rating as Rating,
    timestamp: new Date(row.timestamp),
    session_id: row.session_id,
    review_duration_ms: row.review_duration_ms ?? undefined,
    state_before: row.state_before as FSRSState,
    state_after: row.state_after as FSRSState,
  };
}

function cardToBody(card: UserFlashcard) {
  return {
    id: card.id,
    word_id: card.word_id,
    status: card.status,
    fsrs_state: {
      ...card.fsrs_state,
      due: card.fsrs_state.due.toISOString(),
      last_review: card.fsrs_state.last_review?.toISOString(),
    },
    ...(card.sm2_state !== undefined ? { sm2_state: sm2StateToBody(card.sm2_state) } : {}),
    created_at: card.created_at.toISOString(),
    source_surah_id: card.source_surah_id ?? null,
    source_ayah_number: card.source_ayah_number ?? null,
    source_juz_number: card.source_juz_number ?? null,
    source_page_number: card.source_page_number ?? null,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Writes cards in one batch and returns the ones the server skipped as
 * malformed (A4 review #5). A guest's cards are saved on this device.
 */
export async function saveFlashcards(cards: UserFlashcard[]): Promise<{ skipped: UserFlashcard[] }> {
  const result = await apiFetch<{ ok: boolean; skipped?: number; skipped_indexes?: number[] }>("/api/flashcards/cards", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cards.map(cardToBody)),
  });
  if (result === null) {
    await localFlashcardStorage.saveFlashcards(cards);
    return { skipped: [] };
  }
  const skipped = (result.skipped_indexes ?? []).flatMap((index) => (cards[index] ? [cards[index]] : []));
  if ((result.skipped ?? 0) > skipped.length) {
    console.warn(`The server skipped ${result.skipped} flashcard(s) without saying which.`);
  }
  return { skipped };
}

export async function getFlashcards(): Promise<UserFlashcard[]> {
  const rows = await apiFetch<RawCard[]>("/api/flashcards/cards");
  if (rows === null) return withLegacySM2States(await localFlashcardStorage.getFlashcards());
  return withLegacySM2States(rows.map(hydrateCard));
}

export async function addFlashcard(card: UserFlashcard): Promise<void> {
  const result = await apiFetch<{ ok: boolean }>("/api/flashcards/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cardToBody(card)),
  });
  if (result === null) await localFlashcardStorage.addFlashcard(card);
}

/** Adds several cards in one request; words already in the deck are kept as they are. */
export async function addFlashcards(cards: UserFlashcard[]): Promise<void> {
  if (cards.length === 0) return;
  const result = await apiFetch<{ ok: boolean }>("/api/flashcards/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cards.map(cardToBody)),
  });
  if (result === null) await localFlashcardStorage.addFlashcards(cards);
}

export async function updateFlashcard(
  cardId: string,
  updates: Partial<UserFlashcard>
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (updates.word_id !== undefined) body.word_id = updates.word_id;
  if (updates.status !== undefined) body.status = updates.status;
  if (updates.source_surah_id !== undefined) body.source_surah_id = updates.source_surah_id;
  if (updates.source_ayah_number !== undefined) body.source_ayah_number = updates.source_ayah_number;
  if (updates.source_juz_number !== undefined) body.source_juz_number = updates.source_juz_number;
  if (updates.source_page_number !== undefined) body.source_page_number = updates.source_page_number;
  if (updates.fsrs_state !== undefined) {
    body.fsrs_state = {
      ...updates.fsrs_state,
      due: updates.fsrs_state.due.toISOString(),
      last_review: updates.fsrs_state.last_review?.toISOString(),
    };
  }
  if (updates.sm2_state !== undefined) body.sm2_state = sm2StateToBody(updates.sm2_state);

  const result = await apiFetch<{ ok: boolean }>(`/api/flashcards/cards/${cardId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (result === null) await localFlashcardStorage.updateFlashcard(cardId, updates);
}

/**
 * Browse → "Unlearn": the card starts over as a new card in both schedulers
 * (FSRS and Classic). Returns its new FSRS state.
 */
export async function unlearnFlashcard(cardId: string): Promise<FSRSCard> {
  const fsrs_state: FSRSCard = {
    due: new Date(),
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    state: FSRSState.New,
    last_review: undefined,
  };
  await updateFlashcard(cardId, { fsrs_state, sm2_state: null });
  forgetLegacySM2State(cardId);
  return fsrs_state;
}

export async function deleteFlashcard(cardId: string): Promise<void> {
  const result = await apiFetch<{ ok: boolean }>(`/api/flashcards/cards/${cardId}`, {
    method: "DELETE",
  });
  if (result === null) await localFlashcardStorage.deleteFlashcard(cardId);
}

export async function getFlashcardByWordId(wordId: string): Promise<UserFlashcard | null> {
  const row = await apiFetch<RawCard | null>(
    `/api/flashcards/cards/word/${encodeURIComponent(wordId)}`
  );
  if (row === null) return localFlashcardStorage.getFlashcardByWordId(wordId);
  if (!row) return null;
  return hydrateCard(row);
}

export async function saveFSRSState(cardId: string, state: FSRSCard): Promise<void> {
  await updateFlashcard(cardId, { fsrs_state: state });
}

export async function getFSRSState(cardId: string): Promise<FSRSCard | null> {
  const cards = await getFlashcards();
  return cards.find((c) => c.id === cardId)?.fsrs_state ?? null;
}

export async function saveReviewLog(log: ReviewLogEntry): Promise<void> {
  const result = await apiFetch<{ ok: boolean }>("/api/flashcards/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: log.id,
      card_id: log.card_id,
      word_id: log.word_id,
      rating: log.rating,
      timestamp: log.timestamp.toISOString(),
      session_id: log.session_id,
      review_duration_ms: log.review_duration_ms ?? null,
      state_before: log.state_before,
      state_after: log.state_after,
    }),
  });
  if (result === null) await localFlashcardStorage.saveReviewLog(log);
}

function reviewToBody(log: ReviewLogEntry) {
  return {
    id: log.id,
    card_id: log.card_id,
    word_id: log.word_id,
    rating: log.rating,
    timestamp: log.timestamp.toISOString(),
    session_id: log.session_id,
    review_duration_ms: log.review_duration_ms ?? null,
    state_before: log.state_before,
    state_after: log.state_after,
  };
}

/**
 * Uploads many reviews in batches. The server ignores ids it already has, so
 * re-running an interrupted upload is safe.
 */
export async function saveReviewLogs(logs: ReviewLogEntry[]): Promise<void> {
  for (let i = 0; i < logs.length; i += 500) {
    const batch = logs.slice(i, i + 500);
    const result = await apiFetch<{ ok: boolean }>("/api/flashcards/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch.map(reviewToBody)),
    });
    if (result === null) {
      for (const log of batch) await localFlashcardStorage.saveReviewLog(log);
    }
  }
}

export async function getReviewLog(filters?: ReviewLogFilters): Promise<ReviewLogEntry[]> {
  const params = new URLSearchParams();
  if (filters?.session_id) params.set("session_id", filters.session_id);
  if (filters?.word_id) params.set("word_id", filters.word_id);
  if (filters?.rating) params.set("rating", String(filters.rating));
  if (filters?.start_date) params.set("start_date", filters.start_date.toISOString());
  if (filters?.end_date) params.set("end_date", filters.end_date.toISOString());

  // The API returns at most 500 rows per request, so page through the rest.
  const pageSize = 500;
  params.set("limit", String(pageSize));
  const rows: RawReview[] = [];
  for (let offset = 0; ; offset += pageSize) {
    params.set("offset", String(offset));
    const page = await apiFetch<RawReview[]>(`/api/flashcards/reviews?${params}`);
    if (page === null) return localFlashcardStorage.getReviewLog(filters);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.map(hydrateReview);
}

export async function deleteReviewLogEntry(logId: string): Promise<void> {
  const result = await apiFetch<{ ok: boolean }>(`/api/flashcards/reviews/${logId}`, {
    method: "DELETE",
  });
  if (result === null) {
    try {
      const raw = localStorage.getItem("qalamspace_reviews");
      if (raw) {
        const entries = JSON.parse(raw) as { id: string }[];
        localStorage.setItem(
          "qalamspace_reviews",
          JSON.stringify(entries.filter((e) => e.id !== logId))
        );
      }
    } catch { /* ignore */ }
  }
}

export async function savePreferences(
  prefs: UserPreferences,
  fsrsParams: FSRSParameters = getFSRSParameters()
): Promise<void> {
  const result = await apiFetch<{ ok: boolean }>("/api/flashcards/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...prefs, fsrs_params: fsrsParams }),
  });
  if (result === null) await localFlashcardStorage.savePreferences(prefs);
  // Old exports and local preferences have no algorithm; keep the device's choice then.
  if (prefs.algorithm === "fsrs" || prefs.algorithm === "sm2") saveAlgorithmPreference(prefs.algorithm);
  saveFSRSParameters(fsrsParams);
}

/**
 * Settings → switch algorithm. The scheduler reads the device copy, so it is
 * set first; if the account can't save the choice, the device goes back to the
 * previous algorithm. Otherwise the next getPreferences would restore the
 * account's old choice over it without telling the user (code review #6).
 */
export async function saveAlgorithmChoice(
  prefs: UserPreferences,
  algorithm: "fsrs" | "sm2",
  fsrsParams: FSRSParameters
): Promise<void> {
  const previous = getAlgorithmPreference();
  saveAlgorithmPreference(algorithm);
  try {
    await savePreferences({ ...prefs, algorithm }, fsrsParams);
  } catch (error) {
    saveAlgorithmPreference(previous);
    throw error;
  }
}

export async function getPreferences(): Promise<UserPreferences> {
  const row = await apiFetch<Record<string, unknown>>("/api/flashcards/preferences");
  // The device copy is the one algorithm setting, for guests as for accounts:
  // the settings page shows it, and sign-out removes it (code review #8).
  if (row === null) return { ...(await localFlashcardStorage.getPreferences()), algorithm: getAlgorithmPreference() };
  if (!row) return DEFAULT_PREFERENCES;

  // fsrs_params is written on every save by this version. A row without it was
  // saved by an older version that kept the algorithm and parameters only on
  // the device, so keep using the device's copy in that case.
  const serverHasScheduler = row.fsrs_params !== null && typeof row.fsrs_params === "object";
  if (serverHasScheduler) {
    saveFSRSParameters({ ...DEFAULT_FSRS_PARAMETERS, ...(row.fsrs_params as Partial<FSRSParameters>) });
    if (row.algorithm === "fsrs" || row.algorithm === "sm2") saveAlgorithmPreference(row.algorithm);
  }
  return {
    show_arabic_explanation: row.show_arabic_explanation as boolean,
    show_root: row.show_root as boolean,
    show_ayah_examples: row.show_ayah_examples as boolean,
    include_particles: row.include_particles as boolean,
    include_proper_nouns: row.include_proper_nouns as boolean,
    auto_audio: row.auto_audio as boolean,
    show_transliteration: row.show_transliteration as boolean,
    daily_new_cards_limit: row.daily_new_cards_limit as number,
    daily_review_cards_limit: row.daily_review_cards_limit as number,
    session_size: row.session_size as number,
    normalization_level: row.normalization_level as "strict" | "moderate" | "broad",
    algorithm: getAlgorithmPreference(),
    new_cards_ignore_review_limit: row.new_cards_ignore_review_limit === true,
  };
}

export async function resetAllData(): Promise<void> {
  const result = await apiFetch<{ ok: boolean }>("/api/flashcards/reset", {
    method: "DELETE",
  });
  if (result === null) await localFlashcardStorage.resetAllData();
}

export async function exportData(): Promise<string> {
  const [flashcards, reviews, preferences] = await Promise.all([
    getFlashcards(),
    getReviewLog(),
    getPreferences(),
  ]);
  return JSON.stringify(
    { flashcards, reviews, preferences, exported_at: new Date().toISOString(), version: "1.0.0" },
    null,
    2
  );
}

/**
 * Imports a backup. Returns the cards that could not be stored, as they were
 * in the backup, so the caller can tell the user how many were skipped and
 * keep them (A4 review #5). Repairable shapes are repaired first
 * (normalizeImportedCard).
 */
export async function importData(jsonData: string): Promise<{ skippedCards: unknown[] }> {
  const skippedCards: unknown[] = [];
  try {
    const data = JSON.parse(jsonData);

    if (data.flashcards && Array.isArray(data.flashcards)) {
      const raw = data.flashcards as unknown[];
      const cards: UserFlashcard[] = [];
      const rawFor = new Map<UserFlashcard, unknown>();
      for (const entry of raw) {
        const card = normalizeImportedCard(entry);
        if (card) {
          cards.push(card);
          rawFor.set(card, entry);
        } else {
          skippedCards.push(entry);
        }
      }
      if (cards.length > 0) {
        const { skipped } = await saveFlashcards(cards);
        skippedCards.push(...skipped.map((card) => rawFor.get(card)));
      }
    }

    if (data.preferences) await savePreferences(data.preferences);

    if (data.reviews && Array.isArray(data.reviews)) {
      const reviews = (data.reviews as Array<Omit<ReviewLogEntry, "timestamp"> & { timestamp: string }>).map(
        (review) => ({ ...review, timestamp: new Date(review.timestamp) })
      );
      // A review whose time can't be read can't be sent (toISOString throws)
      // and would stop every later review; the server skips other bad ones.
      const readable = reviews.filter((review) => !Number.isNaN(review.timestamp.getTime()));
      if (readable.length < reviews.length) {
        console.warn(`Skipped ${reviews.length - readable.length} review(s) whose time could not be read.`);
      }
      await saveReviewLogs(readable);
    }
  } catch (error) {
    // An expired session must reach the page as itself (M10, Phase 2 D1).
    if (error instanceof SessionExpiredError) throw error;
    console.error("Failed to import data:", error);
    throw new Error("Failed to import data");
  }
  if (skippedCards.length > 0) console.warn(`Skipped ${skippedCards.length} flashcard(s) that could not be stored.`);
  return { skippedCards };
}

/**
 * Cards from this browser's old local deck that the sign-in migration could
 * not upload (A4 review #5). They are kept here, never dropped, and the
 * flashcards hub tells the user about them. The key matches
 * clearLearningStorage()'s prefix, so a guest-expiry or privacy wipe covers it.
 */
const UNSYNCED_FLASHCARDS_KEY = "qalamspace_flashcards_unsynced";

function readUnsyncedFlashcards(): unknown[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(UNSYNCED_FLASHCARDS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** How many local cards the sign-in migration kept on this device. */
export function getUnsyncedFlashcardCount(): number {
  if (typeof window === "undefined") return 0;
  return readUnsyncedFlashcards().length;
}

/**
 * Moves SM-2 states from the legacy localStorage map onto the cards (server
 * for signed-in users, local cards for guests) in one write. The map is keyed
 * by this browser's card ids; a local card that merged into an existing
 * server card is found through its word. States whose card has a local copy
 * but isn't on the server yet are kept for a later run; the rest are removed.
 */
async function migrateLegacySM2States(): Promise<void> {
  const legacy = getAllSM2States();
  if (Object.keys(legacy).length === 0) return;
  try {
    const rows = await apiFetch<RawCard[]>("/api/flashcards/cards");
    const localCards = await localFlashcardStorage.getFlashcards();
    const cards = rows === null ? localCards : rows.map(hydrateCard);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const byWord = new Map(cards.map((c) => [c.word_id, c]));
    const localWords = new Map(localCards.map((c) => [c.id, c.word_id]));
    const updated = new Map<string, UserFlashcard>();
    const pending: Record<string, SM2Card> = {};
    for (const [id, state] of Object.entries(legacy)) {
      const wordId = localWords.get(id);
      const card = byId.get(id) ?? (wordId !== undefined ? byWord.get(wordId) : undefined);
      if (!card) {
        if (wordId !== undefined) pending[id] = state;
        continue;
      }
      // A state already on the card is newer than the legacy one.
      if (!card.sm2_state && !updated.has(card.id)) updated.set(card.id, { ...card, sm2_state: state });
    }
    if (updated.size > 0) {
      if (rows === null) await localFlashcardStorage.saveFlashcards(cards.map((c) => updated.get(c.id) ?? c));
      else await saveFlashcards([...updated.values()]);
    }
    if (Object.keys(pending).length === 0) clearAllSM2States();
    else localStorage.setItem(SM2_STATES_KEY, JSON.stringify(pending));
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    console.error("Failed to move SM-2 states to card storage:", error);
  }
}

const DEVICE_PREFS_SYNCED_KEY = "qalamspace_scheduler_prefs_synced";

/**
 * Uploads an algorithm choice / FSRS parameters that an older version kept only
 * on this device, if the server has none yet. Done once per browser.
 */
async function migrateDeviceSchedulerPreferences(): Promise<void> {
  if (!localStorage.getItem(ALGORITHM_KEY) && !localStorage.getItem(FSRS_PARAMS_KEY)) return;
  if (localStorage.getItem(DEVICE_PREFS_SYNCED_KEY) === "true") return;
  try {
    const row = await apiFetch<Record<string, unknown> | null>("/api/flashcards/preferences");
    if (row === null) return;
    if (row.fsrs_params === null || typeof row.fsrs_params !== "object") await savePreferences(await getPreferences());
    localStorage.setItem(DEVICE_PREFS_SYNCED_KEY, "true");
  } catch (error) {
    // Often the only request that still carries the lapsed session's cookie
    // (the session route clears it), so it must not be swallowed (Phase 2 D1).
    if (error instanceof SessionExpiredError) throw error;
    console.error("Failed to upload device scheduler preferences:", error);
  }
}

export async function migrateFromLocalStorage(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  await migrateDeviceSchedulerPreferences();
  const uploaded = await uploadLocalData();
  // After the upload, so states of local cards can find the server card they became.
  await migrateLegacySM2States();
  return uploaded;
}

async function uploadLocalData(): Promise<boolean> {
  const STORAGE_KEYS = {
    FLASHCARDS: "qalamspace_flashcards",
    REVIEWS: "qalamspace_reviews",
    PREFERENCES: "qalamspace_preferences",
    MIGRATED: "qalamspace_migrated_to_supabase",
    CARDS_DONE: "qalamspace_migrated_cards",
    REVIEWS_DONE: "qalamspace_migrated_reviews",
  };

  if (localStorage.getItem(STORAGE_KEYS.MIGRATED) === "true") return false;

  // Only migrate if signed in — don't migrate anonymous demo data
  const testCall = await apiFetch<unknown>("/api/flashcards/cards");
  if (testCall === null) return false;

  try {
    const flashcardsJson = localStorage.getItem(STORAGE_KEYS.FLASHCARDS);
    const reviewsJson = localStorage.getItem(STORAGE_KEYS.REVIEWS);
    const prefsJson = localStorage.getItem(STORAGE_KEYS.PREFERENCES);

    if (!flashcardsJson && !reviewsJson && !prefsJson) {
      localStorage.setItem(STORAGE_KEYS.MIGRATED, "true");
      return false;
    }

    // Cards, reviews and preferences go up as separate steps, and a finished
    // step is never repeated (U3). The cards step merges the device's states
    // into the account's cards, so running it again after the user has
    // studied on the account would reset those cards to the device's old
    // states. That happened on every hub visit while a later step kept
    // failing, for example the preferences on a database without migration 011.
    if (localStorage.getItem(STORAGE_KEYS.CARDS_DONE) !== "true") {
      const { skippedCards } = await importData(
        JSON.stringify({ flashcards: flashcardsJson ? JSON.parse(flashcardsJson) : [], version: "1.0.0" })
      );
      // A card that can't be stored would be skipped on every retry, so the
      // migration completes, and those cards are kept on this device and
      // reported instead of being lost silently (A4 review #5).
      if (skippedCards.length > 0) {
        // Two uploads can run at once (two tabs, or React's development double
        // effect) and both skip the same card; keep each card once (verification D9).
        const kept = readUnsyncedFlashcards();
        const seen = new Set(kept.map((card) => JSON.stringify(card)));
        const added = skippedCards.filter((card) => !seen.has(JSON.stringify(card)));
        localStorage.setItem(UNSYNCED_FLASHCARDS_KEY, JSON.stringify([...kept, ...added]));
      }
      localStorage.setItem(STORAGE_KEYS.CARDS_DONE, "true");
    }
    // The server ignores review ids it already has, so this step is safe to
    // repeat; it is still done once.
    if (localStorage.getItem(STORAGE_KEYS.REVIEWS_DONE) !== "true") {
      await importData(JSON.stringify({ reviews: reviewsJson ? JSON.parse(reviewsJson) : [], version: "1.0.0" }));
      localStorage.setItem(STORAGE_KEYS.REVIEWS_DONE, "true");
    }
    if (prefsJson) {
      await importData(JSON.stringify({ preferences: JSON.parse(prefsJson), version: "1.0.0" }));
    }
    localStorage.setItem(STORAGE_KEYS.MIGRATED, "true");
    return true;
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    console.error("Failed to migrate from localStorage:", error);
    return false;
  }
}
