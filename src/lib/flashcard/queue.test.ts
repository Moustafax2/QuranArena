import assert from "node:assert/strict";
import type { ReviewLogEntry, UserFlashcard } from "@/lib/types/flashcard";
import { FSRSState, WordStatus } from "@/lib/types/flashcard";
import { arrangeNext, buildSessionQueue, countTodayActivity, getDayStart, getQueueKind, getTodaysQueues, isStudyCard } from "./queue";

function runCase(name: string, fn: () => void) {
  fn();
  console.log(`ok - ${name}`);
}

const MIN = 60 * 1000;

function card(id: string, state: FSRSState, due: Date, status: WordStatus = WordStatus.IN_BANK): UserFlashcard {
  return {
    id,
    word_id: `word-${id}`,
    status,
    created_at: new Date(2026, 0, 1),
    fsrs_state: {
      due,
      stability: 1,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: state === FSRSState.New ? 0 : 1,
      lapses: 0,
      state,
    },
  };
}

function review(cardId: string, stateBefore: FSRSState, timestamp: Date): ReviewLogEntry {
  return {
    id: `${cardId}-${timestamp.getTime()}`,
    card_id: cardId,
    word_id: `word-${cardId}`,
    rating: 3,
    timestamp,
    session_id: "s",
    state_before: stateBefore,
    state_after: FSRSState.Review,
  };
}

export function runQueueTests() {
  runCase("getDayStart rolls over at 4am like Anki", () => {
    assert.deepEqual(getDayStart(new Date(2026, 9, 27, 3, 59)), new Date(2026, 9, 26, 4));
    assert.deepEqual(getDayStart(new Date(2026, 9, 27, 4, 0)), new Date(2026, 9, 27, 4));
    assert.deepEqual(getDayStart(new Date(2026, 9, 27, 23, 0)), new Date(2026, 9, 27, 4));
  });

  runCase("daily new limit is shared across sessions in the same day", () => {
    const now = new Date(2026, 9, 27, 12);
    const reviews = [
      review("a", FSRSState.New, new Date(2026, 9, 27, 9)),
      review("a", FSRSState.Learning, new Date(2026, 9, 27, 9, 5)),
      review("b", FSRSState.New, new Date(2026, 9, 27, 10)),
      // Before today's 4am rollover: belongs to yesterday
      review("c", FSRSState.New, new Date(2026, 9, 27, 3)),
      review("d", FSRSState.Review, new Date(2026, 9, 27, 11)),
    ];
    const today = countTodayActivity(reviews, now);
    assert.deepEqual(today, { newStudied: 2, reviewsDone: 1 });

    const newCards = Array.from({ length: 10 }, (_, i) => card(`n${i}`, FSRSState.New, now));
    const queues = getTodaysQueues(newCards, "fsrs", { newLimit: 5, reviewLimit: 100 }, today, now);
    assert.equal(queues.newCards.length, 3);

    const exhausted = getTodaysQueues(newCards, "fsrs", { newLimit: 2, reviewLimit: 100 }, today, now);
    assert.equal(exhausted.newCards.length, 0);
  });

  runCase("review cards are due for the whole study day, learning cards by the minute", () => {
    const now = new Date(2026, 9, 27, 9);
    const cards = [
      card("laterToday", FSRSState.Review, new Date(2026, 9, 27, 21)),
      card("beforeRollover", FSRSState.Review, new Date(2026, 9, 28, 3)),
      card("tomorrow", FSRSState.Review, new Date(2026, 9, 28, 5)),
      card("learnSoon", FSRSState.Learning, new Date(now.getTime() + 10 * MIN)),
      card("learnLater", FSRSState.Relearning, new Date(now.getTime() + 60 * MIN)),
    ];
    const queues = getTodaysQueues(cards, "fsrs", { newLimit: 20, reviewLimit: 100 }, { newStudied: 0, reviewsDone: 0 }, now);
    assert.deepEqual(queues.reviews.map((c) => c.id), ["laterToday", "beforeRollover"]);
    assert.deepEqual(queues.learning.map((c) => c.id), ["learnSoon"]);
  });

  runCase("review limit caps reviews but not learning cards", () => {
    const now = new Date(2026, 9, 27, 9);
    const cards = [
      card("r1", FSRSState.Review, new Date(2026, 9, 25)),
      card("r2", FSRSState.Review, new Date(2026, 9, 26)),
      card("l1", FSRSState.Relearning, now),
    ];
    const queues = getTodaysQueues(cards, "fsrs", { newLimit: 20, reviewLimit: 3 }, { newStudied: 0, reviewsDone: 2 }, now);
    assert.deepEqual(queues.reviews.map((c) => c.id), ["r1"]);
    assert.equal(queues.learning.length, 1);
  });

  runCase("SM-2 lapsed cards stay reviews instead of becoming new cards", () => {
    const now = new Date(2026, 9, 27, 9);
    const lapsed: UserFlashcard = {
      ...card("x", FSRSState.New, now),
      sm2_state: { interval: 1, repetitions: 0, easiness: 2.1, due: new Date(2026, 9, 28, 9) },
    };
    const queues = getTodaysQueues([lapsed], "sm2", { newLimit: 20, reviewLimit: 100 }, { newStudied: 0, reviewsDone: 0 }, now);
    assert.equal(queues.newCards.length, 0);
    assert.equal(queues.reviews.length, 0);
  });

  runCase("arrangeNext prefers due learning cards, then the main queue, then learns ahead", () => {
    const now = new Date(2026, 9, 27, 9);
    const done = card("done", FSRSState.Review, now);
    const due = card("dueLearning", FSRSState.Learning, new Date(now.getTime() - MIN));
    const soon = card("soonLearning", FSRSState.Learning, new Date(now.getTime() + 5 * MIN));
    const main = card("main", FSRSState.New, now);

    assert.deepEqual(
      arrangeNext([done, main, soon, due], 1, "fsrs", now).map((c) => c.id),
      ["done", "dueLearning", "main", "soonLearning"]
    );
    assert.deepEqual(
      arrangeNext([done, soon, main], 1, "fsrs", now).map((c) => c.id),
      ["done", "main", "soonLearning"]
    );
    assert.deepEqual(
      arrangeNext([done, soon], 1, "fsrs", now).map((c) => c.id),
      ["done", "soonLearning"]
    );

    const far = card("farLearning", FSRSState.Learning, new Date(now.getTime() + 30 * MIN));
    assert.deepEqual(arrangeNext([done, far], 1, "fsrs", now).map((c) => c.id), ["done"]);
  });

  runCase("N2: Classic cards in learning steps are learning cards, due by the minute", () => {
    const now = new Date(2026, 9, 27, 9);
    const sm2 = (id: string, phase: "learning" | "relearning" | "review", due: Date): UserFlashcard => ({
      ...card(id, FSRSState.New, now),
      sm2_state: { phase, step: 0, interval: 1, repetitions: 0, easiness: 2.5, lapses: 0, due },
    });
    const cards = [
      sm2("learnSoon", "learning", new Date(now.getTime() + 5 * MIN)),
      sm2("relearnLater", "relearning", new Date(now.getTime() + 60 * MIN)),
      sm2("review", "review", new Date(2026, 9, 26)),
    ];
    assert.equal(getQueueKind(cards[0], "sm2"), "learning");
    assert.equal(getQueueKind(cards[1], "sm2"), "learning");
    const queues = getTodaysQueues(cards, "sm2", { newLimit: 20, reviewLimit: 0 }, { newStudied: 0, reviewsDone: 0 }, now);
    assert.deepEqual(queues.learning.map((c) => c.id), ["learnSoon"]);
    assert.equal(queues.reviews.length, 0);
  });

  runCase("N5: new cards count against the review limit unless the option is on", () => {
    const now = new Date(2026, 9, 27, 9);
    const reviews = Array.from({ length: 8 }, (_, i) => card(`r${i}`, FSRSState.Review, new Date(2026, 9, 20 + (i % 5))));
    const fresh = Array.from({ length: 10 }, (_, i) => card(`n${i}`, FSRSState.New, now));
    const cards = [...reviews, ...fresh];
    // Limit 10: 3 reviews and 2 new cards were already done today, leaving 5.
    const today = { newStudied: 2, reviewsDone: 3 };
    const counted = getTodaysQueues(cards, "fsrs", { newLimit: 20, reviewLimit: 10 }, today, now);
    assert.equal(counted.reviews.length, 5);
    assert.equal(counted.newCards.length, 0);

    const roomy = getTodaysQueues(cards, "fsrs", { newLimit: 20, reviewLimit: 20 }, today, now);
    assert.equal(roomy.reviews.length, 8);
    assert.equal(roomy.newCards.length, 7); // 20 - 3 - 2 - 8 reviews

    const ignoring = getTodaysQueues(cards, "fsrs", { newLimit: 5, reviewLimit: 10, newCardsIgnoreReviewLimit: true }, today, now);
    assert.equal(ignoring.reviews.length, 7);
    assert.equal(ignoring.newCards.length, 3);
  });

  runCase("N4: new cards are mixed in with reviews, so a backlog doesn't crowd them out", () => {
    const now = new Date(2026, 9, 27, 9);
    const queues = {
      learning: [card("l1", FSRSState.Learning, now)],
      reviews: Array.from({ length: 30 }, (_, i) => card(`r${i}`, FSRSState.Review, new Date(2026, 9, 1 + (i % 20)))),
      newCards: Array.from({ length: 10 }, (_, i) => card(`n${i}`, FSRSState.New, now)),
    };
    const session = buildSessionQueue(queues, 21);
    assert.equal(session[0].id, "l1");
    const newInSession = session.filter((c) => c.id.startsWith("n")).length;
    assert.ok(newInSession >= 4 && newInSession <= 6, `expected ~5 new cards, got ${newInSession}`);
    // Spread out: no two new cards next to each other here (3 reviews per new card).
    const kinds = session.slice(1).map((c) => c.id[0]).join("");
    assert.doesNotMatch(kinds, /nn/);
    // Every card appears once and reviews keep their due order.
    const all = buildSessionQueue(queues, 100);
    assert.equal(new Set(all.map((c) => c.id)).size, 41);
    assert.deepEqual(all.filter((c) => c.id.startsWith("r")).map((c) => c.id), queues.reviews.map((c) => c.id));
  });

  runCase("H4: KNOWN_NOT_IN_BANK cards never enter any queue", () => {
    const now = new Date(2026, 9, 27, 9);
    const known = WordStatus.KNOWN_NOT_IN_BANK;
    const cards = [
      card("knownNew", FSRSState.New, now, known),
      card("knownReview", FSRSState.Review, new Date(2026, 9, 26), known),
      card("knownLearning", FSRSState.Learning, now, known),
      card("learn", FSRSState.New, now),
    ];
    for (const algorithm of ["fsrs", "sm2"] as const) {
      const queues = getTodaysQueues(cards, algorithm, { newLimit: 20, reviewLimit: 100 }, { newStudied: 0, reviewsDone: 0 }, now);
      const ids = [...queues.learning, ...queues.reviews, ...queues.newCards].map((c) => c.id);
      assert.deepEqual(ids, ["learn"], algorithm);
    }
    assert.deepEqual(cards.filter(isStudyCard).map((c) => c.id), ["learn"]);
  });
}
