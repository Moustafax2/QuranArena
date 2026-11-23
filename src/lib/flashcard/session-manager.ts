import type {
  LexicalEntry,
  SM2Card,
  FlashcardSession,
  UserFlashcard,
  ReviewLogEntry,
  Rating,
  SessionStats,
  UserPreferences,
} from "@/lib/types/flashcard";
import { FSRSState } from "@/lib/types/flashcard";
import {
  getFlashcards,
  updateFlashcard,
  saveReviewLog,
  deleteReviewLogEntry,
  getReviewLog,
  getPreferences,
  getFSRSParameters,
  saveSM2State,
  deleteSM2State,
} from "@/lib/storage/flashcard-storage-supabase";
import { scheduleCard } from "@/lib/flashcard/intervals";
import {
  arrangeNext,
  buildSessionQueue,
  countTodayActivity,
  getDayStart,
  getQueueKind,
  getTodaysQueues,
  isStudyCard,
  type Algorithm,
  type TodaysQueues,
} from "@/lib/flashcard/queue";
import { calculateStreak } from "@/lib/flashcard/stats";

/** The review-log state for a Classic card (no state = never studied). */
function sm2LogState(state: SM2Card | null | undefined): FSRSState {
  if (!state) return FSRSState.New;
  switch (state.phase) {
    case "learning": return FSRSState.Learning;
    case "relearning": return FSRSState.Relearning;
    default: return FSRSState.Review;
  }
}

async function loadTodaysQueues(): Promise<{
  queues: TodaysQueues;
  prefs: UserPreferences;
  algorithm: Algorithm;
}> {
  const now = new Date();
  const [cards, prefs, todaysReviews] = await Promise.all([
    getFlashcards(),
    getPreferences(),
    getReviewLog({ start_date: getDayStart(now) }),
  ]);
  return queuesFrom(cards, prefs, todaysReviews, now);
}

/**
 * Everything the flashcards hub shows, from one load of the cards, the
 * preferences and the review log (audit L18: the hub used to load the cards
 * 3 times, the preferences twice and the review log 3 times). The counts use
 * the same queue rules as a session.
 */
export async function getHubSummary(now = new Date()): Promise<{
  due: number;
  newCards: number;
  totalCards: number;
  streak: number;
}> {
  const { due, newCards, totalCards, streak } = await getFlashcardOverview(now);
  return { due, newCards, totalCards, streak };
}

/**
 * The hub's study tile: what a session started now will hold, new cards
 * included (U1). It used to show only the due count, so right after adding
 * words it read "0 cards due" for a session of 20 new cards. As in Anki's deck
 * list, the new and due counts are also given apart.
 */
export function describeStudyLoad({ due, newCards }: { due: number; newCards: number }): {
  headline: string;
  detail: string;
} {
  const total = due + newCards;
  return {
    headline: total === 0 ? "Nothing to study now" : `${total} ${total === 1 ? "card" : "cards"} to study`,
    detail: `${newCards} new · ${due} due`,
  };
}

/**
 * The deck, the full review log and today's counts, from one load of the
 * cards, the preferences and the review log. Shared by the flashcards hub and
 * the progress page, which used to load the cards 3 times, the preferences
 * twice and the review log 3 times (audit L18, A4 review #7).
 */
export async function getFlashcardOverview(now = new Date()): Promise<{
  cards: UserFlashcard[];
  reviews: ReviewLogEntry[];
  due: number;
  newCards: number;
  totalCards: number;
  streak: number;
  algorithm: Algorithm;
}> {
  const [cards, prefs, reviews] = await Promise.all([getFlashcards(), getPreferences(), getReviewLog()]);
  // The same cut the review route applies for start_date (timestamp >= start).
  const dayStart = getDayStart(now);
  const todaysReviews = reviews.filter((review) => review.timestamp >= dayStart);
  const { queues } = queuesFrom(cards, prefs, todaysReviews, now);
  return {
    cards,
    reviews,
    due: queues.learning.length + queues.reviews.length,
    newCards: queues.newCards.length,
    totalCards: cards.filter(isStudyCard).length,
    streak: calculateStreak(reviews),
    algorithm: prefs.algorithm ?? "fsrs",
  };
}

function queuesFrom(
  cards: UserFlashcard[],
  prefs: UserPreferences,
  todaysReviews: ReviewLogEntry[],
  now: Date
): { queues: TodaysQueues; prefs: UserPreferences; algorithm: Algorithm } {
  const algorithm = prefs.algorithm ?? "fsrs";

  // Cards carry their SM-2 state (sm2_state) from card storage.
  const queues = getTodaysQueues(
    cards,
    algorithm,
    {
      newLimit: prefs.daily_new_cards_limit,
      reviewLimit: prefs.daily_review_cards_limit,
      newCardsIgnoreReviewLimit: prefs.new_cards_ignore_review_limit,
    },
    countTodayActivity(todaysReviews, now),
    now
  );
  return { queues, prefs, algorithm };
}

export async function createReviewSession(): Promise<FlashcardSession | null> {
  const { queues, prefs, algorithm } = await loadTodaysQueues();

  const sessionCards = buildSessionQueue(queues, prefs.session_size || 20);
  const queue = arrangeNext(sessionCards, 0, algorithm);
  if (queue.length === 0) return null;

  const session: FlashcardSession = {
    id: crypto.randomUUID(),
    cards: queue,
    current_index: 0,
    start_time: new Date(),
    algorithm,
    stats: {
      total_cards: queue.length,
      cards_reviewed: 0,
      new_cards: queue.filter((c) => getQueueKind(c, algorithm) === "new").length,
      review_cards: queue.filter((c) => getQueueKind(c, algorithm) !== "new").length,
      again_count: 0,
      hard_count: 0,
      good_count: 0,
      easy_count: 0,
      total_time_ms: 0,
    },
  };

  return session;
}

export async function undoReview(
  prevCard: UserFlashcard,
  logId: string,
  algorithm: Algorithm
): Promise<void> {
  if (algorithm === "sm2") {
    if (prevCard.sm2_state) await saveSM2State(prevCard.id, prevCard.sm2_state);
    else await deleteSM2State(prevCard.id);
    await deleteReviewLogEntry(logId);
    return;
  }
  await Promise.all([
    updateFlashcard(prevCard.id, { fsrs_state: prevCard.fsrs_state }),
    deleteReviewLogEntry(logId),
  ]);
}

/**
 * Answers the current card. Pass the same `logId` when retrying a failed
 * save: the schedule is recomputed from the unchanged session card and the
 * server ignores a review id it already has, so a retry never applies an
 * answer twice.
 */
export async function reviewCard(
  session: FlashcardSession,
  cardId: string,
  rating: Rating,
  reviewDurationMs: number = 0,
  logId: string = crypto.randomUUID()
): Promise<{ updatedSession: FlashcardSession; logId: string }> {
  // The same card can appear earlier in the queue as an already-answered
  // learning step, so look it up by position rather than by id.
  const card = session.cards[session.current_index];
  if (!card || card.id !== cardId) throw new Error("Card not found in session");

  const algorithm = session.algorithm ?? "fsrs";

  // ── Schedule with the active algorithm ──────────────────────
  let updatedCard: UserFlashcard;
  let stateBefore: FSRSState;
  let stateAfter: FSRSState;

  // Same code path as the button previews (N3), so the shown interval is the
  // one scheduled.
  const scheduled = scheduleCard(card, rating, algorithm, getFSRSParameters(), new Date());

  if (algorithm === "sm2") {
    const newSM2State = scheduled.sm2_state!;
    await saveSM2State(card.id, newSM2State);
    updatedCard = scheduled;
    // FSRS state is left unchanged in SM-2 mode, so log SM-2's own states;
    // the daily new/review limits are counted from these entries.
    stateBefore = sm2LogState(card.sm2_state);
    stateAfter = sm2LogState(newSM2State);
  } else {
    const newFSRSState = scheduled.fsrs_state;
    await updateFlashcard(cardId, { fsrs_state: newFSRSState });
    updatedCard = scheduled;
    stateBefore = card.fsrs_state.state;
    stateAfter = newFSRSState.state;
  }

  const reviewLog: ReviewLogEntry = {
    id: logId,
    card_id: cardId,
    word_id: card.word_id,
    rating,
    timestamp: new Date(),
    session_id: session.id,
    review_duration_ms: reviewDurationMs,
    state_before: stateBefore,
    state_after: stateAfter,
  };
  await saveReviewLog(reviewLog);

  // ── Update stats ──────────────────────────────────────────────
  const updatedStats = { ...session.stats };
  updatedStats.cards_reviewed += 1;
  updatedStats.total_time_ms += reviewDurationMs;
  switch (rating) {
    case 1: updatedStats.again_count += 1; break;
    case 2: updatedStats.hard_count  += 1; break;
    case 3: updatedStats.good_count  += 1; break;
    case 4: updatedStats.easy_count  += 1; break;
  }

  // ── Requeue cards that still need another look today ──────────
  const updatedCards = [...session.cards];
  updatedCards[session.current_index] = updatedCard;

  if (getQueueKind(updatedCard, algorithm) === "learning") {
    // Learning/relearning step (both algorithms): arrangeNext shows it again
    // once it is due.
    updatedCards.push(updatedCard);
  }

  const nextIndex = session.current_index + 1;
  const updatedSession: FlashcardSession = {
    ...session,
    cards: arrangeNext(updatedCards, nextIndex, algorithm),
    current_index: nextIndex,
    stats: updatedStats,
  };

  return { updatedSession, logId: reviewLog.id };
}

/** Identifies a card at its position in the session queue. */
export function sessionCardKey(session: FlashcardSession): string | null {
  const card = getCurrentCard(session);
  return card ? `${card.id}@${session.current_index}` : null;
}

/** The loaded word, only if it was loaded for the card now being shown. */
export function wordForCard(
  loaded: { key: string; word: LexicalEntry | null } | null,
  key: string | null
): LexicalEntry | null {
  return loaded && key && loaded.key === key ? loaded.word : null;
}

/** Removes the current card from the session (e.g. after deleting it). */
export function removeCurrentCard(session: FlashcardSession): FlashcardSession {
  const cards = session.cards.filter((_, i) => i !== session.current_index);
  return {
    ...session,
    cards: arrangeNext(cards, session.current_index, session.algorithm ?? "fsrs"),
    stats: { ...session.stats, total_cards: Math.max(0, session.stats.total_cards - 1) },
  };
}

export function isSessionComplete(session: FlashcardSession): boolean {
  return session.current_index >= session.cards.length;
}

export function getCurrentCard(session: FlashcardSession): UserFlashcard | null {
  if (isSessionComplete(session)) return null;
  return session.cards[session.current_index];
}

/**
 * Where a session stands, counted in cards (U2). The queue also holds the
 * answers already given and every learning step a card comes back for, so its
 * length grew while studying (a session of 20 new cards ended as "40 cards").
 * `total` is the session's cards, `done` the ones it no longer shows, and
 * `remaining` splits the rest into new, learning and review cards, like the
 * three counts Anki shows during study.
 */
export function getSessionProgress(session: FlashcardSession): {
  total: number;
  done: number;
  remaining: { new: number; learning: number; review: number };
  percentage: number;
} {
  const algorithm = session.algorithm ?? "fsrs";
  const all = new Set(session.cards.map((card) => card.id));
  // The latest entry of each card still to come says which queue it is in.
  const pending = new Map<string, UserFlashcard>();
  for (const card of session.cards.slice(session.current_index)) pending.set(card.id, card);
  const remaining = { new: 0, learning: 0, review: 0 };
  for (const card of pending.values()) remaining[getQueueKind(card, algorithm)]++;
  const total = all.size;
  const done = total - pending.size;
  return { total, done, remaining, percentage: total === 0 ? 100 : (done / total) * 100 };
}

/**
 * The share of answers that were passes. As on the stats page (stats.ts,
 * isPassRating), Hard is a pass and only Forgot is a miss (verification N3).
 */
export function calculateAccuracy(stats: SessionStats): number {
  const total = stats.cards_reviewed;
  if (total === 0) return 0;
  return ((stats.hard_count + stats.good_count + stats.easy_count) / total) * 100;
}

export function getAverageReviewTime(stats: SessionStats): number {
  if (stats.cards_reviewed === 0) return 0;
  return stats.total_time_ms / stats.cards_reviewed;
}

export async function getSessionSummary(session: FlashcardSession): Promise<{
  cardsReviewed: number;
  accuracy: number;
  totalTime: number;
  averageTime: number;
  newCards: number;
  reviewCards: number;
  ratings: { again: number; hard: number; good: number; easy: number };
}> {
  return {
    cardsReviewed: session.stats.cards_reviewed,
    accuracy: calculateAccuracy(session.stats),
    totalTime: session.stats.total_time_ms,
    averageTime: getAverageReviewTime(session.stats),
    newCards: session.stats.new_cards,
    reviewCards: session.stats.review_cards,
    ratings: {
      again: session.stats.again_count,
      hard: session.stats.hard_count,
      good: session.stats.good_count,
      easy: session.stats.easy_count,
    },
  };
}

/** Learning and review cards due today, within the daily review limit. */
export async function getDueCardsCount(): Promise<number> {
  const { queues } = await loadTodaysQueues();
  return queues.learning.length + queues.reviews.length;
}

/** New cards still available today, within the daily new-card limit. */
export async function getNewCardsCount(): Promise<number> {
  const { queues } = await loadTodaysQueues();
  return queues.newCards.length;
}
