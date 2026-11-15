# Plan: rebuild on the remote `main`, with the flashcard changes and the major fixes

**Status: IN PROGRESS. The user said "start now" on 2026-11-14.**
Written 2026-11-14. The source branch is `fix/audit-remediation` (HEAD `4222e14`); it stays untouched.
Remote `main` was `origin/main` = `2355a79` when this was written. Fetch it again before starting, and note it if it has moved.

## User decisions (binding)
1. **The flashcard changes include their small bug fixes.** Every flashcard-related change on `fix/audit-remediation` comes across: the Anki-style queue, Classic SM-2, FSRS changes, stats, intake, settings, the review page, and the fixes L1–L4, L21, N1–N6, D1/D3–D9, U1–U3, FR1 and C-N1/C-N3/C-N6.
2. **The L12 rename may be applied** (`007_progress_analytics.sql` → `0071_progress_analytics.sql`, content unchanged), so the local database can be rebuilt for browser tests.
3. **The major issues are the "Part 1: The real issues" list in the PDF summary** (`QuranArena-final-report.pdf`): H1, H2, H3, H4, H5, H6, M1, M3, M4, M5, M6, M7, M10, M13, U3, D1 and Lint. **Outside the flashcards, no other fix is applied**: no other M, L or N item, no C-R item, and no review-only cleanups. A3R/A4R review fixes come along only where a Part-1 fix can't work without them. Each such case gets its own commit and is listed in the report.
4. **Every agent runs on Opus at effort high.**
5. **Privacy must not regress.** The current `main` complies with its live privacy policy at https://quran-hackathon.vercel.app/privacy. Every change must keep that true. **Never edit the privacy or terms text.**
6. Nothing is pushed, merged or deployed. Nothing contacts production, hosted Supabase or QF. `.env.local` is never read or edited.

## Privacy constraints from the current `main`
These differ from what `fix/audit-remediation` assumed. The text is in `origin/main:src/app/privacy/page.tsx` (last updated November 13, 2026). Before Phase 1, an agent reads the live page and confirms it matches.
- **Consent is asked only at QF sign-in.** It is a separate, initially unticked opt-in, required before any account feature or any local-to-account migration.
- **Guests are not asked for consent or age.** A guest gets a random name.
  - Ported code must NOT bring back the old guest consent gate or the guest age prompt.
  - It must not add a server-side consent requirement for guest-only paths that `main` allows.
  - `main`'s `proxy.ts`, `PrivacyGate`, `ConsentChoice` and `consent-client` stay as `main` has them, unless a Part-1 fix strictly needs a change there. Any such change must be proven consistent with the policy.
- **The age check happens at sign-in only**, and blocks sign-in and game features for a declared underage user.
- **Vercel Web Analytics** sends page paths with query strings and room ids removed. Ported code must not add new paths that put personal data into URLs.
- **Guest browser data expires after 24 hours of inactivity.** The device-storage section and the deletion, export and retention promises still hold. Every new column or browser key must be covered by the existing export and deletion paths and fit a category the policy already discloses.

## Phase 0: set up (coordinator)
1. Run `git fetch origin`.
2. Run `git switch -c fix/flashcards-on-main` from `fix/audit-remediation`, then `git reset --hard origin/main` on the NEW branch only. Confirm that `fix/audit-remediation` still points at `4222e14`.
3. **Baseline on bare `origin/main`:**
   - `npm install`;
   - `npm test` (record the ok/not ok counts);
   - `npx tsc --noEmit -p . --incremental false`;
   - `npx eslint .` (record the error and warning counts; expect about 29 errors);
   - `npx next build`.
4. Commit this plan file onto the new branch, so the agents can read it there.

## Phase 0 result (recorded 2026-11-14)
- `origin/main` had not moved: still `2355a79`. `fix/flashcards-on-main` was reset to it; `fix/audit-remediation` is unchanged at `61d27c5`.
- Baseline on bare `origin/main`:
  - `npm test`: exit 0 (7 progress tests ok, the privacy and multiplayer-privacy suites passed);
  - tsc: 0;
  - `npx eslint .`: **32 errors, 16 warnings** (exit 1). This is the baseline: no new errors are allowed; the Lint item in Phase 4 brings it to 0;
  - `npx next build`: 0.

## Phase 1: port the flashcard changes (agent F1)
- **Port** these, adapted to `main`:
  - `src/lib/flashcard/**` (with the verification suite);
  - `src/lib/sm2/**` and `src/lib/fsrs/**`;
  - the flashcard API routes (`src/app/api/flashcards/**`);
  - the pages under `src/app/train/flashcards/**`;
  - `src/components/flashcard/**`;
  - the flashcard storage (`flashcard-storage*.ts`);
  - `src/lib/types/flashcard.ts`;
  - the flashcard parts of progress and stats;
  - `scripts/flashcard-sim.ts`;
  - the flashcard test wiring.
- **Migrations:** `011`, `013`, `016` and `017`, keeping their numbers, plus the `0071` rename.
- **Shared code:** prefer `main`'s existing session, auth and consent code. Do NOT bring across the A2 rework (`withSession`, `auth-refresh`, the `AuthProvider` changes) just for the flashcards; adapt the flashcard routes to `main`'s session helpers instead. Small pure helpers (`supabase/paging.ts`, `api-validation.ts`, `public-error.ts`, `settle.ts`) may come along when a flashcard file needs them.
- **H3, H4, M5, M6, M10, U3 and D1 are flashcard fixes**, so they come in this phase. Check each one against the privacy constraints above; in particular, the local-to-account migration (M6, U3) must run only after `main`'s sign-in consent.
- **Gates** after each logical commit: tests (0 `not ok`), tsc 0, no NEW lint errors versus the baseline, and a build at the end.
- **Then** run `/code-review high` on the Phase 1 diff, and fix its findings test-first.

## Phase 2: verify the system after the port (agent V1)
1. All gates.
2. The flashcard verification suite, once with `FLASHCARD_VERIFY_HEAVY=1`: FSRS against ts-fsrs, the Classic golden table, the queue properties and the 90-day simulation.
3. **Local browser check:**
   - Local Supabase: `npx supabase db reset` on the local stack only (it now works because of the `0071` rename), then seed the word table with `npx tsx --env-file=.env.development.local scripts/seed-lexical.ts`. Never use `npm run seed-lexical-db`, because it targets the hosted database.
   - Run as a guest and as a dev-login account.
   - Flows: intake of Al-Fatihah (21 words; 20 pre-selected); hub counts; a session with new, learning and review counts; settings; stats; sign-in migration.
   - Confirm guests are never asked for consent, and accounts are asked at sign-in.

## Phase 3: triage the Part-1 list (agent T1, read-only)
For each of **H1, H2, H5, H6, M1, M3, M4, M7, M13 and Lint**, and as a re-check H3, H4, M5, M6, M10, U3 and D1, decide whether the issue is:
- fixed by remote `main`;
- fixed by the Phase 1 port;
- not applicable any more, because `main` changed the design (for example, H6 under the new sign-in-only consent);
- or **still present**.

Prove each verdict with a reproduction test on the new branch, not just by reading the code. The output is a table with file:line evidence, committed as `docs/major-bug-triage.md`.

## Phase 4: apply only the open Part-1 fixes (one agent per bug, one after another)
- **Order:** M13 → M1 → M4 → H6 → H2 → M7 → H1 / H5 / M3 (together, if they share migration `014`) → Lint, last.
- **For each still-present issue:**
  1. Write the reproduction test and see it fail.
  2. Port only that fix from `fix/audit-remediation`, adapted to `main` and to the privacy constraints.
  3. Commit it.
  4. **Run the full gates after every single bug fix.**
  5. Run a privacy check of that fix against the policy.
- **Notes by bug:**
  - **H1, H5 and M3** need migrations `014` and `015` and the edge-function changes. Bring the minimum. If the review fixes A3R1–A3R10 are needed for correctness, such as round timing, include only those that are required and list them.
  - **H6:** `main` reworked `PrivacyGate`. Fix only if the "unmount on a failed re-check" behaviour still exists, and keep `main`'s consent model.
  - **M7** (the memorization outbox) must not queue data for anyone `main` doesn't allow. Tag entries with the signed-in player (the A4R1–A4R3 logic).
  - **M13** (migration `012`) must keep `service_role` access to the export and deletion functions.
  - **Lint:** fix the errors with no `eslint-disable`, no try/finally tricks, and no behaviour changes.
- **If a fix can't be applied without a non-Part-1 change, STOP that bug and report it.** Don't silently widen the scope.

## Phase 4 coordinator decisions (2026-11-15, after the Phase 3 triage in `docs/major-bug-triage.md`)
Main fixed none of the open items. All of M13, M1, M4 (non-flashcard), H6 (accounts), H2, M7, H1, M3, H5 and Lint are still present. Each agent follows these:
1. **No new dependencies.** PGlite is NOT added. SQL-level proofs (H1, M3, H5, M13) run against the LOCAL Supabase stack as committed scripts outside `npm test` (for example `scripts/test-*-local.mjs`), documented in the triage or the report. Pure logic tests stay in `npm test`.
2. **Migration 014 is reduced to Part-1.** Keep only what H1, M3 and H5 need. Strip L6 (tie / no-points-no-win), L19 (lobby rejoin), M2 (the 50-round cap) and reply-shape changes, wherever they can be separated. A piece that can't be separated without breaking a Part-1 fix stays, gets its own note in the commit, and is listed in the report. The file stays named `014_multiplayer_atomic_transitions.sql`; its header says it is a reduced form of the source branch's 014.
3. **Migration 015 is skipped** (its lead-in needs M11's client poll, which is not Part-1), as is 018 (C-R4).
4. **H2 is fixed per process only**, as on the source branch. Port the listed commits; keep `useAuth`'s `sessionExpired` (the D1 fix). Skip `5fb44b1`, because it changes main's consent receipts. The multi-instance gap is reported, not fixed.
5. **The Lint `*.cjs` override** in `eslint.config.mjs` (CommonJS files may use `require`) is allowed: it's a file-type config, not a silenced error. No `eslint-disable` comments.
6. **M13:** `supabase/config.toml` is not changed. Turning off hosted sign-up stays a deploy step for the user.
7. **M1:** port `scripts/seed-lexical.ts` and its helper, but do NOT add any npm script that loads `.env.local` (it would target the hosted DB). The documented local command is `npx tsx --env-file=.env.development.local scripts/seed-lexical.ts`.
8. **The H3 leftovers** (flagged words and unsynced cards are lost when main's PrivacyGate wipes device data after a lapse) can't be fixed without changing PrivacyGate or adding server columns. They are reported to the user, not fixed.
9. **Source commit messages carry `Co-Authored-By` lines.** Never reuse them (no cherry-pick `-x`, no copied messages); write fresh messages without attribution.
10. **The order** is M13 → M1 → M4 → H6 → H2 → M7 → H1+M3+H5 → Lint, one agent each. The coordinator verifies the gates between agents. The reproduction tests from Phase 3 are in the coordinator's scratchpad `triage-repros/`; each agent moves its bug's reproduction into the repo, test-first.

## Phase 5: verify the whole system (agents V2 and R1)
1. **V2:** all gates, plus the heavy flashcard suite, plus a full local browser pass:
   - flashcards, as a guest and as an account;
   - a two-browser multiplayer game (a timed-out round, simultaneous answers);
   - sign-in consent and age;
   - the reader;
   - memorization;
   - a sweep of every page as a guest and as an account (no direct Supabase calls from the browser, if `012` is in).
2. **R1:**
   - run `/code-review high` on `origin/main..HEAD` and fix the confirmed findings, staying within scope;
   - do a **privacy compliance check** of the whole diff against the live policy and the QF developer privacy guidelines: no regression, no new data that isn't disclosed, and export and deletion still cover everything.
3. **Report:** write `docs/flashcards-on-main-report.md`. It must contain:
   - a table of the Part-1 issues showing which were fixed by `main`, by the port or by Phase 4;
   - what was left out on purpose;
   - the gates;
   - the browser results;
   - the privacy verdict;
   - the **deploy steps** (which migrations, which edge functions, which secrets);
   - a short PDF summary saved OUTSIDE the repo, because Tailwind scans the files in the repo.

## Standing rules for every agent
- Work test-first, one commit per item. **Do NOT add any `Co-Authored-By` line or any other AI attribution to commit messages** (the user's instruction).
- The gate script must stop at the first failure.
- **Never write scratchpad or absolute temp paths into committed files.** A path like that broke `next build` once.
- Use the local Supabase only, the dev login, and a dead proxy for QF. Fence and log any request that isn't local.
- The coordinator verifies the gates itself after every agent, and resumes any agent that stalls or hits a limit with SendMessage. It doesn't start a new one.
