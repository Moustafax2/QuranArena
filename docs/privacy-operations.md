# Privacy deployment and operations

Status: implementation and proposed procedures, October 25, 2026. Operator/inbox owner is Abdullah Amin; security coverage and procedure approval remain pending. No infrastructure settings or provider contracts are verified by this file.

## Deployment order

Production website: https://www.quranarena.ca/ (owner confirmed October 25, 2026).
Set Vercel Production `APP_URL=https://www.quranarena.ca`; remove or update any stale
`NEXT_PUBLIC_APP_URL`. Register the exact QF callback
`https://www.quranarena.ca/api/auth/callback` with the QF client for the configured
issuer. If provider logout is enabled, register and set
`QF_POST_LOGOUT_REDIRECT_URI=https://www.quranarena.ca` too. Do not change QF_ENV
solely because the public domain changed: it must match the issued credentials.
Make www the canonical domain and verify apex/legacy domain redirects. Keep
preview/local callback and APP_URL configuration separate. Environment changes
need a new deployment. Do not rotate existing secrets just for a domain change.

Cookies and local storage from the old domain do not transfer to the new origin.
Users must sign in again; server records for the same QF identity should remain.
Guest/local-only progress must be exported from the old origin before retiring
it; no automatic cross-domain migration is implemented. The new domain cannot
purge old-domain caches or browser storage, so deploy cleanup to the old origin
where possible and provide instructions for clearing its site data.

Read-only HTTP checks on October 25: homepage 200; `/privacy`, `/terms` and
`/privacy/controls` each 404. These checks do not verify authentication or deployed
security controls. Recheck after deployment.

1. Review `supabase/migrations/009_privacy_controls.sql` in a prelive copy with representative data. Use the normal migration workflow; never reset the live database. Existing baseline has two 007 filenames: check the remote migration ledger before choosing CLI commands. Migration 009 is transactional, but not designed for blind repeat execution.
2. Configure `QF_SESSION_SECRET` as a strong random server-only secret. Configure a new random `MULTIPLAYER_SERVER_SECRET` of at least 32 characters identically in the Next server environment and Supabase Edge secrets. Do not prefix either with NEXT_PUBLIC or print values in logs. Confirm QF confidential-client credentials and callback URL separately for each issuer/environment.
3. Apply migration 009, deploy the Next app and all six multiplayer functions (create-room, join-room, start-game, submit-answer, leave-room, heartbeat-room) in a coordinated maintenance window. Guarded functions reject old app servers; unguarded functions remain vulnerable until replaced. Avoid serving incompatible mixed versions.
4. Old QF cookies lack the new session metadata and require sign-in. Legacy unsigned guests cannot be securely migrated from a player ID alone; their server records require verified support assistance. Explain this before rollout. Do not grant ownership from a submitted UUID or display name.
5. Apply migration 010 and deploy the membership-checked polling client plus Edge functions that no longer broadcast publicly. Verify unauthorized reads fail and normal room/game flows work.
6. Verify public legal/control pages without cookies, age denial, separate consent, persistence/version upgrade, rejected API calls before consent, guest creation, optional bookmark login, export, withdrawal, disconnect and deletion. Test two unrelated users/rooms, direct Edge calls, a fresh browser, offline reload and account switching. Verify old caches disappear. Provider failures must never display a complete success.
7. Confirm TLS/storage/backups/access controls and retention processes. Legal pages are configured as indexable and effective October 25, 2026; deploy them only with the safeguards and controls they describe.

## Privacy requests

Abdullah Amin is the assigned inbox owner (confirmed October 25, 2026). The public contact remains QuranArena@protonmail.com. Backup inbox coverage is not yet assigned. Personal contact details are kept outside this repository. Monitor the inbox and track receipt, verified scope, deadline, completion and minimal evidence. Respond within 30 days. Never request passwords, OAuth tokens or full exports as identity proof. Prefer authenticated Privacy controls. For lost sessions use an approved identity-verification procedure; do not erase records based solely on an unverified email or player ID.

Export and deletion RPCs are service-role only. The application verifies identity before calling them. An operator using the database console must verify identity separately and scope the UUID correctly. The delete RPC erases live app data in one transaction; other participants' records remain and shared rooms may transfer hosts. Do not manually delete just the player row. Correct QF identity at QF; correct app-only records through an authorized, audited support action.

Withdrawal now marks all existing receipts linked to the verified account or guest as withdrawn, plus any unlinked current-browser receipt. Privacy rights remain available through the existing session; study/game APIs require fresh consent. Arrange QF revocation and deletion if requested. Browser-local data on other devices cannot be remotely erased: instruct the user to clear site data there. Existing unrelated/unlinked receipts and guest identities must be considered separately.

## QF deletion and underage reports

Agree with QF on an authenticated deletion event or reconciliation channel before claiming automatic propagation. Do not expose an unauthenticated deletion webhook or treat ordinary token failures as deletion. Verify any received signal, resolve the QF subject to the app player and invoke the same transactional deletion path. Record minimal completion evidence. This integration remains outstanding.

On a credible underage report, promptly restrict the verified account, investigate with minimal data and remove inadvertently collected records through the deletion path. Handle backups and support correspondence too. A self-declared age check is not proof of age.

## Retention and restoration

Required targets are live erasure within 30 days of a verified request and backup removal within 90 days. Confirm provider capabilities, retention configuration and deletion obligations; do not promise these as operational until verified. Guest inactivity and consent/evidence retention are implemented as described below. Define and verify request-correspondence and provider security-log retention. Consent cookie expiry is not database expiry.

Record deletion events in an access-restricted minimal suppression ledger with an approved retention period. Before restoring a backup to service, reapply verified deletions and withdrawn consent, invalidate old sessions, and validate that removed users cannot return from restored data. Test this procedure. Migration 010 and the privacy-admin utility implement the ledger/restore operations; independent ledger preservation and hosted restore rehearsals remain operational tasks.

## Security incidents and providers

Assign primary/backup responders and alert coverage. Start response in less than 24 hours; notify developers@quran.com within 24 hours of discovering actual or suspected API-related unauthorized access, breach or exposure. Contain affected paths, preserve minimal access-restricted evidence, rotate affected secrets, revoke sessions, identify scope and send updates. Meet applicable user/regulator notification requirements. Do not include raw credentials or unnecessary religious activity in reports.

Confirm least-privilege accounts, TLS 1.2+, encrypted primary storage and backups, access review cadence, and secret rotation owner. The published policy commits to routine rotation every 90 days and immediate rotation after compromise; the operator must adopt and implement the schedule. Rotating QF_SESSION_SECRET invalidates guest and consent cookies as well as QF sessions, so plan user recovery.

Verify DPAs, processing regions, retention and transfer safeguards with Vercel, Supabase, Proton Mail and content/avatar hosts. Verify required Islamic-content protections in provider arrangements. Keep evidence rather than relying on marketing summaries.

## Repeatable local checks

Run `npm test`, TypeScript/changed-file lint and `npm run build`.

After deployment, run `npm run verify:release -- https://www.quranarena.ca`. This checks the four public legal/control pages, effective date, postal code, indexing state, consent cache headers and that the two server-only source databases are not publicly downloadable. Then run `supabase/operations/verify-privacy-release.sql` in the Supabase SQL Editor to inspect the required schema, grants, Cron jobs and recent job results. These checks are read-only and do not replace the authenticated/manual acceptance tests below.

SQL regression: install `@electric-sql/pglite` into an isolated temporary directory with no project lockfile changes, then run `node scripts/test-privacy-db.cjs <absolute-path-to-pglite-package>`. The script creates an in-memory database; it does not connect to hosted Supabase. It requires the current repository migration files. Hosted RLS/Realtime behavior and production credentials still require separate prelive tests.

## October 25 implementation update (supersedes earlier pending-code notes)

Abdullah Amin is now the legal operator as well as inbox owner. Address: 142 Breton Avenue, Mississauga, Ontario L4Z 4K4, Canada. Security responder/backup coverage remains pending.

Apply migration **010_privacy_lifecycle.sql after 009**. It removes public reads of player/game tables, adds guest activity and purge/withdraw/restore functions. All browser multiplayer reads now use the server state endpoint with a signed identity and active room membership. A share code reveals only minimal join metadata. Edge functions no longer send public game broadcasts. Deploy all six updated functions and the app together; mixed old/new versions are unsafe or incompatible.

Enable Supabase Cron, then run `supabase/operations/schedule-privacy-cleanup.sql`. Verify the job is active and successful in job history. Access to guests expires after 24 idle hours; the purge runs every 15 minutes. Missed runs are caught up on the next successful run, so alert on failures. It also removes withdrawn receipts after 30 days, unlinked receipts after one year, and deletion evidence after 90 days. Do not claim scheduled cleanup is operating until this is deployed and observed.

Account-wide withdrawal is now implemented for all existing receipts linked to the verified identity. An unlinked current-browser receipt is withdrawn separately. Sessions remain usable for privacy rights controls, while study/game APIs reject withdrawn receipts. Another browser may display old local state until its next 30-second/focus check; local data on closed devices cannot be remotely removed. A user can deliberately grant fresh consent later.

### Shared deletion interface

`src/lib/privacy/deletion.ts` exports:
- `purgePlayerData(playerId)` for a server-verified app identity, used by Delete My Data.
- `purgeVerifiedQfAccount({ subject, eventId })` for a future verified provider event.

The adapter calls `purge_qf_user_data(subject_id, delivery_id)`. The DB transaction finds the linked player, calls the same purge routine and records the delivery ID atomically. Duplicate delivery IDs are no-ops; failures roll back and can be retried. Preserve the provider's stable event ID (namespace it by issuer/type if needed). Do not log raw subjects or event bodies. The provider adapter must validate signature/authentication, issuer, audience/client, event type and replay requirements before calling this function. Confirm subject mapping with QF. No HTTP webhook is enabled while that contract is unknown. App deletion does not delete the user's QF account/bookmarks. An external event cannot revoke tokens still held only in old encrypted browser cookies, but deleted player rows make those app sessions unusable.

### Restore suppression

`privacy_erasure_ledger` contains only player UUID and deletion time; no email, QF subject or study history. Access is service-role only. Before restoring an older backup, isolate the service and export the **latest** ledger to a restricted location outside that backup:

`node scripts/privacy-admin.cjs export-ledger <secure-new-file.json>`

The utility uses NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, including .env.local when present. Explicitly verify the target environment first. It never overwrites an existing export. Preserve the ledger independently and securely for the full backup recovery window; if the current DB is lost before export, an independently preserved recent ledger is necessary. Until independent preservation is arranged, restore suppression is not a guaranteed operational capability.

After restoring to an isolated database and applying migrations, point the utility at that database and run:

`node scripts/privacy-admin.cjs reapply-ledger <secure-file.json> --confirm-restore`

The RPC atomically reapplies erasures, invalidates restored account sessions and withdraws all restored consent. Confirm erased records are absent before allowing user traffic. Renew consent/sign-in afterward. The utility supports up to 10,000 ledger entries per restore operation; larger ledgers require a reviewed bulk procedure. Remove exported ledgers within the approved 90-day retention window once recovery obligations permit. Provider copies still require separate confirmation.

### Additional live acceptance checks

- Two distinct users/guests in different rooms: direct REST and state API requests must not reveal unrelated data; invalid/expired consent must block requests.
- Start/play/finish every game mode, including buzzer; test mid-game reload, round results, timeout progression, host departure and review. Polling adds up to about one second of game update delay plus network latency; validate actual request load and UX.
- Make an isolated test guest older than 24 hours; prove access is denied, run cleanup, then verify every dependent record and shared-host transfer. Do not age or delete real users for a test.
- Withdraw consent in one browser; another must reject its next API call and show the gate on its next check. Verify export/deletion still work afterward.
- Deliver the same synthetic verified QF event twice in the test database; confirm idempotency. Force a database failure, retry, and prove delivery is not marked complete prematurely.
- Exercise restore suppression on a disposable database, including a newer account which must remain. Do not restore production to test this.
