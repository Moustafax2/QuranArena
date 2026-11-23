# Phase 5 system verification: `fix/flashcards-on-main` (agent V2)

Branch `fix/flashcards-on-main` at `a204ead` (the Phase 1 port, D1, and the Phase 4 fixes M13, M1, M4, H6, H2, M7, H1+M3+H5 and Lint).
Run on 2026-11-15 on the local machine only. Nothing contacted production, hosted Supabase or QF. No product code was changed.

## Summary

| Area | Result |
|---|---|
| Gates (tests, tsc, lint, build) | PASS |
| Heavy flashcard suite (`FLASHCARD_VERIFY_HEAVY=1`) | PASS |
| 25-run 90-day simulation | Not re-run: the scheduler code is unchanged since V1 ran it at `fc84d98` (see 2) |
| Local-stack scripts (M13, M4, multiplayer races) | PASS (3 of 3) |
| Browser: flashcards, guest and account | PASS |
| Browser: two-browser multiplayer | PASS |
| Browser: sign-in consent and age | PASS |
| Browser: reader | Not runnable offline. The reader pages need a QF content-API token, which the fence blocks |
| Browser: memorization and the M7 outbox | PASS (the question API was stubbed; see 4) |
| Browser: PrivacyGate (H6) | PASS |
| Browser: sweep of every page, guest and account | PASS. No direct Supabase call from the browser |
| New defects | None found in the Part-1 fixes. Observations are in section 6 |

## 1. Gates

| Gate | Result |
|---|---|
| `npm test` | exit 0, 191 `ok`, 0 `not ok`. The privacy suite and the multiplayer-privacy suite both passed |
| `npx tsc --noEmit -p . --incremental false` | exit 0 |
| `npx eslint .` | 0 errors, 14 warnings. No error is new against the baseline |
| `npx next build` | exit 0 |

## 2. Heavy flashcard suite

| Run | Result |
|---|---|
| `FLASHCARD_VERIFY_HEAVY=1 npx tsx scripts/run-progress-tests.ts` | exit 0, 191 `ok`, 0 `not ok`, 9 min 20 s |

What it covered:
- **FSRS:** 50,000 seeded histories (1,026,121 answers) equal ts-fsrs field for field. Around every DST change of 2026–2027 in 5 zones, an interval of N days is N study days (11,520 answers).
- **Classic:** the golden table G01–G20 (32 rows plus G17) matches. 50,000 seeded Classic sequences (1,528,028 answers) pass.
- **Queue properties:** 3,000 random decks.
- **Fast simulations:** 0 invariant failures.

**The 25-run `scripts/flashcard-sim.ts` was skipped, as the brief allows.**
- `git diff fc84d98..HEAD -- src/lib/fsrs src/lib/sm2 src/lib/flashcard/queue.ts src/lib/flashcard/session-manager.ts` is empty.
- The scheduler code is therefore byte-for-byte the code V1 simulated at `fc84d98` (25 runs, 0 invariant failures).

## 3. Local-stack scripts (outside `npm test`)

| Script | Result |
|---|---|
| `node scripts/test-m13-grants-local.mjs` | exit 0, 24 `ok` |
| `npx tsx scripts/test-m4-row-cap-local.ts` | exit 0 |
| `node scripts/test-multiplayer-races-local.mjs` | exit 0, 15 `ok`, 10 trials each |

**M13:**
- The browser roles hold no grants.
- A signed-up GoTrue user can't read or write app tables.
- `service_role` keeps every table and function the app, the edge functions and the operator scripts use.
- `delete_player_data_core` stays closed.
- Sign-up is open on the local stack. Turning it off on the hosted project is a deploy step.

**M4:** the memorization read returned 1,500 of 1,500 attempts, and the progress read 1,800 of 1,800 play events.

**Multiplayer races:**
- H1: two final answers at once add points and lifetime stats once (0 of 10 trials reproduced). A late answer gets 409.
- M3: two starts at once make one game. Correct answers at once get the 1st/2nd/3rd bonus once each. Buzzes at once have one winner. Wrong answers at once all count. Joins at once never pass 8 players.
- H5: a round past its time is ended by the heartbeat, and a round still inside its time stays open.
- Main's lobby-rejoin, full-room and winner behaviour is kept.

**How the edge functions were served:**
- They ran under `npx supabase functions serve`.
- The env file was a copy of `supabase/functions/.env` with three lines added: `HTTP_PROXY=HTTPS_PROXY=http://127.0.0.1:9` and `NO_PROXY=kong,…,localhost,127.0.0.1`.
- The edge container's environment showed the proxy variables, so any outbound call from Deno would have hit a dead proxy.
- No outbound attempt was logged. The dependencies were already cached.

## 4. Browser pass

### Setup

- **Server:** `npm run dev -- --webpack` (Next 16.2.3), started by a launcher that adds the server fence:
  - a dead proxy: `NODE_USE_ENV_PROXY=1`, `HTTP_PROXY=HTTPS_PROXY=http://127.0.0.1:9`, `NO_PROXY=localhost,127.0.0.1`;
  - a preloaded module that refuses and logs DNS lookups and fetches to non-local hosts;
  - a memory watchdog;
  - a V8 heap cap of 1–2 GB (see section 7);
  - `ENABLE_DEV_AUTH=true`, and Supabase targeting the local stack through `.env.development.local`.
- **Browser:** headless Chrome over CDP, one fresh profile per launch. Every request to a host other than `localhost` or `127.0.0.1` was failed and logged. A dead proxy sat behind that interception.
  - Requests were also failed or answered on purpose to simulate outages; each case is named below.
  - Profile A was a guest, then the account `V2 Test Account` (a local player added with psql, signed in through `/dev/auth`).
  - Profile B was a guest. A second fresh profile B was used for account + guest and for the age check.
- **Multiplayer:** the edge functions were served locally, as in section 3. All games used the Trivia mode, because the other modes build questions from api.quran.com on the server, which the fence blocks.

### Results

| # | Check | Result | Evidence |
|---|---|---|---|
| **a) Flashcards, guest** | | | |
| a-G1 | Empty hub | PASS | "How it works" modal and the banner "Your progress is saved on this device only". No consent or age prompt. Flashcard API calls returned plain 401, and the page fell back to the device |
| a-G2 | Intake of Al-Fatihah | PASS | `/train/flashcards/intake?surah=1` shows 21 "+ Learn" words and the footer "20 to learn • 0 known". After Finish Selection, `qalamspace_flashcards` holds 20 cards |
| a-G3 | Hub counts | PASS | "20 cards to study, 20 new · 0 due", with Total 20, New 20 and Due 0 |
| a-G4 | Review session | PASS | Starts at "20 new · 0 learning · 0 review, 0 / 20". After Got it, Easy, Hard, Got it and Forgot it shows "15 new · 4 learning · 0 review, 1 / 20 cards done". The total stays 20, and the stored ratings are [3,4,2,3,1] |
| a-G5 | Settings | PASS | Defaults: 20 new cards a day, and reviews a day as a number input from 0 to 9999 set to 200. Setting 500 and saving stored 500 on the device, and 500 showed after a reload |
| a-G6 | Stats | PASS | Total 20, 5 reviews, New 15 / Learning 4 / Mature 0, with a forecast. "Retention 0%" is V1's known O1 |
| a-G7 | Deck browser | PASS | 20 cards: New 15, Learning 4, Review 1 |
| **a) Flashcards, account** | | | |
| a-A1 | Sign-in upload only after consent | PASS | Consent POST at 10:18:23. The first flashcard write (`PUT /api/flashcards/cards`) came at 10:19:46, on the first hub visit after dev login. The database then held 20 cards, 5 reviews and preferences of 500 with FSRS. The hub shows "19 cards to study, 15 new · 4 due" and a 1-day streak, with no guest banner |
| a-A2 | Review session | PASS | Each answer sent `PATCH /api/flashcards/cards/<id>` and `POST /api/flashcards/reviews`, both 200. `review_log` went from 5 to 7 |
| a-A3 | Settings | PASS | Shows the server's 500. Setting 600 and saving sent `PUT /api/flashcards/preferences`; the database holds 600 |
| a-A4 | Stats | PASS | Total 20, 7 reviews, New 15 / Learning 4 / Mature 0 |
| a-A5 | Deck browser | PASS | 20 cards: New 15, Learning 4, Review 1 |
| a-A6 | Logout clears the P3 keys | PASS (client part) | `qalamspace_fsrs_params`, `qalamspace_algorithm` and `qalamspace_scheduler_prefs_synced` are gone afterwards. `GET /api/auth/qf/logout` returned 500 because its QF discovery request was fenced (V1's O4), so the cookies stayed |
| a-A7 | D1 expired-session message | PASS | With the last 8 characters of `qf_session` replaced, the hub shows "Your sign-in has expired. Sign in again to keep your progress in sync. Sign in", the header shows "Login", and there is no guest banner. The `localStorage` keys and value lengths are unchanged. The only requests were the session, consent and guest-token routes; there was no `/api/flashcards` request |
| **b) Two-browser multiplayer** | | | |
| b-1 | Create, join, start (guest + guest) | PASS | A: Continue as Guest, Trivia, 5 questions, Create Room `AYDANR`. B joined with the code; the lobby shows "Guest 9109 Host / Guest 6296 (You)". In a second room, B auto-joined through the lobby link |
| b-2 | Countdown visible | PASS | Both browsers show "N seconds left", counting 28 s down to 0 s. At 0 the options are disabled and "Time is up" shows |
| b-3 | A timed-out round ends by itself (H5) | PASS | Round 1 was not answered. The database shows it started at 10:04:04 and ended at 10:04:39 (35 s, 0 answers), and round 2 started at once. Rounds left open while the dev server was down were ended by the heartbeat after the reload (10:07:06 and 10:16:42) |
| b-4 | Simultaneous answers score once each (H1, M3) | PASS | Room `U6G8ZF`, round 5: both browsers clicked the correct answer 62 ms apart, and both submits returned 200. The database has one row each: 8 points (10:17:05.878) and 7 points (10:17:06.226), so the order bonus was applied once each. Room scores are 8 and 7. Round 1 (both wrong, 150 ms apart) also stored one row each |
| b-5 | A failed answer can be retried | PASS | A's `POST /api/multiplayer/submit-answer` was failed once over CDP. The page showed "Network error — answer may not have been recorded" and the options became clickable again. The second click returned 200, and the database has A's row |
| b-6 | Game over and winner | PASS | A shows "You won!" (8 pts) and B shows "Guest 9109 wins!". The database winner is Guest 9109 (rooms `AYDANR` and `U6G8ZF`) |
| b-7 | Account + guest | PASS (partial) | A was `V2 Test Account` after re-consent; B was a fresh guest who used "Join as Guest" from the lobby link. Room `YPHT3M`: the lobby, the start, five rounds each ended by itself at about 31 s, and game over ("Guest 6502 wins!" / "You won!", database winner Guest 6502). The account's scripted answers missed (a mistake in my script), so simultaneous answers were not repeated with an account |
| b-8 | The first submit after a cold compile | Note | In room `AYDANR`, round 3, the first `submit-answer` waited 12.7 s while the dev route compiled. Both answers reached the edge at the round's deadline. One was accepted and the other got 500 (an edge refusal; see O-V2-3). This is a dev-compile effect; b-4 is the clean run |
| **c) Sign-in consent and age** | | | |
| c-1 | Consent unticked; sign-in disabled until ticked | PASS | On `/login?next=/train/flashcards` the box starts unticked and "Continue with Quran.com" is disabled. Ticking it enables the button. Continue sent `POST /api/privacy/consent` (200), then `POST /api/auth/qf/login` (500, because QF discovery was fenced). No `/api/flashcards` request was sent before consent |
| c-2 | Dev login | PASS | `POST /api/auth/qf/dev-login` returned 200, and `/account` shows "V2 Test Account". The httpOnly cookies `qf_session`, `qf_id_token` and `quranarena_privacy` were set, and the consent receipt is attached to the player |
| c-3 | Age check blocks a declared underage user | PASS | Fresh profile: on `/login`, "I'm under 13" shows the under-13 notice, the consent box disappears, and Continue stays disabled. Afterwards, `GET /api/flashcards/cards`, `GET /api/memorization/attempts`, `POST /api/multiplayer/create-room` and `POST /api/auth/qf/dev-login` all return 403 `UNDERAGE` |
| c-4 | Guests are never asked for consent or age | PASS | Across the guest sweep, both guest multiplayer profiles and the fresh guest lobby, no consent box or age prompt appeared outside `/login` |
| **d) Reader** | | | |
| d-1 | `/quran`, `/quran/surah/1`, `/quran/page-view/1` | Not runnable offline | All three render the error boundary ("Something went wrong. An unexpected error occurred…"). The server's `POST https://oauth2.quran.foundation/oauth2/token` (the QF content-API token, `src/lib/quran/auth.ts:70`) was blocked by the fence 14 times. `/quran/search`, `/quran/settings` and `/quran/bookmarks` render |
| **e) Memorization** | | | |
| e-1 | Save an attempt | PASS | The question API needs api.quran.com, so `GET /api/memorization/question` was answered over CDP with a fixed ayah question (1:2). Correct (3) sent `POST /api/memorization/attempts` (200), and the database has the row |
| e-2 | Outage, then the outbox upload (M7) | PASS | One failed POST: the attempt was queued, and the next load uploaded it (GET, then PUT, 200). Longer outage (POST and GET failed): `qalamspace_memorization_outbox` held one entry with `owner` = the V2 player's id and `tries: 0`, and the database was unchanged. After the fault was lifted and the page reloaded: GET 200, PUT 200, a new database row, and the outbox key removed |
| e-3 | A refused save shows the error | PASS | POST answered 400 `{"error":"Invalid attempt (V2 simulated refusal)"}` over CDP. The alert reads "Your rating could not be saved: Invalid attempt (V2 simulated refusal)". The page stays on the question, nothing is queued, and the database is unchanged |
| **f) PrivacyGate (H6)** | | | |
| f-1 | One failed consent re-check mid-review | PASS | Account mid-review ("15 new · 3 learning · 0 review, 1 / 19"). `GET /api/privacy/consent` was answered 503 once over CDP, and a window `focus` event triggered the re-check. The review stayed mounted with no gate and no error, and the next answer saved ("2 / 19") |
| f-2 | A real withdrawal still gates | PASS | In a second tab (`window.open`), `/privacy/controls` → "Withdraw consent and clear this browser" → "Consent withdrawn…". The database receipt has `withdrawn_at` 10:38:24. The review tab re-checked through the storage event and now shows PrivacyGate's "Save your progress" box; the review is unmounted and `localStorage` is empty. `GET /api/flashcards/cards` returns 403 `CONSENT_REQUIRED` |
| f-3 | Re-consent | PASS | Ticking the box and pressing Continue in the gate wrote a new receipt (10:39:27), and the app came back |
| **g) Sweep** | | | |
| g-1 | Every page as a guest (26 routes) | PASS | Every route rendered. The only consent box or age prompt was on `/login` itself (`/privacy` mentions "under 13" only in the policy text). There were 0 browser requests to `127.0.0.1:54321`. Console errors appeared only on the three reader pages (the fenced QF token) |
| g-2 | Every page as the account (26 routes) | PASS | The same routes rendered, with no consent box. There were 0 requests to `:54321`, and console errors appeared only on the three reader pages |
| g-3 | No direct Supabase calls from the browser | PASS | 0 of 5,185 logged browser requests went to `127.0.0.1:54321`. `src/lib/supabase/client.ts` is imported nowhere |
| g-4 | No page URL carries personal data | PASS | The page URLs loaded were the fixed routes plus these query strings: `/train/flashcards/intake?surah=1`, `/login?next=/train/flashcards` and `/play/<room code>?mode=trivia` (main's room route). No name, email, player id or token appeared in a page URL; ids appear only in `/api` request URLs |
| g-5 | Console errors beyond the known ones | PASS | Profile A over the whole run: 18 errors from the fenced QF token on reader pages; 1 logged `SessionExpiredError` during the D1 check (expected); 1 dev "Fast Refresh performing full reload" warning. Profile B: 2 `UNDERAGE` load errors during the age check (expected) |

## 5. Fenced requests

**Browser (all blocked by CDP, none reached):**

| Target | Count | Where |
|---|---|---|
| `va.vercel-scripts.com/v1/script.debug.js` | 98 | Vercel Web Analytics dev script, on every page |
| `api.quran.com/api/v4/verses/by_key/<key>` | 37 | Example verses on the review card |
| `api.quran.com/api/v4/verses/by_chapter/1` | 1 | Intake |
| `files.quran.app/hafs/madani/width_1260/page001.png` | 4 | The memorization tester's mushaf page image |

**Dev server (blocked by the preload; logged in the server fence log):**

| Target | Count | Trigger |
|---|---|---|
| `POST oauth2.quran.foundation/oauth2/token` | 14 | Reader pages (QF content-API token) |
| `GET oauth2.quran.foundation/.well-known/openid-configuration` | 2 | `POST /api/auth/qf/login` (sign-in start) and `GET /api/auth/qf/logout` |
| `GET registry.npmjs.org/-/package/next/dist-tags` | 6 | Next dev's version check |

**Edge functions:** the proxy variables were set and no outbound attempt was logged.

Nothing reached QF (oauth2, apis or prelive), hosted Supabase, quranarena.ca or vercel.app.

## 6. Defects and observations

**No new defect was found in the Phase 1 port, D1 or the Phase 4 fixes.** The observations below are either `origin/main`'s behaviour or an effect of running offline.

- **O-V2-1: the reader can't render offline.**
  - Without a QF content-API token, `/quran`, `/quran/surah/[id]` and `/quran/page-view/[n]` show the generic error boundary; the token request is at `src/lib/quran/auth.ts:70`.
  - This is expected under the fence, and it is main's code.
  - To reproduce: block `oauth2.quran.foundation` and open `/quran/surah/1`.
- **O-V2-2: an invalid memorization attempt returns 500 with the raw database message.**
  - To reproduce, while signed in: `fetch('/api/memorization/attempts', {method:'POST', body: JSON.stringify({client_attempt_id:'x', mode:'ayah', rating_level:9, tested_at:new Date().toISOString()})})` returns 500 `{"error":"new row for relation \"memorization_attempts\" violates check constraint …"}`.
  - The cause is `src/app/api/memorization/attempts/route.ts:104`. `origin/main` has the same code at line 92.
  - With M7, a 500 counts as retryable, so such an entry would be retried until the outbox caps drop it (5 tries counted only while other entries save, or 30 days).
  - The app never builds such an attempt (ratings are 0–2). This is not a regression; it is reported for the coordinator.
- **O-V2-3: the Next `submit-answer` route turns every edge-function error into a 500.**
  - That includes the edge's 409 "This round is not open for answers" (`src/app/api/multiplayer/submit-answer/route.ts:36-40`, main's code).
  - The page then shows the error and unlocks the options (H5). That is harmless once the round is closed, but the status is misleading. It was seen in b-8.
- **O-V2-4: a declared-underage visitor without an account isn't shown the under-13 notice on study and game pages.**
  - The server refuses with 403 `UNDERAGE`, but `/play` still shows the game setup form, and the flashcard hub shows "Your flashcards could not be loaded".
  - `PrivacyGate` returns the app unchanged for visitors who aren't signed in (`src/components/legal/PrivacyGate.tsx:65`). This is main's design (no gate for guests). It is a UX point only; the block itself holds.
- **O4 (from V1), seen again:** `GET /api/auth/qf/logout` returns 500 and keeps the session cookies when QF discovery can't be reached.

## 7. Environment notes and what was not run

- **Memory.**
  - Without the dev server, the machine sat at about 78–80% of its commit limit (WSL about 6 GB, VS Code about 4 GB).
  - The webpack dev server added about 3–4 GB, and the watchdog stopped it three times: once at under 250 MB free, then at 90% and 93% commit.
  - Each stop was during compiling or multiplayer polling. After each restart, both browsers reloaded into the running game, and the heartbeat ended the rounds that were overdue.
  - The final runs used a 1 GB V8 heap cap. The PC did not crash.
- **Stubbed or simulated, not real:**
  - The memorization question (needs api.quran.com).
  - The submit, attempts and consent failures (CDP-injected).
  - The underage declaration came from the "I'm under 13" button, as the app offers.
- **Not run:**
  - The real QF OAuth sign-in and a completed server logout (both need QF).
  - The reader's verse content.
  - Non-Trivia game modes (their questions come from api.quran.com).
  - Simultaneous answers with an account player (b-7 note).
  - The 25-run 90-day simulation (the scheduler is unchanged; see 2).
- **Left behind on purpose:**
  - The local player `V2 Test Account` (`local-test-sub-v2`), with its migrated cards and reviews, 3 memorization attempts, consent receipts and the test rooms, stays in the local database.
  - The Supabase stack is still running.
  - The dev server, Chrome, the functions-serve process and the edge container were stopped, and the container was removed.
