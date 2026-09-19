# Privacy and terms release checklist

Reviewed September 15, 2026. `/privacy` and `/terms` are public, unauthenticated draft routes. They deliberately retain a draft notice and `noindex` until the facts and controls below are verified. Footer, login and account links expose them. No deployment or QF approval is implied.

## Inputs still needed

- Replace `[LEGAL OPERATOR NAME]`, `[PRIVACY EMAIL]` and `[MAILING ADDRESS]` in the privacy contact section. The owner explicitly requested placeholders for now.
- Confirm minimum age (draft proposes 13; Quran.com's own terms use 18), operator jurisdiction, production domain, effective date and responsible privacy/security contact.
- Confirm Vercel hosting, Supabase project regions, operational logs, backup expiry and all other production processors. Identify privacy terms/ownership for external content and avatar hosts, including files.quran.app. Do not infer signed contracts from an SDK or hosting URL.
- Verify provider DPAs, Islamic-content contractual restrictions and international transfer safeguards. Confirm the proposed 90-day secret rotation cadence and emergency rotation owner.

## Requirements that wording cannot implement

| Area | Evidence in this repository | Release action |
| --- | --- | --- |
| Sensitive-data consent | Guest bookmarks/training persist in browser storage; signed-in training can migrate to Supabase. Login has no separate religious-data consent. | Add separate unticked affirmative consent before relevant processing for guests and accounts, with versioned evidence, withdrawal and server enforcement. Do not equate accepting terms or OAuth scopes with that consent. |
| Deletion and rights | Bookmark removal and flashcard reset exist; account-wide deletion/export does not. | Provide a verified request inbox or authenticated screen; implement access/correction/export, live erasure within 30 days, backup expiry within 90 days, and removal following QF account deletion. Cover friends, invites, rooms, results, reviews and memorization records; define guest/log retention. Test restoration does not resurrect deleted records. |
| Revocation | Logout clears cookies and uses QF end-session; no separate disconnect/permission UI. | Implement and test revocation with the configured issuer's discovery endpoint, including refresh-token invalidation. The public policy's production revocation link is a POST API, not a browser action. Test prelive and production separately. |
| Children | No age check in current login. | Confirm age and block detected underage enrollment; define handling/removal of underage data. |
| Storage and access | AES-GCM session cookies and production secure flags exist. Infrastructure settings are not proven by code. | Verify TLS 1.2+, database/backup encryption, least-privilege service access, RLS/realtime permissions, rotation and access reviews. |
| Offline cache | `public/sw.js` caches every successful GET, including potentially account/API responses, without expiry. | Scope offline caching to safe public assets, exclude private/API/auth responses, purge legacy caches, enforce QF content caching limits and test account switching/offline behavior. |
| Identity visibility | `user-profile.ts` falls back to email for display name; friend search can match email. | Confirm intended discoverability, remove accidental email exposure or obtain appropriate disclosure/choice. |
| Incidents | No demonstrated monitoring/on-call process. | Assign owner; begin response in less than 24 hours and notify developers@quran.com of suspected/actual API incidents within 24 hours of discovery. Record timeline, contain exposure, rotate affected secrets and apply legally required user/regulator notices. Never include live tokens in reports. |
| Changes | No versioned legal notice/acceptance system. | Add in-app material-change notices and obtain fresh consent for changed sensitive-data purposes. |

## Final publication

After the above is verified, replace proposed/unverified language with accurate approved practices, remove the draft notice and `noindex`, and set a real effective date in `LegalPage.tsx`. Have qualified counsel review the final terms against the operator's jurisdiction and audience. Verify both routes over the public HTTPS deployment without a login and use those URLs in the QF application registration. Do not claim QF certification.

## Sources

- [QF developer privacy requirements](https://api-docs.quran.foundation/legal/developer-privacy/)
- [QF developer terms, including section 3.2](https://api-docs.quran.foundation/legal/developer-terms/)
- [Quran.com privacy](https://quran.com/privacy)
- [Quran.com terms](https://quran.com/terms-and-conditions)
- [QF revocation endpoint example](https://api-docs.quran.foundation/docs/tutorials/oidc/mobile-apps/react-native/)
- [QF logout semantics](https://api-docs.quran.foundation/docs/oauth2_apis_versioned/revoke-oidc-session/)
- Tazkiya's requested home/privacy URLs returned no readable content in web retrieval; browser navigation timed out. No claims or text were copied from that unavailable policy.
