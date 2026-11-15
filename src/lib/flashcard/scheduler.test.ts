import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FSRSCard, SM2Card, UserFlashcard } from "@/lib/types/flashcard";
import { DEFAULT_FSRS_PARAMETERS, FSRSState, Rating, WordStatus } from "@/lib/types/flashcard";
import { formatInterval, previewIntervals, scheduleCard } from "./intervals";
import { scheduleReview, scheduleReviewWithParams } from "@/lib/fsrs/scheduler";
import { createNewSM2Card, scheduleSM2Review } from "@/lib/sm2/scheduler";

function runCase(name: string, fn: () => void) {
  fn();
  console.log(`ok - ${name}`);
}

const DAY = 24 * 60 * 60 * 1000;

function matureFSRSCard(lastReview: Date, stability: number): FSRSCard {
  return {
    due: new Date(lastReview.getTime() + stability * DAY),
    stability,
    difficulty: 3,
    elapsed_days: 0,
    scheduled_days: Math.round(stability),
    learning_steps: 0,
    reps: 12,
    lapses: 0,
    state: FSRSState.Review,
    last_review: lastReview,
  };
}

export function runSchedulerTests() {
  runCase("N1: maximum interval defaults to 36500 days and the settings slider allows it", () => {
    assert.equal(DEFAULT_FSRS_PARAMETERS.maximum_interval, 36500);

    // A very stable card must be allowed past one year, both with the
    // module-level scheduler and with the default parameters.
    const last = new Date(2026, 0, 1, 12);
    const card = matureFSRSCard(last, 400);
    const reviewAt = card.due;
    const params = { ...DEFAULT_FSRS_PARAMETERS, enable_fuzz: false };
    assert.ok(scheduleReviewWithParams(card, Rating.Good, params, reviewAt).card.scheduled_days > 365);
    assert.ok(scheduleReview(card, Rating.Good, reviewAt).card.scheduled_days > 365);

    const settings = readFileSync("src/app/train/flashcards/settings/page.tsx", "utf8");
    assert.match(settings, /max="36500"/);
  });

  // Expected values follow the Anki manual (Deck Options; FAQ "What spaced
  // repetition algorithm does Anki use?") with default options: steps 1m 10m,
  // graduating 1d, easy 4d, relearning 10m, starting ease 250%, easy bonus
  // 1.3, hard interval 1.2, new interval 0, minimum interval 1d.
  const MINUTE = 60 * 1000;
  const T0 = new Date(2026, 9, 27, 9, 0);
  const after = (state: SM2Card, from: Date = T0) => state.due.getTime() - from.getTime();
  const days = (state: SM2Card, from: Date = T0) => Math.round(after(state, from) / DAY);
  const reviewCard = (interval: number, easiness: number, due: Date): SM2Card => ({
    phase: "review", step: 0, interval, repetitions: 3, easiness, lapses: 0, due,
    last_review: new Date(due.getTime() - interval * DAY),
  });

  runCase("N2: Classic new cards walk the learning steps 1m 10m, then graduate", () => {
    const fresh = createNewSM2Card(T0);
    assert.equal(after(scheduleSM2Review(fresh, Rating.Again, T0)), 1 * MINUTE);
    // Hard on the first step: halfway between the first two steps.
    assert.equal(after(scheduleSM2Review(fresh, Rating.Hard, T0)), 5.5 * MINUTE);
    const good = scheduleSM2Review(fresh, Rating.Good, T0);
    assert.equal(after(good), 10 * MINUTE);
    assert.equal(good.phase, "learning");
    const easy = scheduleSM2Review(fresh, Rating.Easy, T0);
    assert.equal(easy.phase, "review");
    assert.equal(days(easy), 4);
    assert.equal(easy.easiness, 2.5);

    // From the last step: Hard repeats it, Again restarts, Good graduates at 1 day.
    const t1 = new Date(T0.getTime() + 10 * MINUTE);
    assert.equal(after(scheduleSM2Review(good, Rating.Hard, t1), t1), 10 * MINUTE);
    assert.equal(after(scheduleSM2Review(good, Rating.Again, t1), t1), 1 * MINUTE);
    const graduated = scheduleSM2Review(good, Rating.Good, t1);
    assert.equal(graduated.phase, "review");
    assert.equal(days(graduated, t1), 1);
    // Failing during learning never lowers the ease.
    const failed = scheduleSM2Review(scheduleSM2Review(fresh, Rating.Again, T0), Rating.Again, T0);
    assert.equal(failed.easiness, 2.5);
  });

  runCase("N2: Classic review answers use Hard x1.2, Good x ease, Easy x ease x 1.3", () => {
    const card = reviewCard(10, 2.5, T0);
    const hard = scheduleSM2Review(card, Rating.Hard, T0);
    const good = scheduleSM2Review(card, Rating.Good, T0);
    const easy = scheduleSM2Review(card, Rating.Easy, T0);
    assert.deepEqual([days(hard), days(good), days(easy)], [12, 25, 33]);
    assert.equal(hard.easiness.toFixed(2), "2.35");
    assert.equal(good.easiness, 2.5);
    assert.equal(easy.easiness.toFixed(2), "2.65");

    // Answered 4 days late: Good gets half the delay, Easy all of it.
    const late = new Date(T0.getTime() + 4 * DAY);
    assert.equal(days(scheduleSM2Review(card, Rating.Hard, late), late), 12);
    assert.equal(days(scheduleSM2Review(card, Rating.Good, late), late), 30);
    assert.equal(days(scheduleSM2Review(card, Rating.Easy, late), late), 46);
  });

  runCase("N2: Classic intervals rise by at least a day per button and respect the limits", () => {
    const tight = reviewCard(1, 1.3, T0);
    const out = [Rating.Hard, Rating.Good, Rating.Easy].map((r) => days(scheduleSM2Review(tight, r, T0)));
    assert.deepEqual(out, [2, 3, 4]);
    assert.equal(scheduleSM2Review(tight, Rating.Hard, T0).easiness, 1.3);

    const capped = scheduleSM2Review(reviewCard(300, 2.5, T0), Rating.Good, T0, { maximumInterval: 365 });
    assert.equal(days(capped), 365);
  });

  runCase("N2: a Classic lapse costs 20% ease and relearns at 10m, then returns at 1 day", () => {
    const lapsed = scheduleSM2Review(reviewCard(30, 2.5, T0), Rating.Again, T0);
    assert.equal(lapsed.phase, "relearning");
    assert.equal(lapsed.easiness.toFixed(2), "2.30");
    assert.equal(lapsed.lapses, 1);
    assert.equal(after(lapsed), 10 * MINUTE);
    const t1 = new Date(T0.getTime() + 10 * MINUTE);
    const back = scheduleSM2Review(lapsed, Rating.Good, t1);
    assert.equal(back.phase, "review");
    assert.equal(days(back, t1), 1);
    assert.equal(back.easiness.toFixed(2), "2.30");
    // Ease never drops below 130%.
    assert.equal(scheduleSM2Review(reviewCard(5, 1.3, T0), Rating.Again, T0).easiness, 1.3);
  });

  runCase("N2: SM-2 states saved by older versions keep working as review cards", () => {
    const legacy = { interval: 6, repetitions: 2, easiness: 2.36, due: T0 } as SM2Card;
    const next = scheduleSM2Review(legacy, Rating.Good, T0);
    assert.equal(next.phase, "review");
    assert.equal(days(next), 14);
    const lapsedLegacy = { interval: 1, repetitions: 0, easiness: 1.96, due: T0 } as SM2Card;
    assert.equal(scheduleSM2Review(lapsedLegacy, Rating.Good, T0).phase, "review");
  });

  runCase("§1A: no Anki branding in the UI; SM-2 and ts-fsrs attribution present", () => {
    const uiFiles: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".tsx")) uiFiles.push(path);
      }
    };
    walk("src/app");
    walk("src/components");
    const credits = join("src", "app", "credits", "page.tsx");
    for (const file of uiFiles) {
      if (file === credits) continue;
      assert.doesNotMatch(readFileSync(file, "utf8"), /anki/i, file);
    }
    const creditsText = readFileSync(credits, "utf8");
    assert.match(creditsText, /Algorithm SM-2, \(C\) Copyright SuperMemo\s+World, 1991/);
    assert.match(creditsText, /Open Spaced Repetition/);
    assert.match(creditsText, /MIT License/);
    assert.match(readFileSync("src/lib/sm2/scheduler.ts", "utf8"), /Algorithm SM-2, \(C\) Copyright SuperMemo World, 1991\./);
  });

  // On this branch the credits carry only what the flashcard code needs: the
  // FSRS / ts-fsrs and SM-2 attributions. The UI never names Anki (checked
  // above), so no Anki statement is needed there.
  runCase("credits page lists the flashcard schedulers' attributions", () => {
    const text = readFileSync(join("src", "app", "credits", "page.tsx"), "utf8").replace(/\s+/g, " ");
    assert.match(text, /Algorithm SM-2, \(C\) Copyright SuperMemo World, 1991/);
    assert.match(text, /supermemo\.com/);
    // SuperMemo's licensing page asks for the note plus both site references.
    assert.match(text, /href="https:\/\/www\.supermemo\.com">/);
    assert.match(text, /href="https:\/\/www\.supermemo\.eu">/);
    assert.match(readFileSync("src/lib/sm2/scheduler.ts", "utf8"), /https:\/\/www\.supermemo\.eu/);
    assert.match(text, /href="https:\/\/github\.com\/open-spaced-repetition\/ts-fsrs">ts-fsrs<\/a> library, copyright © Open Spaced Repetition, used under the MIT License/);
    assert.match(text, /href="https:\/\/supermemopedia\.com\/wiki\/Licensing_SuperMemo_Algorithm">SM-2 licensing terms<\/a>/);
  });
}

export function runPreviewTests() {
  const T0 = new Date(2026, 9, 27, 9, 0);
  const ratings = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
  const base: UserFlashcard = {
    id: "card-1",
    word_id: "w",
    status: WordStatus.IN_BANK,
    created_at: new Date(2026, 0, 1),
    fsrs_state: { ...matureFSRSCard(new Date(T0.getTime() - 20 * DAY), 18), due: new Date(T0.getTime() - DAY) },
  };

  runCase("N3: button previews equal what is actually scheduled (FSRS with fuzz, user params)", () => {
    const params = { ...DEFAULT_FSRS_PARAMETERS, request_retention: 0.8, enable_fuzz: true };
    const preview = previewIntervals(base, "fsrs", params, T0);
    // The answer comes 40 seconds after the buttons were shown.
    const answeredAt = new Date(T0.getTime() + 40 * 1000);
    for (const rating of ratings) {
      const next = scheduleCard(base, rating, "fsrs", params, answeredAt);
      assert.equal(next.fsrs_state.due.getTime() - answeredAt.getTime(), preview[rating], `rating ${rating}`);
    }
    // The user's parameters are used: a different retention gives a different Good.
    const defaults = previewIntervals(base, "fsrs", { ...DEFAULT_FSRS_PARAMETERS, enable_fuzz: false }, T0);
    assert.notEqual(defaults[Rating.Good], preview[Rating.Good]);
    assert.ok(preview[Rating.Again] < preview[Rating.Hard] && preview[Rating.Good] < preview[Rating.Easy]);
  });

  runCase("N3: Classic previews match the schedule and are formatted for the buttons", () => {
    const fresh = { ...base, sm2_state: null };
    const preview = previewIntervals(fresh, "sm2", DEFAULT_FSRS_PARAMETERS, T0);
    const answeredAt = new Date(T0.getTime() + 15 * 1000);
    for (const rating of ratings) {
      const next = scheduleCard(fresh, rating, "sm2", DEFAULT_FSRS_PARAMETERS, answeredAt);
      assert.equal(next.sm2_state!.due.getTime() - answeredAt.getTime(), preview[rating]);
    }
    assert.deepEqual(ratings.map((r) => formatInterval(preview[r])), ["1m", "6m", "10m", "4d"]);
    assert.equal(formatInterval(45 * DAY), "1.5mo");
    assert.equal(formatInterval(400 * DAY), "1.1y");
    assert.equal(formatInterval(3 * 60 * 60 * 1000), "3h");
  });

  runCase("FR1: every flashcard screen names the ratings as the buttons do (Forgot / Hard / Got it / Easy)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".tsx")) files.push(path);
      }
    };
    walk(join("src", "app", "train", "flashcards"));
    walk(join("src", "components", "flashcard"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // The buttons were renamed (N3, plan §1A.2); a rating shown as "Again" or
      // "Good" elsewhere names a button the user can't find.
      assert.doesNotMatch(text, />\s*(Again|Good)\s*</, `${file} shows an old rating label`);
      assert.doesNotMatch(text, /"(Again|Good)"/, `${file} shows an old rating label`);
    }
  });
}
