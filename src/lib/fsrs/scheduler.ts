import { FSRS, GenSeedStrategyWithCardId, Rating as FSRSRating, StrategyMode, Card, State } from "ts-fsrs";
import type { FSRSCard, UserFlashcard, Rating, FSRSParameters } from "@/lib/types/flashcard";
import { FSRSState } from "@/lib/types/flashcard";

const fsrs = new FSRS({
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: true,
  w: [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722,
    0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
    0.0912, 0.0658, 0.1542,
  ],
});

function mapRatingToGrade(rating: Rating): FSRSRating {
  switch (rating) {
    case 1: return FSRSRating.Again;
    case 2: return FSRSRating.Hard;
    case 3: return FSRSRating.Good;
    case 4: return FSRSRating.Easy;
    default: return FSRSRating.Good;
  }
}

function mapStateToFSRSState(state: State): FSRSState {
  switch (state) {
    case State.New:        return FSRSState.New;
    case State.Learning:   return FSRSState.Learning;
    case State.Review:     return FSRSState.Review;
    case State.Relearning: return FSRSState.Relearning;
    default:               return FSRSState.New;
  }
}

function mapFSRSStateToState(state: FSRSState): State {
  switch (state) {
    case FSRSState.New:        return State.New;
    case FSRSState.Learning:   return State.Learning;
    case FSRSState.Review:     return State.Review;
    case FSRSState.Relearning: return State.Relearning;
    default:                   return State.New;
  }
}

function fsrsCardToCard(fsrsCard: FSRSCard): Card {
  return {
    due: new Date(fsrsCard.due),
    stability: fsrsCard.stability,
    difficulty: fsrsCard.difficulty,
    elapsed_days: fsrsCard.elapsed_days,
    scheduled_days: fsrsCard.scheduled_days,
    learning_steps: fsrsCard.learning_steps ?? 0,
    reps: fsrsCard.reps,
    lapses: fsrsCard.lapses,
    state: mapFSRSStateToState(fsrsCard.state),
    last_review: fsrsCard.last_review ? new Date(fsrsCard.last_review) : undefined,
  } as Card;
}

function cardToFSRSCard(card: Card): FSRSCard {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps ?? 0,
    reps: card.reps,
    lapses: card.lapses,
    state: mapStateToFSRSState(card.state),
    last_review: card.last_review,
  };
}

export function createNewCard(): FSRSCard {
  return {
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
}

function doScheduleReview(
  scheduler: FSRS,
  card: FSRSCard,
  rating: Rating,
  reviewDate: Date,
  cardId?: string
): { card: FSRSCard } {
  // With a card id, the fuzz is seeded by card id + review count instead of
  // the review time, so a previewed interval matches the scheduled one.
  const tsCard = cardId ? { ...fsrsCardToCard(card), card_id: cardId } : fsrsCardToCard(card);
  if (cardId) scheduler.useStrategy(StrategyMode.SEED, GenSeedStrategyWithCardId("card_id"));
  const grade = mapRatingToGrade(rating);
  const schedulingInfo = scheduler.repeat(tsCard, reviewDate);

  let result;
  if (grade === FSRSRating.Again)     result = schedulingInfo[FSRSRating.Again];
  else if (grade === FSRSRating.Hard) result = schedulingInfo[FSRSRating.Hard];
  else if (grade === FSRSRating.Good) result = schedulingInfo[FSRSRating.Good];
  else                                result = schedulingInfo[FSRSRating.Easy];

  const capped = withinMaximum(cardToFSRSCard(result.card), reviewDate, scheduler.parameters.maximum_interval);
  return { card: onStudyDays(capped, reviewDate) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ts-fsrs keeps Hard, Good and Easy at least a day apart after capping them
 * at the maximum interval, so at the cap Good and Easy came out one and two
 * days past it (verification D8). The maximum is a hard limit, as in Classic.
 */
function withinMaximum(card: FSRSCard, reviewDate: Date, maximumInterval: number): FSRSCard {
  if (card.state !== FSRSState.Review || card.scheduled_days <= maximumInterval) return card;
  return { ...card, scheduled_days: maximumInterval, due: new Date(reviewDate.getTime() + maximumInterval * DAY_MS) };
}

/**
 * ts-fsrs puts a review card N x 24 hours after the answer. The queue counts
 * days from the 4am local rollover, so across a DST change that could land a
 * day early (even the same study day) or a day late (verification D1). Keep
 * the answer's local wall-clock time instead, N calendar days later, as the
 * Classic scheduler does: the card is then due exactly N study days later.
 * Only the due date moves; the memory state and scheduled_days are ts-fsrs's
 * own, and ts-fsrs measures elapsed time from last_review, not from due.
 */
function onStudyDays(card: FSRSCard, reviewDate: Date): FSRSCard {
  const days = card.scheduled_days;
  if (card.state !== FSRSState.Review || days < 1) return card;
  if (card.due.getTime() !== reviewDate.getTime() + days * DAY_MS) return card;
  const due = new Date(reviewDate);
  due.setDate(due.getDate() + days);
  return { ...card, due };
}

export function scheduleReview(
  card: FSRSCard,
  rating: Rating,
  reviewDate: Date = new Date()
): { card: FSRSCard } {
  return doScheduleReview(fsrs, card, rating, reviewDate);
}

export function scheduleReviewWithParams(
  card: FSRSCard,
  rating: Rating,
  params: FSRSParameters,
  reviewDate: Date = new Date(),
  cardId?: string
): { card: FSRSCard } {
  const scheduler = new FSRS({
    request_retention: params.request_retention,
    maximum_interval: params.maximum_interval,
    enable_fuzz: params.enable_fuzz,
    w: params.w,
  });
  return doScheduleReview(scheduler, card, rating, reviewDate, cardId);
}

export function getLearningCards(cards: UserFlashcard[]): UserFlashcard[] {
  return cards.filter(
    (card) =>
      card.fsrs_state.state === FSRSState.Learning ||
      card.fsrs_state.state === FSRSState.Relearning
  );
}

export function getReviewCards(cards: UserFlashcard[]): UserFlashcard[] {
  return cards.filter((card) => card.fsrs_state.state === FSRSState.Review);
}

export function getMatureCards(cards: UserFlashcard[]): UserFlashcard[] {
  return cards.filter(
    (card) =>
      card.fsrs_state.state === FSRSState.Review &&
      card.fsrs_state.stability >= 21
  );
}
