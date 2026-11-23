"use client";

import type {
  MemorizationAttempt,
  MemorizationAttemptInput,
} from "@/lib/memorization/types";
import { getCurrentPlayerId } from "@/lib/current-player";

export type RatingLevel = 0 | 1 | 2;

export interface RatingEntry {
  timestamp: number;
  level: RatingLevel;
  pageNumber?: number;
  juzNumber?: number;
  clientAttemptId?: string;
}

export interface VerseRecord {
  verseKey: string;
  surahId: number;
  ratings: RatingEntry[];
}

const LEGACY_RECORDS_KEY = "qalamspace_memorization_ratings";
const ATTEMPTS_KEY = "qalamspace_memorization_attempts";
const MIGRATION_KEY_PREFIX = "qalamspace_memorization_synced_v1";
// Attempts the server failed to save (audit M7). Each load retries them, and
// reads include them until they are flushed. Each one carries the player that
// was signed in when it was made (an account or a guest), so it is only ever
// uploaded to, or shown to, that player. The key is learning data: the guest
// expiry, the privacy export and withdraw/delete cover it.
const OUTBOX_KEY = "qalamspace_memorization_outbox";

type OutboxEntry = {
  owner: string;
  attempt: ReturnType<typeof serializeAttempt>;
  /** Date.now() when queued; the age cap counts from here. */
  queued_at?: number;
  /** Server failures counted against this entry (see flushOutbox). */
  tries?: number;
};

// Poison-entry caps (audit M7). An entry older than this, or one the
// server failed this many times while it saved others, is dropped.
const OUTBOX_MAX_AGE_MS = 30 * 86_400_000;
const OUTBOX_MAX_TRIES = 5;
// After a failed batch, at most this many entries are sent one by one per load.
const OUTBOX_MAX_SINGLE_SENDS = 25;

type LegacyRecords = Record<string, VerseRecord>;

type SyncAttemptsResponse = {
  player_id: string;
  attempts: Array<{
    id: string;
    client_attempt_id: string;
    mode: "ayah" | "page-blank";
    rating_level: number;
    verse_key: string | null;
    surah_id: number | null;
    ayah_number: number | null;
    juz_number: number | null;
    page_number: number | null;
    selection_type: "juz" | "surah" | null;
    cover_region: "top" | "middle" | "bottom" | null;
    tested_at: string;
  }>;
};

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function normalizeAttempt(input: MemorizationAttemptInput): MemorizationAttempt {
  const testedAt = input.tested_at ?? new Date();
  const verseKey = input.verse_key ?? null;

  return {
    id: input.client_attempt_id ?? buildClientAttemptId({ ...input, tested_at: testedAt }),
    client_attempt_id:
      input.client_attempt_id ?? buildClientAttemptId({ ...input, tested_at: testedAt }),
    mode: input.mode,
    rating_level: input.rating_level,
    verse_key: verseKey,
    surah_id: input.surah_id ?? null,
    ayah_number:
      input.ayah_number ??
      (verseKey?.includes(":") ? Number(verseKey.split(":")[1]) || null : null),
    juz_number: input.juz_number ?? null,
    page_number: input.page_number ?? null,
    selection_type: input.selection_type ?? null,
    cover_region: input.cover_region ?? null,
    tested_at: testedAt,
  };
}

function hydrateAttempt(row: SyncAttemptsResponse["attempts"][number]): MemorizationAttempt {
  return {
    id: row.id,
    client_attempt_id: row.client_attempt_id,
    mode: row.mode,
    rating_level: row.rating_level as RatingLevel,
    verse_key: row.verse_key,
    surah_id: row.surah_id,
    ayah_number: row.ayah_number,
    juz_number: row.juz_number,
    page_number: row.page_number,
    selection_type: row.selection_type,
    cover_region: row.cover_region,
    tested_at: new Date(row.tested_at),
  };
}

function serializeAttempt(attempt: MemorizationAttempt) {
  return {
    client_attempt_id: attempt.client_attempt_id,
    mode: attempt.mode,
    rating_level: attempt.rating_level,
    verse_key: attempt.verse_key,
    surah_id: attempt.surah_id,
    ayah_number: attempt.ayah_number,
    juz_number: attempt.juz_number,
    page_number: attempt.page_number,
    selection_type: attempt.selection_type,
    cover_region: attempt.cover_region,
    tested_at: attempt.tested_at.toISOString(),
  };
}

function buildClientAttemptId(input: MemorizationAttemptInput): string {
  const testedAt = (input.tested_at ?? new Date()).toISOString();
  const verseKey = input.verse_key ?? "none";
  const pageNumber = input.page_number ?? "none";
  const coverRegion = input.cover_region ?? "none";
  return [
    input.mode,
    verseKey,
    pageNumber,
    input.rating_level,
    testedAt,
    coverRegion,
  ].join("|");
}

function loadLegacyRecords(): LegacyRecords {
  if (!isBrowser()) return {};
  try {
    const raw = localStorage.getItem(LEGACY_RECORDS_KEY);
    return raw ? (JSON.parse(raw) as LegacyRecords) : {};
  } catch {
    return {};
  }
}

function saveLegacyRecords(records: LegacyRecords): void {
  if (!isBrowser()) return;
  localStorage.setItem(LEGACY_RECORDS_KEY, JSON.stringify(records));
}

function loadStoredAttempts(): MemorizationAttempt[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(ATTEMPTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{
      client_attempt_id: string;
      mode: "ayah" | "page-blank";
      rating_level: RatingLevel;
      verse_key: string | null;
      surah_id: number | null;
      ayah_number: number | null;
      juz_number: number | null;
      page_number: number | null;
      selection_type: "juz" | "surah" | null;
      cover_region: "top" | "middle" | "bottom" | null;
      tested_at: string;
    }>;

    return parsed.map((attempt) =>
      normalizeAttempt({
        ...attempt,
        tested_at: new Date(attempt.tested_at),
      })
    );
  } catch {
    return [];
  }
}

function legacyRecordsToAttempts(records: LegacyRecords): MemorizationAttempt[] {
  return Object.values(records).flatMap((record) =>
    record.ratings.map((rating) =>
      normalizeAttempt({
        client_attempt_id:
          rating.clientAttemptId ??
          buildClientAttemptId({
            mode: "ayah",
            verse_key: record.verseKey,
            surah_id: record.surahId,
            rating_level: rating.level,
            page_number: rating.pageNumber,
            juz_number: rating.juzNumber,
            tested_at: new Date(rating.timestamp),
          }),
        mode: "ayah",
        verse_key: record.verseKey,
        surah_id: record.surahId,
        rating_level: rating.level,
        page_number: rating.pageNumber,
        juz_number: rating.juzNumber,
        tested_at: new Date(rating.timestamp),
      })
    )
  );
}

function dedupeAttempts(attempts: MemorizationAttempt[]): MemorizationAttempt[] {
  const seen = new Map<string, MemorizationAttempt>();
  for (const attempt of attempts) {
    seen.set(attempt.client_attempt_id, attempt);
  }

  return Array.from(seen.values()).sort(
    (a, b) => a.tested_at.getTime() - b.tested_at.getTime()
  );
}

function saveLocalAttempts(attempts: MemorizationAttempt[]): void {
  if (!isBrowser()) return;

  localStorage.setItem(
    ATTEMPTS_KEY,
    JSON.stringify(
      attempts.map((attempt) => ({
        ...serializeAttempt(attempt),
      }))
    )
  );

  const records: LegacyRecords = {};
  for (const attempt of attempts) {
    if (attempt.mode !== "ayah" || !attempt.verse_key || attempt.surah_id == null) continue;
    if (!records[attempt.verse_key]) {
      records[attempt.verse_key] = {
        verseKey: attempt.verse_key,
        surahId: attempt.surah_id,
        ratings: [],
      };
    }

    records[attempt.verse_key].ratings.push({
      timestamp: attempt.tested_at.getTime(),
      level: attempt.rating_level,
      pageNumber: attempt.page_number ?? undefined,
      juzNumber: attempt.juz_number ?? undefined,
      clientAttemptId: attempt.client_attempt_id,
    });
  }

  saveLegacyRecords(records);
}

function readJsonArray(key: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isOwnedEntry(entry: unknown): entry is OutboxEntry {
  const candidate = entry as Partial<OutboxEntry> | null;
  return typeof candidate?.owner === "string" && candidate.owner !== "" &&
    typeof candidate.attempt === "object" && candidate.attempt !== null;
}

function loadOutbox(): OutboxEntry[] {
  if (!isBrowser()) return [];
  const entries = readJsonArray(OUTBOX_KEY);
  const owned = entries.filter(isOwnedEntry);
  // An entry without an owner is not one this code wrote. Nobody can tell
  // whose it is, so it is dropped rather than guessed.
  if (owned.length !== entries.length) saveOutbox(owned);
  return owned;
}

function saveOutbox(entries: OutboxEntry[]): void {
  if (!isBrowser()) return;
  if (entries.length === 0) localStorage.removeItem(OUTBOX_KEY);
  else localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
}

/** When an entry was queued; an entry without that time uses the attempt's. */
function queuedAt(entry: OutboxEntry): number {
  return typeof entry.queued_at === "number" ? entry.queued_at : Date.parse(entry.attempt.tested_at);
}

/**
 * An entry worth sending: the shape the server stores (the same rules as the
 * attempt the app builds), and not past the age cap.
 */
function isSendable(entry: OutboxEntry, now: number): boolean {
  const attempt = entry.attempt as Partial<OutboxEntry["attempt"]>;
  return typeof attempt.client_attempt_id === "string" && attempt.client_attempt_id.length > 0 &&
    (attempt.mode === "ayah" || attempt.mode === "page-blank") &&
    Number.isInteger(attempt.rating_level) && (attempt.rating_level as number) >= 0 && (attempt.rating_level as number) <= 2 &&
    typeof attempt.tested_at === "string" && !Number.isNaN(Date.parse(attempt.tested_at)) &&
    now - queuedAt(entry) <= OUTBOX_MAX_AGE_MS;
}

/** Pending attempts that belong to `playerId`. */
function pendingAttempts(playerId: string | null): MemorizationAttempt[] {
  if (playerId === null) return [];
  const now = Date.now();
  return loadOutbox()
    .filter((entry) => entry.owner === playerId && isSendable(entry, now))
    .map((entry) => normalizeAttempt({ ...entry.attempt, tested_at: new Date(entry.attempt.tested_at) }));
}

/**
 * Uploads this player's pending attempts and returns the ids that left the
 * outbox without being saved. The server upserts on (player_id,
 * client_attempt_id), so a retry after a lost reply never duplicates one.
 *
 * One bad entry must not hold back the rest: malformed and
 * expired entries are dropped unsent; when the batch fails, each entry is
 * sent on its own. An entry the server refuses for good (a 4xx) is dropped.
 * One that keeps failing with a 5xx/408/429 is dropped after
 * OUTBOX_MAX_TRIES, but a failure counts only when another entry got through
 * in the same flush, so an outage never uses up the tries.
 */
async function flushOutbox(playerId: string): Promise<Set<string>> {
  const now = Date.now();
  const mine = loadOutbox().filter((entry) => entry.owner === playerId);
  const saved = new Set<string>();
  const dropped = new Set<string>();
  const failed = new Set<string>();
  const live = mine.filter((entry) => {
    if (isSendable(entry, now)) return true;
    dropped.add(entry.attempt.client_attempt_id);
    return false;
  });

  if (live.length > 0) {
    const batch = await sendAttempts("PUT", live.map((entry) => entry.attempt));
    if (batch.kind === "saved") {
      for (const entry of live) saved.add(entry.attempt.client_attempt_id);
    } else if (batch.kind !== "offline" && batch.kind !== "unauthenticated") {
      // The server answered with an error: find which entries it refuses.
      for (const entry of live.slice(0, OUTBOX_MAX_SINGLE_SENDS)) {
        const id = entry.attempt.client_attempt_id;
        const one = live.length === 1 ? batch : await sendAttempts("PUT", [entry.attempt]);
        if (one.kind === "saved") saved.add(id);
        else if (one.kind === "rejected") dropped.add(id);
        else if (one.kind === "retry") failed.add(id);
        else break;
      }
    }
  }

  const healthy = saved.size > 0;
  saveOutbox(loadOutbox().flatMap((entry) => {
    const id = entry.attempt.client_attempt_id;
    if (entry.owner !== playerId) return [entry];
    if (saved.has(id) || dropped.has(id)) return [];
    if (!healthy || !failed.has(id)) return [entry];
    const tries = (entry.tries ?? 0) + 1;
    if (tries >= OUTBOX_MAX_TRIES) {
      dropped.add(id);
      return [];
    }
    return [{ ...entry, tries }];
  }));
  if (dropped.size > 0) console.warn(`Dropped ${dropped.size} memorization attempt(s) the server would not save.`);
  return dropped;
}

type SendOutcome =
  | { kind: "saved" }
  | { kind: "unauthenticated" }
  // No answer from the server (offline, or the request never arrived).
  | { kind: "offline" }
  // The server answered with an error that may pass: 5xx, 408 or 429.
  | { kind: "retry"; status: number }
  // The server refused it for good (any other 4xx).
  | { kind: "rejected"; status: number; message: string };

/** Errors worth retrying later. Any other failure is permanent (audit M7). */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

async function sendAttempts(method: "POST" | "PUT", body: unknown): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/memorization/attempts", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "offline" };
  }
  if (response.ok) return { kind: "saved" };
  if (response.status === 401) return { kind: "unauthenticated" };
  if (isRetryableStatus(response.status)) return { kind: "retry", status: response.status };
  const text = await response.text().catch(() => "");
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string") message = parsed.error;
  } catch {
    // Not JSON: the text is the message.
  }
  return { kind: "rejected", status: response.status, message: message || "The server refused this attempt." };
}

/** Attempts kept only on this device (no account or guest session at the time). */
function readDeviceAttempts(): MemorizationAttempt[] {
  const storedAttempts = loadStoredAttempts();
  const legacyAttempts = legacyRecordsToAttempts(loadLegacyRecords());
  return dedupeAttempts([...storedAttempts, ...legacyAttempts]);
}

/** What to show when the server can't be read: device attempts plus pending ones. */
function readLocalAttempts(): MemorizationAttempt[] {
  return dedupeAttempts([...readDeviceAttempts(), ...pendingAttempts(getCurrentPlayerId())]);
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T | null> {
  const response = await fetch(url, options);
  if (response.status === 401) return null;
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(text || "Memorization request failed.");
  }
  return response.json() as Promise<T>;
}

async function maybeMigrateLocalAttempts(playerId: string): Promise<boolean> {
  if (!isBrowser()) return false;

  const migrationKey = `${MIGRATION_KEY_PREFIX}:${playerId}`;
  if (localStorage.getItem(migrationKey) === "true") return false;

  const attempts = readDeviceAttempts();
  if (attempts.length === 0) {
    localStorage.setItem(migrationKey, "true");
    return false;
  }

  const result = await apiFetch<{ ok: boolean }>("/api/memorization/attempts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attempts.map(serializeAttempt)),
  });

  if (result === null) return false;
  localStorage.setItem(migrationKey, "true");
  return true;
}

async function getSyncedAttempts(): Promise<MemorizationAttempt[] | null> {
  const payload = await apiFetch<SyncAttemptsResponse>("/api/memorization/attempts");
  if (payload === null) return null;

  // Read before the flush: whatever it sends is not in `payload` yet.
  // Entries the flush dropped unsaved are left out.
  const queued = pendingAttempts(payload.player_id);
  const dropped = await flushOutbox(payload.player_id).catch(() => new Set<string>());
  const pending = queued.filter((attempt) => !dropped.has(attempt.client_attempt_id));

  const migrated = await maybeMigrateLocalAttempts(payload.player_id).catch(() => false);
  let rows = payload.attempts;
  if (migrated) {
    const refreshed = await apiFetch<SyncAttemptsResponse>("/api/memorization/attempts");
    if (refreshed !== null) rows = refreshed.attempts;
  }
  // Server rows come last, so they win over a pending copy of the same attempt.
  return dedupeAttempts([...pending, ...rows.map(hydrateAttempt)]);
}

function buildRecordsFromAttempts(attempts: MemorizationAttempt[]): Record<string, VerseRecord> {
  const records: Record<string, VerseRecord> = {};

  for (const attempt of attempts) {
    if (attempt.mode !== "ayah" || !attempt.verse_key || attempt.surah_id == null) continue;

    if (!records[attempt.verse_key]) {
      records[attempt.verse_key] = {
        verseKey: attempt.verse_key,
        surahId: attempt.surah_id,
        ratings: [],
      };
    }

    records[attempt.verse_key].ratings.push({
      timestamp: attempt.tested_at.getTime(),
      level: attempt.rating_level,
      pageNumber: attempt.page_number ?? undefined,
      juzNumber: attempt.juz_number ?? undefined,
      clientAttemptId: attempt.client_attempt_id,
    });
  }

  return records;
}

export async function saveMemorizationAttempt(
  input: MemorizationAttemptInput
): Promise<MemorizationAttempt> {
  const attempt = normalizeAttempt(input);
  const outcome = await sendAttempts("POST", serializeAttempt(attempt));
  if (outcome.kind === "saved") return attempt;

  if (outcome.kind === "rejected") {
    // A permanent refusal (a 400, or a 403 when consent is missing) would fail
    // on every retry, so it is reported now and not queued.
    throw new Error(`Your rating could not be saved: ${outcome.message}`);
  }

  if (outcome.kind !== "unauthenticated") {
    // The network failed, or the server failed in a way that may pass: keep it
    // in the outbox, which the next load uploads. Before, it went to the local
    // attempts, which are uploaded only once per player, and was then hidden
    // (audit M7). It belongs to the player signed in now; with
    // none known it can't be kept.
    const owner = getCurrentPlayerId();
    if (owner === null) {
      throw new Error("Your rating could not be saved. Check your connection and try again.");
    }
    saveOutbox([
      ...loadOutbox().filter((entry) => entry.attempt.client_attempt_id !== attempt.client_attempt_id),
      { owner, attempt: serializeAttempt(attempt), queued_at: Date.now(), tries: 0 },
    ]);
    return attempt;
  }

  // 401: no account or guest session, so the attempt stays on this device.
  const attempts = dedupeAttempts([...readDeviceAttempts(), attempt]);
  saveLocalAttempts(attempts);
  return attempt;
}

export async function addRating(
  verseKey: string,
  surahId: number,
  level: RatingLevel,
  extra?: { pageNumber?: number; juzNumber?: number }
): Promise<void> {
  await saveMemorizationAttempt({
    mode: "ayah",
    verse_key: verseKey,
    surah_id: surahId,
    rating_level: level,
    page_number: extra?.pageNumber ?? null,
    juz_number: extra?.juzNumber ?? null,
  });
}

export async function getMemorizationAttempts(): Promise<MemorizationAttempt[]> {
  const syncedAttempts = await getSyncedAttempts().catch(() => null);
  if (syncedAttempts !== null) return syncedAttempts;
  return readLocalAttempts();
}

export async function getAllRecords(): Promise<Record<string, VerseRecord>> {
  return buildRecordsFromAttempts(await getMemorizationAttempts());
}

export async function getSurahScores(): Promise<Record<number, number>> {
  const records = await getAllRecords();
  const surahTotals: Record<number, { sum: number; count: number }> = {};

  for (const record of Object.values(records)) {
    if (record.ratings.length === 0) continue;
    const latestRating = record.ratings[record.ratings.length - 1];
    const surahId = record.surahId;
    if (!surahTotals[surahId]) surahTotals[surahId] = { sum: 0, count: 0 };
    surahTotals[surahId].sum += latestRating.level;
    surahTotals[surahId].count += 1;
  }

  const scores: Record<number, number> = {};
  for (const [surahId, { sum, count }] of Object.entries(surahTotals)) {
    scores[Number(surahId)] = sum / count;
  }

  return scores;
}

export async function clearAllRecords(): Promise<void> {
  try {
    await apiFetch<{ ok: boolean }>("/api/memorization/attempts", {
      method: "DELETE",
    });
  } catch {
    // Ignore sync clear failures and still clear local state.
  }

  if (!isBrowser()) return;
  localStorage.removeItem(LEGACY_RECORDS_KEY);
  localStorage.removeItem(ATTEMPTS_KEY);
  localStorage.removeItem(OUTBOX_KEY);
}
