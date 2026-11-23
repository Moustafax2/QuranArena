# Final report: `fix/flashcards-on-main`

**What the branch is:** `origin/main` (`2355a79`) plus:
- the flashcard changes from `fix/audit-remediation`, with their small review fixes;
- the D1 "session expired" fix;
- the Part-1 major issues that were still open, fixed one at a time.

**Scope:** as the plan says, no other small bug fixes were made.

**Where the work is:** HEAD `0b143b5`, local only. Nothing has been pushed, merged or deployed, and `fix/audit-remediation` is untouched.

**Detailed evidence** is in:
- `docs/flashcards-on-main-plan.md` (the plan and the decisions);
- `docs/flashcards-on-main-verification.md` (Phase 2, after the port);
- `docs/major-bug-triage.md` (Phase 3, reproductions on main);
- `docs/flashcards-on-main-system-verification.md` (Phase 5, the whole system).

## 1. Part-1 issues

| Issue | What it was | Fixed by | Commit(s) | Proof |
|---|---|---|---|---|
| H1 | Simultaneous final answers doubled room scores | Phase 4 | `f7f2253` (migration 014 plus the edge functions) | `scripts/test-multiplayer-races-local.mjs`: 15 ok, 10 parallel trials each |
| H2 | Parallel token refreshes signed users out; a transient QF failure cleared the session | Phase 4 | `f018ac7`, `b22a8d6` | `npm test` H2 cases |
| H3 | A signed-in user's schedule and settings were lost when the device was wiped | Port | `39d5c24`, `e6da004` | `npm test` "H3 (main's model)" |
| H4 | Cards for words not in the bank entered the queues | Port | `39d5c24` | `npm test` "H4" |
| H5 | Rounds nobody answered never ended; there was no countdown; a failed answer couldn't be retried | Phase 4 | `f7f2253`, `1f1f2c8` | Races script and the browser pass (a round ended by itself, the countdown showed, the retry returned 200) |
| H6 | A failed consent re-check unmounted a signed-in user's app mid-review | Phase 4 | `4348b85` | `npm test` H6 cases; browser: a 503 re-check kept the review open |
| M1 | An unauthenticated admin route reseeded the lexical database | Phase 4 | `9de18d4` (route deleted, local seed script added) | `npm test` M1 |
| M3 | Two starts or joins at once created two games; bonuses were wrong | Phase 4 | `f7f2253` | Races script |
| M4 | Memorization and progress reads stopped at the 1,000-row cap | Port (flashcards), Phase 4 (the rest) | `39d5c24`, `69768af` | `scripts/test-m4-row-cap-local.ts`: 1,500 and 1,800 rows read |
| M5 | Re-adding a reviewed word failed | Port | `39d5c24` | Triage re-check against the local PostgREST |
| M6 | Re-uploading reviews duplicated them | Port | `39d5c24`, `e6da004` | `npm test` "M6" |
| M7 | Memorization attempts saved during an outage were never uploaded | Phase 4 | `da1e447` | `npm test` M7; browser outage test |
| M10 | An expired session quietly sent writes to the browser | Port plus D1 | `39d5c24`, `df9debc`, `5613639`, `8cb1467` | `npm test` "M10/N7" and D1 cases; browser shows "Your sign-in has expired" |
| M13 | The browser roles could read and write app tables directly | Phase 4 | `59c8503` (migration 012) | `scripts/test-m13-grants-local.mjs`: 24 ok |
| U3 | A sign-in upload that failed part-way re-sent device cards over the account's | Port | `39d5c24`, `e6da004` | `npm test` "U3" |
| D1 (DST) | FSRS intervals drifted across DST changes | Port | `39d5c24` | `npm test` B2-D1/A3/D7; the heavy suite matched ts-fsrs |
| D1 (session) | M10 didn't work in the browser after the port | Phase 2 fix | `df9debc`, `5613639`, `8cb1467` | Browser re-check 6/6 (`833c60a`) |
| Lint | 32 lint errors on main | Phase 4 | `6517e1c`, `a204ead` | eslint: 0 errors |

**Main had fixed none of these.** The triage confirmed that main's changes since the merge base touch none of these areas.

**Fixed in the final code review:** `0b143b5`.
- **The bug:** an account with no preferences row lost an SM-2 choice that main had kept only on the device. The port's sign-out cleanup deleted that copy.
- **The fix:** the device's choice is now uploaded first.
- **Test:** a new one in `npm test`. It failed before the fix and passes after.

## 2. Left out on purpose

**Not Part-1, skipped by decision:**
- migration 015, together with the lead-in/poll work behind it (M11);
- migration 018 (C-R4);
- commit `5fb44b1`, because it changes main's consent receipts;
- inside 014: L6 (ties), L19 (lobby rejoin) and M2 (the round cap);
- the A3R3/A3R7 timing refinements. Answers are accepted until the deadline plus 2 s if the round is still open, and `server_now` uses the Next server's clock.

**Reported, not fixed:**
- **H2 across instances:** refreshes are shared only within one server process. A complete fix needs a QF grace period on token rotation, or a shared lock.
- **H3 leftovers:** flagged words and unsynced cards stay on the device only. They are lost when main's PrivacyGate wipes the device after a lapsed session. Fixing that needs a PrivacyGate change or new server columns.
- **M10 limit:** after a reload, a user whose session expired is treated as a plain guest.
- **H6 limits:**
  - a sign-out in another tab reaches this tab only through the 30 s timer or focus;
  - `consent-client` can't tell a 4xx from a 5xx.
- **M7:** account outbox entries stay tagged on the device after logout, until the 24 h expiry.
- **M1:** the local seed script has no guard against a non-local database. Always check that the printed host is `127.0.0.1`.
- **Questions from the final code review, left unchanged for you to decide:**
  - **CR1:** the guest-to-account sign-in upload writes the guest's algorithm and FSRS parameters over the account's. Main already did this for every other preference.
  - **CR8:** switching algorithm also saves other settings edits that haven't been saved yet.
  - **R1-a (H5, theoretical):** an answer reply that arrives more than 3.5 s after its round ended is applied to the next round. A round-id guard would fix it.
- **Observations on main's own behaviour, not regressions:**
  - logout returns 500 when QF is unreachable;
  - an invalid memorization attempt returns 500 with the raw database message;
  - the multiplayer `submit-answer` route turns every edge error, including 409, into 500;
  - an under-13 guest doesn't see the notice on study and game pages (the server still blocks them);
  - a transient refresh failure in non-flashcard routes gives a generic 500, with the cookies kept;
  - retention shows 0% when there is no data;
  - browse is FSRS-only;
  - guest copies remain on the device after the upload;
  - `scripts/build-lexical-db.ts` contains a debug fetch.

## 3. Gates (HEAD `0b143b5`, re-run by the coordinator)

| Gate | Result |
|---|---|
| `npm test` | 192 ok, 0 not ok |
| `tsc --noEmit` | 0 errors |
| eslint | 0 errors, 14 warnings (main had 32 errors and 16 warnings; nothing new) |
| `next build` | exit 0 |
| Heavy flashcard suite (`FLASHCARD_VERIFY_HEAVY=1`) | 191 ok / 0 not ok, run at `ef538ff`, before the final fix |
| Local-stack scripts | m13 grants 24 ok; m4 row cap ok; multiplayer races 15 ok |

**Heavy suite detail:**
- FSRS matched ts-fsrs over 50,000 histories (about 1.03 M answers).
- Classic matched its golden table, plus 50,000 sequences.
- 3,000 random queues ran with 0 failures.

## 4. Browser results

All runs were local, with a webpack dev server and headless Chrome. Every non-local request was blocked.

| Area | Result |
|---|---|
| Flashcards, guest and account (intake, review, settings, stats, browse, sign-in upload after consent, logout cleanup, expired session) | PASS |
| Multiplayer with two browsers, Trivia only (create/join/start, countdown, a round timing out, simultaneous answers 62 ms apart, retry after a failed submit, game over) | PASS |
| Sign-in consent unticked by default; the under-13 path is blocked server-side; guests are never asked | PASS |
| Memorization save, outage outbox and recovery, refused save | PASS |
| PrivacyGate: a failed re-check mid-review, withdrawal in another tab, re-consent | PASS |
| Sweep of 26 pages, guest and account | PASS. 0 of 5,185 browser requests went to Supabase directly. |
| Reader | Not runnable offline (it needs QF's content token) |

**Not run:**
- real QF sign-in;
- the reader's verse content;
- non-Trivia game modes;
- simultaneous answers from an account player;
- the 25-run simulation (skipped; the scheduler is unchanged since Phase 2 ran it).

## 5. Privacy verdict: no violation

The branch was checked against `src/app/privacy/page.tsx`, which matches the live policy dated November 13, 2026, and against the QF developer privacy guidelines and developer terms. The policy and terms text were not changed.

- **Consent:** asked only at QF sign-in, with the box unticked. Guests are never asked for consent or age. Main's consent components are unchanged.
- **Browser storage:** the 6 new keys are all `qalamspace_*`. They are covered by the 24 h expiry, the export, and withdraw-and-delete.
- **Server data:** no new table. The new columns (scheduler state and preferences) fall under "scheduling state, study preferences". They are covered by the export and by cascade deletion. Only the service role has grants.
- **When data is written:** account data is written only after consent, and underage players get 403.
- **URLs, logs, analytics:** no personal data. No new third-party service.

## 6. Deploy steps (for the user; nothing has been deployed)

Run these in this order, before or together with the app deploy.

1. **Back up** the hosted database.
2. **Mark the renamed migration as applied.** The old `0071` file was renamed, so `db push` would treat it as new, and it must never be pushed again. Run:
   `npx supabase migration repair --status applied 0071 --linked`
3. **Apply the new migrations in order:** `011`, `012`, `013`, `014`, `016`, `017`.
   - 012 sorts before migrations that may already be applied, so use `supabase db push --include-all` or the SQL editor.
   - Do **not** apply 015 or 018; they are not on this branch.
   - 011, 013, 016 and 017 must be live before the flashcard code goes live.
4. **Redeploy all six edge functions:** `create-room`, `heartbeat-room`, `join-room`, `leave-room`, `start-game`, `submit-answer`.
   - Five of them import changed shared modules.
   - Redeploying all six keeps them consistent with 014.
5. **Secrets:** `MULTIPLAYER_SERVER_SECRET` must be set, with the same value, in the edge function secrets and in the app's environment. It already exists on main, and nothing new is required.
6. **Turn off sign-up:** in the Supabase dashboard, disable Auth sign-up (M13). The app doesn't use Supabase Auth sign-up.
7. **Check the grants:** confirm that `anon` and `authenticated` have no grants on app tables and functions, while `service_role` keeps them. Do this with the SQL from `scripts/test-m13-grants-local.mjs`, adapted to read-only queries.
8. **Seeding:** `npm run seed-lexical-db` targets the hosted database. Use it only deliberately. The admin seed route no longer exists.

**Note on Turbopack:** use `npm run dev -- --webpack` on this machine. Turbopack runs out of memory because it resolves Tailwind from the parent folder's `.git`.

**Local test data:** the local database holds the test players "V1 Test Account" and "V2 Test Account" and their test rooms. They are local only.
