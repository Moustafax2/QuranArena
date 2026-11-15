import { runDashboardTests } from "../src/lib/progress/dashboard.test";
import { runUtilsTests } from "../src/lib/progress/utils.test";
import { runQueueTests } from "../src/lib/flashcard/queue.test";
import { runPreviewTests, runSchedulerTests } from "../src/lib/flashcard/scheduler.test";
import { runFlashcardApiTests } from "../src/lib/flashcard/api-routes.test";
import { runB2DefectAsyncTests, runB2DefectTests } from "../src/lib/flashcard/b2-defects.test";
import { runCFindingAsyncTests, runCFindingTests } from "../src/lib/flashcard/c-findings.test";
import { runFsrsVerificationTests } from "../src/lib/flashcard/verification/fsrs-parity.test";
import { runClassicVerificationTests } from "../src/lib/flashcard/verification/classic-golden.test";
import { runQueueVerificationTests } from "../src/lib/flashcard/verification/queue-props.test";
import { runFastSimulations } from "./flashcard-sim";
import { runUserCountTests } from "../src/lib/flashcard/user-counts.test";
import { runFlashcardDataTests } from "../src/lib/flashcard/data-fixes.test";
import { runFlashcardPrivacyTests } from "../src/lib/flashcard/privacy.test";
import { runFlashcardReviewFixTests } from "../src/lib/flashcard/review-fixes.test";
import { runSessionExpiryTests, runSessionRouteExpiryTests, runUseAuthExpiryTests, runPageViewExpiryTests } from "../src/lib/flashcard/session-expiry.test";
import { runLexicalSeedTests } from "../src/lib/lexical/seed.test";
import { runRowCapTests } from "../src/lib/data/row-cap.test";
import { runFlagWordingTests, runReviewActionTests, runSettingsResetTests, runShortcutTests, runStatsTests } from "../src/lib/flashcard/stats.test";

async function main() {
  try {
    console.log("Running progress helper tests...");
    runUtilsTests();
    runDashboardTests();
    runQueueTests();
    runSchedulerTests();
    runPreviewTests();
    runB2DefectTests();
    runCFindingTests();
    runStatsTests();
    runShortcutTests();
    await runReviewActionTests();
    runFlagWordingTests();
    runSettingsResetTests();
    await runFlashcardApiTests();
    await runB2DefectAsyncTests();
    await runCFindingAsyncTests();
    // Flashcard verification (B2). FLASHCARD_VERIFY_HEAVY=1 runs the larger counts.
    await runFsrsVerificationTests();
    runClassicVerificationTests();
    await runQueueVerificationTests();
    await runFastSimulations();
    await runUserCountTests();
    await runFlashcardDataTests();
    await runFlashcardPrivacyTests();
    await runFlashcardReviewFixTests();
    await runSessionExpiryTests();
    await runSessionRouteExpiryTests();
    await runUseAuthExpiryTests();
    await runPageViewExpiryTests();
    await runLexicalSeedTests();
    await runRowCapTests();
    console.log("All progress helper tests passed.");
  } catch (error) {
    console.error("Progress helper tests failed.");
    console.error(error);
    process.exit(1);
  }
}

void main();
