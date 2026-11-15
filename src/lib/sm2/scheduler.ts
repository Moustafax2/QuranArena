/**
 * "Classic (SM-2 based)" scheduler.
 *
 * Algorithm SM-2, (C) Copyright SuperMemo World, 1991.
 * https://www.supermemo.com
 * https://www.supermemo.eu
 *
 * That copyright note and site reference are the wording SuperMemo World
 * requires whenever SM-2 is used:
 * https://supermemopedia.com/wiki/Licensing_SuperMemo_Algorithm
 * (see also https://www.supermemo.com/en/blog/licensing-and-copyrighting-of-supermemo-algorithms).
 * The original algorithm is described at
 * https://www.supermemo.com/en/blog/application-of-a-computer-to-improve-the-results-obtained-in-working-with-the-supermemo-method
 *
 * This is SM-2 as modified by Anki's scheduler: minute-based learning steps
 * before a card graduates, four answer buttons, ease changes of -20/-15/0/+15
 * points, a 1.2x Hard interval, an Easy bonus and credit for answering late.
 * It is a clean-room implementation written from the behaviour documented in
 * the Anki manual (facts and numbers only; no Anki code was consulted):
 *  - https://docs.ankiweb.net/deck-options.html  (learning steps, Hard on a
 *    learning step, minimum interval, new interval, starting ease, easy bonus,
 *    interval modifier, hard interval, maximum interval)
 *  - https://docs.ankiweb.net/faqs/what-spaced-repetition-algorithm  (ease
 *    changes, the Hard/Good/Easy review formulas, minimum ease of 130%, each
 *    button at least one day longer than the previous, learning behaviour)
 * Defaults below are the manual's/Anki's default deck options.
 */

import type { SM2Card, Rating } from "@/lib/types/flashcard";
import { getDayStart } from "@/lib/flashcard/queue";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Learning steps for new cards, in minutes (default "1m 10m"). */
export const LEARNING_STEPS_MIN = [1, 10];
/** Relearning steps after a lapse, in minutes (default "10m"). */
export const RELEARNING_STEPS_MIN = [10];
/** Interval after the last learning step is answered Good (days). */
export const GRADUATING_INTERVAL = 1;
/** Interval when a learning card is answered Easy (days). */
export const EASY_INTERVAL = 4;
/** Starting ease, 250%. */
export const STARTING_EASE = 2.5;
/** Ease never goes below 130%. */
export const MIN_EASE = 1.3;
export const EASY_BONUS = 1.3;
export const HARD_INTERVAL = 1.2;
export const INTERVAL_MODIFIER = 1.0;
/** Multiplier applied to the interval of a forgotten review card ("new interval"). */
export const LAPSE_NEW_INTERVAL = 0;
/** Shortest review interval, in days. */
export const MINIMUM_INTERVAL = 1;
export const DEFAULT_MAXIMUM_INTERVAL = 36500;

export interface SM2Options {
  maximumInterval?: number;
}

export function createNewSM2Card(now: Date = new Date()): SM2Card {
  return {
    phase: "learning",
    step: 0,
    interval: 0,
    repetitions: 0,
    easiness: STARTING_EASE,
    lapses: 0,
    due: now,
    last_review: undefined,
  };
}

/** States saved before learning steps existed have no phase: they are reviews. */
function normalize(card: SM2Card): Required<Omit<SM2Card, "last_review">> & Pick<SM2Card, "last_review"> {
  return {
    phase: card.phase ?? "review",
    step: card.step ?? 0,
    interval: card.phase ? card.interval : Math.max(MINIMUM_INTERVAL, card.interval),
    repetitions: card.repetitions,
    easiness: card.easiness,
    lapses: card.lapses ?? 0,
    due: new Date(card.due),
    last_review: card.last_review ? new Date(card.last_review) : undefined,
  };
}

/**
 * Delay for Hard on a learning step: halfway between the first two steps on
 * the first step (1.5x the step, at most a day longer, when there is only
 * one), otherwise a repeat of the current step.
 */
function hardStepMinutes(steps: number[], step: number): number {
  if (step > 0) return steps[step];
  if (steps.length > 1) return (steps[0] + steps[1]) / 2;
  return Math.min(steps[0] * 1.5, steps[0] + 24 * 60);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

function addDays(date: Date, days: number): Date {
  const due = new Date(date);
  due.setDate(due.getDate() + days);
  return due;
}

/** Whole study days between the due day and the answer day (0 if not late). */
function daysLate(due: Date, now: Date): number {
  const diff = Math.round((getDayStart(now).getTime() - getDayStart(due).getTime()) / DAY_MS);
  return Math.max(0, diff);
}

/** Schedule the next review of a Classic-mode card. */
export function scheduleSM2Review(
  input: SM2Card,
  rating: Rating,
  reviewDate: Date = new Date(),
  options: SM2Options = {}
): SM2Card {
  const maxInterval = Math.max(MINIMUM_INTERVAL, options.maximumInterval ?? DEFAULT_MAXIMUM_INTERVAL);
  const card = normalize(input);
  const base = { ...card, last_review: reviewDate };

  const graduate = (interval: number): SM2Card => {
    const days = Math.min(maxInterval, Math.max(MINIMUM_INTERVAL, Math.round(interval)));
    return { ...base, phase: "review", step: 0, interval: days, repetitions: card.repetitions + 1, due: addDays(reviewDate, days) };
  };
  const atStep = (phase: "learning" | "relearning", step: number, minutes: number): SM2Card => ({
    ...base, phase, step, due: addMinutes(reviewDate, minutes),
  });

  if (card.phase === "learning" || card.phase === "relearning") {
    const steps = card.phase === "learning" ? LEARNING_STEPS_MIN : RELEARNING_STEPS_MIN;
    const step = Math.min(card.step, steps.length - 1);
    // A relearning card returns with the interval worked out at the lapse.
    const goodInterval = card.phase === "learning" ? GRADUATING_INTERVAL : card.interval;
    // Not specified by the manual for relearning; one day past Good keeps Easy > Good.
    const easyInterval = card.phase === "learning" ? EASY_INTERVAL : card.interval + 1;
    switch (rating) {
      case 1:
        return atStep(card.phase, 0, steps[0]);
      case 2:
        return atStep(card.phase, step, hardStepMinutes(steps, step));
      case 3:
        return step + 1 < steps.length ? atStep(card.phase, step + 1, steps[step + 1]) : graduate(goodInterval);
      default:
        return graduate(easyInterval);
    }
  }

  // Review card.
  const current = Math.max(MINIMUM_INTERVAL, card.interval);
  const ease = card.easiness;
  if (rating === 1) {
    const lapseInterval = Math.max(MINIMUM_INTERVAL, Math.round(current * LAPSE_NEW_INTERVAL));
    return {
      ...base,
      phase: "relearning",
      step: 0,
      interval: lapseInterval,
      repetitions: 0,
      easiness: Math.max(MIN_EASE, ease - 0.2),
      lapses: card.lapses + 1,
      due: addMinutes(reviewDate, RELEARNING_STEPS_MIN[0]),
    };
  }

  const late = daysLate(card.due, reviewDate);
  const hard = Math.max(current + 1, Math.round(current * HARD_INTERVAL * INTERVAL_MODIFIER));
  const good = Math.max(hard + 1, Math.round((current + late / 2) * ease * INTERVAL_MODIFIER));
  const easy = Math.max(good + 1, Math.round((current + late) * ease * EASY_BONUS * INTERVAL_MODIFIER));
  const interval = Math.min(maxInterval, rating === 2 ? hard : rating === 3 ? good : easy);
  const easiness = rating === 2 ? Math.max(MIN_EASE, ease - 0.15) : rating === 4 ? ease + 0.15 : ease;

  return {
    ...base,
    phase: "review",
    step: 0,
    interval,
    repetitions: card.repetitions + 1,
    easiness,
    due: addDays(reviewDate, interval),
  };
}
