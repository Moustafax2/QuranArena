# Phase 2 verification: flashcards on `main` (agent V1)

Branch `fix/flashcards-on-main` at `fc84d98` (Phase 1 port, commits `5b640da..fc84d98` on `1818c0a`).
Run on 2026-11-14/15 on the local machine only. Nothing contacted production, hosted Supabase or QF.
The PC crashed once during the run (see "Environment notes"); the results below come from the logs
written before the crash and from the resumed run.

## Summary

| Area | Result |
|---|---|
| Gates (tests, tsc, lint, build) | PASS |
| Heavy flashcard suite (`FLASHCARD_VERIFY_HEAVY=1`) | PASS |
| Full 90-day simulation | PASS (25 runs, 0 invariant failures) |
| Local DB reset and word seed | PASS (16 migrations, 4,256 words) |
| Guest browser flows | PASS (7 of 7 checks) |
| Account browser flows | PASS, except M10 in the browser (**defect D1**) |
| Privacy checks | PASS |
| Fence | Every non-local request was blocked. QF, hosted Supabase, quranarena.ca and vercel.app were never reached |

## 1. Gates

| Gate | Result |
|---|---|
| `npm test` | exit 0, 118 `ok`, 0 `not ok`. The privacy suite and the multiplayer-privacy suite both passed |
| `npx tsc --noEmit -p . --incremental false` | exit 0 |
| `npx eslint .` | 23 errors, 15 warnings. Baseline is 32 / 16, and no error is new against it |
| `npx next build` | exit 0 (48 s) |

## 2. Heavy flashcard suite

How it is wired:
- `scripts/run-progress-tests.ts` runs the three suites in `src/lib/flashcard/verification/*` and `runFastSimulations` from `scripts/flashcard-sim.ts`.
- `FLASHCARD_VERIFY_HEAVY=1` only raises the counts of the three verification suites.
- The 90-day simulation is not part of `npm test`. It runs on its own with `npx tsx scripts/flashcard-sim.ts`.

| Run | Result | Wall time |
|---|---|---|
| `FLASHCARD_VERIFY_HEAVY=1 npx tsx scripts/run-progress-tests.ts` | exit 0, 118 `ok`, 0 `not ok` | 1,041 s |
| `npx tsx scripts/flashcard-sim.ts` (full) | exit 0, "All simulation runs passed" | 1,266 s |

Wall times are approximate: the local `supabase db reset` ran at the same time for part of the heavy run.

| Check | Heavy-run numbers |
|---|---|
| FSRS against ts-fsrs (B2-F1/E1/E3/F3/F4/A3) | 50,000 seeded histories (1,026,121 answers) match ts-fsrs field for field, and the previews match the schedule. DST moved 175,308 due dates; 135,118 fuzz ranges were checked; 31,803 intervals were capped at the maximum |
| FSRS across DST (B2-A3) | 11,520 answers in 5 zones: an N-day interval is N study days |
| FSRS defaults (B2-F5/F6) | The 21 FSRS-6 weights equal ts-fsrs `default_w`; the steps are 1m 10m, relearning 10m |
| Classic golden table (B2-G01..G20) | 32 rows plus G17 match the hand-worked values |
| Classic property run (B2-G6/G5/G10/E3/A3) | 50,000 seeded sequences (1,528,028 answers) |
| Queue properties (B2-A2/B1/B2/C1-C6/D1q/D2q/D4q) | 3,000 random decks: queues, limits, the even spread of new cards, the session cap and `arrangeNext` follow the rules |
| Fast simulations (also run by `npm test`) | 3 runs, with 2,601, 2,594 and 4,520 checks; 0 failures |
| Full simulation | 24 signed-in 90-day runs (4 zone scenarios: New York with DST ending, New York with DST starting, Dubai, Toronto then Dubai; each with 6 configurations, including FSRS → Classic → FSRS switches) and 1 guest 30-day run. Every run has 0 invariant failures. Example: run1 FSRS defaults, 6,972 answers, true retention 0.709, maximum interval 373 |

## 3. Local stack

| Step | Result | Evidence |
|---|---|---|
| `npx supabase db reset --local` | PASS | exit 0. Applied 001, 0021, 002, 003, 004, 005, 006, **0071**, 007, 008, 009, 010, **011**, **013**, **016**, **017** (16 migrations). No `seed.sql` |
| Seed `lexical_entries` | PASS | `POST /api/admin/seed-lexical`, called only on the local dev server, returned `{"total":4256,"inserted":4256,"previously_in_db":0}`. `select count(*) from lexical_entries` = 4256. `npm run seed-lexical-db` was not used |
| Dev server | PASS | `npm run dev -- --webpack` (see "Environment notes"). It loaded `.env.development.local` (local Supabase), with `ENABLE_DEV_AUTH=true` |
| Server fence | PASS | Layer 1: `NODE_USE_ENV_PROXY=1`, `HTTP(S)_PROXY=http://127.0.0.1:9`, `NO_PROXY=localhost,127.0.0.1`. Layer 2: a `--require` preload that refuses DNS lookups and `fetch` for non-local hosts and logs each attempt. First tested on a separate node process against example.com: both layers blocked it, and a request to local Supabase went through. The preload's start marker shows that the Next server worker ran with both layers |
| Browser fence | PASS | Headless Chrome with a throwaway profile, driven over CDP. `Fetch.enable` on every target fails and logs any request to a host other than localhost or 127.0.0.1. As a second layer, Chrome also used a dead proxy (`--proxy-server=http://127.0.0.1:9`, with localhost bypassed) |

## 4. Browser checks

### Guest

| # | Check | Result | Evidence |
|---|---|---|---|
| G1 | Empty hub, no prompt | PASS | No consent or age prompt. The "How it works" modal opens. The hub says "Your progress is saved on this device only. Sign in to sync across devices." `GET /api/flashcards/{cards,reviews,preferences}` returned a plain 401, and the page fell back to the device |
| G2 | Al-Fatihah intake | PASS | `/train/flashcards/intake?surah=1` lists 21 words (21 "+ Learn" buttons). 20 are highlighted as learn and 1 is not. The footer reads "20 to learn • 0 known". After Finish Selection, `qalamspace_flashcards` holds 20 cards |
| G3 | Hub counts | PASS | "Review Session: 20 cards to study, 20 new · 0 due"; Total Words 20, New Cards 20, Due Today 0 |
| G4 | Review session | PASS | Starts at "20 new · 0 learning · 0 review, 0 / 20 cards done". The buttons showed Got it 10m, Forgot 1m, Easy 6d and Hard 6m. After all 20 new cards were answered: "0 new · 19 learning · 0 review, 1 / 20 cards done". Easy on a learning card then gave "0 / 18 / 0, 2 / 20". The total stays 20 and never becomes 40. A Forgot card came back within the session |
| G5 | Settings limits | PASS | The reviews-per-day number input has `max=9999` (default 200), and the range slider also goes to 9999. The "Longest gap" range has `min=7 max=36500`, value 36500. After saving 9999, `daily_review_cards_limit` is 9999 and `maximum_interval` is 36500, and both survive a reload |
| G6 | Algorithm switch | PASS | The switch has two steps: a warning dialog, then a checkbox and "Switch to Classic". After it, `qalamspace_algorithm` and the preferences both say `sm2`. Switching back to FSRS also worked |
| G7 | Stats | PASS | Total Words 20, Total Reviews 22, breakdown New 0 / Learning 18 / Mature 0, forecast (18 today, 1 tomorrow, 1 in 6 days), "Avg review interval 4d across 2 review cards" |
| G8 | Deck browse | PASS | "20 cards total"; All (20), New (0), Learning (18), Review (2), Relearning (0); each row has Unlearn and Delete |

Under Classic, the hub showed "Nothing to study now, 0 new · 0 due" right after the switch. The 20 cards restart as Classic new cards, and today's 20 new-card allowance was already used. With the new-card limit set to 40 for a moment, the hub showed "20 cards to study, 20 new · 0 due". This is the expected Anki-style daily limit, not a defect.

### Account (dev login)

Dev login works without QF. `src/app/api/auth/qf/dev-login` makes a session for a player in the local database, but only after a consent receipt exists. A test player with no email (`V1 Test Account`, subject `local-test-sub-v1`) was added to the local database with `psql`.

| # | Check | Result | Evidence |
|---|---|---|---|
| A0 | No account without consent | PASS | `POST /api/auth/qf/dev-login` without a consent cookie returned 403 `CONSENT_REQUIRED` (proxy) |
| A1 | Consent asked at sign-in | PASS | `/login?next=/train/flashcards` shows the religious-data opt-in unticked, separate from the Terms text, next to an "I'm under 13" button. "Continue with Quran.com" stays disabled until the box is ticked. Tick, then Continue: `POST /api/privacy/consent` 200, then `POST /api/auth/qf/login` 500, because the fence blocked the server's QF OIDC discovery. The real OAuth flow can't run offline, so dev login was used next |
| A2 | No flashcard write before consent | PASS | From the login page load until consent: `GET /login`, `GET /api/auth/qf/session`, `GET /api/privacy/consent`, `GET /api/multiplayer/guest-token`, then `POST /api/privacy/consent`. No `/api/flashcards` request at all, and none during dev login. The database had 0 cards and 0 reviews until the first hub visit |
| A3 | Dev login | PASS | `/dev/auth`, then "Login as this user": `/account` shows the player. The cookies `qf_session`, `qf_id_token` and `quranarena_privacy` are all httpOnly. `privacy_consents` has 1 row, with its `player_id` attached. PrivacyGate showed no prompt |
| A4 | Sign-in migration | PASS | Order of requests: consent 03:26:23, dev login 03:27:09, first flashcard write 03:28:04. The hub sent `PUT /api/flashcards/cards`, `POST /api/flashcards/reviews` and `PUT /api/flashcards/preferences`. The database then had 20 cards, 22 reviews, `daily_review_cards_limit` 9999, `algorithm` fsrs and `maximum_interval` 36500. The hub shows the account name, "18 cards to study, 0 new · 18 due", Total 20 |
| A5 | Account review session | PASS | Went from "0 new · 18 learning · 0 review, 0 / 18" to "0 / 15 / 0, 3 / 18". Each answer sent `PATCH /api/flashcards/cards/<id>` 200 and `POST /api/flashcards/reviews` 200. `review_log` went from 22 to 27 |
| A6 | Account settings | PASS | The page shows 9999, 36500 and FSRS from the server. Switching to Classic sent one `PUT /api/flashcards/preferences`, and the database now has `algorithm` sm2 |
| A7 | Account stats | PASS | Renders. Under Classic: New 20, Total Reviews 27, "Days to learn all new cards 1 at 20/day" |
| A8 | Account deck browse | PASS | Renders 20 cards: Learning (15), Review (5) |
| A9 | M10 `SESSION_EXPIRED` | **Server PASS, browser FAIL (D1)** | See below |
| A10 | Logout clears the P3 keys | PASS (browser side) | Before logout: `qalamspace_algorithm`=sm2, `qalamspace_fsrs_params`, `qalamspace_scheduler_prefs_synced`=true. After clicking Logout, all three are gone. The server logout returned 500 because it fetches QF discovery first and the fence blocked it, so the session cookies stayed. That is `main`'s logout route, outside the port |

### Privacy

| # | Check | Result | Evidence |
|---|---|---|---|
| P1 | Guests never see a consent or age prompt | PASS | The guest pages (hub, intake, review, settings, stats, browse) never showed the opt-in or "I'm under 13". Guest flashcard calls got a plain 401, never `CONSENT_REQUIRED` |
| P2 | Accounts are asked at sign-in | PASS | A0, A1 |
| P3 | No new page URL carries personal data | PASS | The port adds no page route; it changes only the existing flashcard pages. The one new link is the fixed `/login?next=/train/flashcards`. Intake keeps its existing `?surah=<n>`. Card and review ids appear only in `/api` paths |
| P4 | No browser request reaches a non-local host | PASS | Every one was blocked; the list is below |

## 5. Fenced requests

Browser requests, all blocked by the CDP fence:

| Host and path | From page | Count | Note |
|---|---|---|---|
| `va.vercel-scripts.com/v1/script.debug.js` | every page visited | 23 | The Vercel Web Analytics debug script that `<Analytics/>` loads in development |
| `api.quran.com/api/v4/verses/by_key/<key>` | `/train/flashcards/review` | 110 | Example-verse text on the card. It stayed "Loading...", so this content was blocked by the fence. The same call is in `FlashcardReview.tsx` on `origin/main` |
| `api.quran.com/api/v4/verses/by_chapter/1` | `/train/flashcards/intake` | 1 | Verse metadata (`intake-manager.ts`, also on `origin/main`). Intake still worked from the local word data |

Server requests, all blocked by the server fence:

| Target | Trigger | Layer |
|---|---|---|
| Google Fonts (Geist), 9 attempts | `next/font/google` while compiling. Next fell back to a local font | dead proxy (`ECONNREFUSED 127.0.0.1:9`) |
| `registry.npmjs.org/-/package/next/dist-tags` | Next dev's version check | preload (`BLOCKED-FETCH`) |
| `oauth2.quran.foundation/.well-known/openid-configuration`, twice | `POST /api/auth/qf/login` (sign-in start) and `GET /api/auth/qf/logout` | preload (`BLOCKED-FETCH`) |

No request reached QF (oauth2, prelive or apis), hosted Supabase, quranarena.ca or vercel.app.

## 6. Defects

### D1: M10 does not reach the user. A lapsed session falls back to the device copy instead of showing "Sign in again"

How to reproduce, on a local stack like the one above:
1. As a guest, add the Al-Fatihah words and answer a few cards.
2. Accept consent on `/login`, then sign in through `/dev/auth`. Open `/train/flashcards` so the guest cards upload.
3. Make the session unusable while keeping the cookie. Corrupt the `qf_session` cookie value; for example, replace its last 8 characters with `AAAAAAAA` (CDP `Network.setCookie`). Bumping `players.session_version` should give the same result: it is the same code path, but it was not run.
4. Reload `/train/flashcards`.

Expected (M10): an alert that says "Your sign-in has expired. Sign in again..." and no local writes.

Actual:
- The hub shows "Your progress is saved on this device only", and the header shows "Login".
- The hub shows the stale guest copy from before sign-in (20 cards, 22 reviews), with no alert.
- The console logs `Failed to upload device scheduler preferences: SessionExpiredError` twice.
- Further study is written to `localStorage`.

Proof that the server part works, from fetches inside the page with the corrupted cookie:
1. `GET /api/flashcards/cards` returns 401 `{"code":"SESSION_EXPIRED"}`.
2. `GET /api/auth/qf/session` returns `isAuthenticated:false` and clears `qf_session`.
3. `GET /api/flashcards/cards` again returns a plain 401 `{"error":"Authentication required."}`.

Causes:
1. `src/lib/storage/flashcard-storage-supabase.ts:706-713`: `migrateDeviceSchedulerPreferences` catches every error, `SessionExpiredError` included, and only logs it. It is the first flashcard call in `migrateFromLocalStorage` (line 719), so it is the only call that still carries the cookie.
2. `src/app/api/auth/qf/session/route.ts:9-11` (`main`'s code) clears the QF cookies when the session is unusable; so does `getUsableSession` in `src/lib/qf-user/session.ts:247-249` and `263-265`. `useAuth` calls this route on every page load. After that, every flashcard request goes out without the cookie and is treated as a guest. M10's server-side detection (`src/lib/flashcard/auth-required.ts:13-26`) depends on the cookie still being there, so in the browser it works only for the first request that wins the race.

Severity: medium. A signed-in user whose session lapses quietly studies on the device copy, and their data splits between the server and the browser, which is what M10 is meant to prevent. No test was added; a real reproduction needs the browser race between the two routes. Left for the coordinator.

### Observations (not defects, or outside the port)

- **O1:** Stats show "Retention Rate 0%" and "Success rate 0.0%" when no review-card answer exists yet. `src/lib/flashcard/stats.ts:106` falls back with `?? 0`, and `stats/page.tsx:312` shows the same number. It would read better as "no data". This is cosmetic.
- **O2:** The deck browser always shows the FSRS state, due date and stability, even while Classic is active (`src/app/train/flashcards/browse/page.tsx:132-158`, `330-342`). The stats use the Classic state. `origin/main`'s browser is FSRS-only too, so this is not a port regression.
- **O3:** After the sign-in upload, the guest copies (`qalamspace_flashcards`, `qalamspace_reviews`, `qalamspace_preferences`) stay in `localStorage`; flags stop them from uploading again. Logout removes only the three P3 keys. They are covered by the guest 24-hour expiry and by the privacy controls (the privacy test confirms every flashcard key is cleared and exported). D1 is what makes this stale copy visible.
- **O4:** `GET /api/auth/qf/logout` fails with a 500 and leaves the session cookies when QF discovery can't be reached (`src/app/api/auth/qf/logout/route.ts:9-10`, `28-32`). This is `main`'s code, outside the port. It showed up here only because of the fence.
- **O5:** In the review session, ratings clicked while the previous save is in flight are ignored. In dev, the first save waits about 8 s while the API route compiles. This is the review lock working as intended.

## 7. Environment notes and what was not run

- **The PC crashed during the first attempt.**
  - Turbopack dev (`npm run dev`) logged that it could not resolve `tailwindcss` from the repo's parent directory (a folder that has its own `.git`) while compiling the first page.
  - The dev server then grew past 2.6 GB, and the log shows dozens of node "out of memory" fatal errors before the crash.
  - The same error came back after the reboot, with an upper-case drive letter.
  - `next build` does not show it.
  - The resumed run used `npm run dev -- --webpack`: same app code and env files, no Tailwind error, about 0.9 GB. It ran under a memory watchdog.
  - This looks like a local Turbopack workspace-root problem, not a product defect, but it is worth knowing before Phase 5.
- **Not run:**
  - the real QF OAuth sign-in (it needs QF; the fence blocked its discovery request);
  - a completed server logout (same reason);
  - `players.session_version` as a second M10 trigger.
- **Not tested in the browser:** the deck browser's Unlearn and Delete buttons; the suite covers them.
- **Local database:** it is left with the test player and the migrated rows. The Supabase stack is still running.
