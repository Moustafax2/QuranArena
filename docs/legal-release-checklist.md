# Privacy and terms release checklist

Updated October 25, 2026. Changes are local, pending migration/deployment and live validation. Public legal pages are marked effective October 25, 2026 and are indexable once deployed.

## Confirmed facts

- Operator and support/privacy inbox owner: Abdullah Amin. Public contact support@quranarena.ca. The private forwarding destination and personal email are not published or committed.
- Authorized postal address: 142 Breton Avenue, Mississauga, Ontario L4Z 4K4, Canada.
- Official domain https://www.quranarena.ca/; age 13+, subject to local requirements.
- Supabase Free, primary DB North Virginia us-east-1. Dashboard shows no backups; developers confirm no downloaded backups/user exports/copies. Provider-internal retention is not established by this.
- Vercel Hobby; teammate confirms production uses Washington, D.C. iad1 and no log drains/external logging. CDN/support/log processing may differ from function region.
- Mail sent to support@quranarena.ca is forwarded to the private Proton Mail inbox monitored by Abdullah Amin. Manual mail handling/retention and backup coverage still need operational confirmation.
- No third-party audience analytics or generative-AI integration found in application source; user-facing learning statistics are processed internally.
- Guest retention approved: 24 hours of inactivity. Operator will provide security/backup-inbox coverage later and contact QF for missing integration details.

## Implemented

- Separate age and sensitive-data choices, versioned receipts, server enforcement, account-wide withdrawal of existing linked receipts. Other clients check consent every 30 seconds and on focus; API enforcement applies on every request. Browser-local data on other devices must be cleared there.
- Verified guest cookies, 24-hour inactivity checks and transactional cleanup. Scheduled purge runs every 15 minutes once installed; actual erasure can follow expiry by that interval or longer during an outage. Browser-local guest learning data is cleared on the next check after inactivity; closing a browser cannot trigger guaranteed erasure.
- Export, transactional app deletion, optional bookmark permission, QF token revocation and session invalidation.
- A transport-independent QF deletion adapter with atomic delivery-ID deduplication; no unauthenticated public deletion webhook. Future QF event verification feeds this adapter.
- Restricted erasure ledger and tested restore suppression RPC/tool. Ledger must be preserved outside an older backup before restoration. No external copies created by this work.
- Multiplayer reads through membership-checked server routes; public table/column access revoked by migration 010. Public game broadcasts removed. Active answer keys/future questions excluded; answer review returns only the requesting player's answers. Synchronization uses authenticated polling (1-second game / 2-second room intervals), with corresponding latency and request load to assess in live testing.
- Server-only Edge authorization, same-origin writes, no-store API responses, cleanup of legacy service-worker caches, no email fallback/search. Bounded previously indefinite content caches.
- Unlinked consent receipts retained up to one year, withdrawn receipts 30 days, minimal erasure ledger/delivery IDs 90 days; scheduler performs removal. No religious activity is retained in the erasure ledger.

## Remaining before final release

1. Apply migrations 009 then 010; enable Cron and run `supabase/operations/schedule-privacy-cleanup.sql`. Configure matching MULTIPLAYER_SERVER_SECRET in Vercel and Edge and deploy the app plus all six functions together. New app must not run against the old schema/functions.
2. Verify configured callback/domain in Vercel and QF; run the two-user/two-room prelive and live test plan in `privacy-operations.md`. Test guard failures, polling latency, timed rounds, buzzer mode, account switching, deletion, consent expiry and provider outages. No hosted migration or destructive live test has been performed.
3. Get QF's notification/reconciliation contract, implement signature/authentication + issuer/client subject mapping and wire it to `purgeVerifiedQfAccount`. Don't infer deletion from an expired token. Until then deletion is available through app controls/verified support only.
4. Confirm provider DPAs, transfer safeguards, internal log/backup retention, encryption/access controls and rotation. Plan/region screenshots don't prove contractual coverage. Restore process must be adopted and tested in hosted infrastructure; 90-day provider backup deletion cannot be enforced by app SQL.
5. Assign incident responders/backup inbox coverage; approve support-mail and provider-log retention and request verification procedures. These are operational tasks, not solved by adding policy text.
6. Track the three accepted content follow-ups in `content-source-audit.md`: migrate the public lexical bundle to QF Content Sync or remove its QF-derived translations; obtain resource-specific Al-Muyassar confirmation; obtain an explicit license/permission for the Hans Wehr database. Provenance and public attribution are now recorded, and the two server-only sources are no longer directly downloadable. These are acknowledged risks, not verified permissions.

## Verification

Local regression suites cover ownership, consent failure, origin checks, revocation partial failure, membership denial, invite redaction, active/future answer-key filtering, guest TTL, all-linked-receipt withdrawal, deletion rollback/cascades, provider-event retries and restore suppression. Embedded PostgreSQL tests do not validate hosted settings or realtime-provider behavior. Run npm test, the PGlite SQL suite, TypeScript, changed-file lint and production build before pushing.

Sources: [QF privacy](https://api-docs.quran.foundation/legal/developer-privacy/), [QF terms](https://api-docs.quran.foundation/legal/developer-terms/), [Supabase Cron](https://supabase.com/docs/guides/cron/quickstart).
