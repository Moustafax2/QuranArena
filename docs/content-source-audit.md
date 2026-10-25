# Content source and cache audit — October 25, 2026

This records repository evidence, not legal permission or QF approval.

## Changes made

- Removed service-worker response/offline caching and added legacy-cache cleanup.
- API responses are private/no-store.
- Replaced indefinite game-question and progress-metadata fetch caching with one-hour revalidation. Added a one-hour in-memory progress-metadata expiry and audio-metadata expiry. Shared QF fetch wrapper caps requested revalidation at one day and prevents unbounded force-cache.
- These are online transient caches, not a Content Sync implementation. Existing deployment caches require invalidation/verification during rollout; do not assume source edits purge every external CDN copy.

## Verified inventory and integrity hashes

The public `/credits` page now provides the source attribution that can be supported by evidence. Hashes
below identify the exact reviewed repository artifacts; a matching name alone is not proof that a future
replacement has the same provenance or permissions.

| Asset/path | Evidence | Outstanding action |
| --- | --- | --- |
| public/data/quranic-corpus-morphology-0.4.txt | SHA-256 `A1D12923815341FACE765083805D2148ED2D9F5CC3F7D6665219D887675D8C46`. Embedded notice names Kais Dukes (2011), GNU GPL, verbatim-copy restriction and required Quranic Arabic Corpus link. It separately names Tanzil Uthmani 1.0.2, CC BY-ND 3.0, with verbatim-copy and attribution terms. The notice remains intact and `/credits` supplies both links. | Keep the source file unmodified, retain its notice, and review any future update as a new artifact. The generated lexical index is a derived work and must preserve the applicable notice. |
| public/data/lexical-db.json | SHA-256 `7D68837AB0BDEB0C2CAEF3CE22493B3B22977EA6902FB7F236AA804D1D5F7F15`. Derived corpus records; scripts/enrich-translations.ts retrieves word translations from api.quran.com and writes the bundle. | **Accepted follow-up:** the file is publicly downloadable and contains QF-derived translations cached indefinitely. Operator decided on October 25, 2026 to track Content Sync/removal as a GitHub issue rather than block this release. This remains a known exception to QF's one-week regular-API cache rule and must not be described as compliant until resolved. |
| data/al-muyassar-fi-al-gharib.json | SHA-256 `11A67C9DFD5539ACF737399E801EB7C8D06E2887E7D473B6539A05B5F5E8CEAA`. Exact hash matches the structured QUL resource 519, Al-Muyassar fi Al-Gharib. The underlying work is attributed to the Quranic Studies Center, published by the King Fahd Complex for the Printing of the Holy Quran in 2012. The artifact has been moved out of `public/` and is exposed only through a feature-specific server lookup. | **Accepted follow-up:** QUL offers the download and documentation for application integration, but its FAQ says resource-specific copyright terms still apply and resource 519 displays no explicit license. Operator decided on October 25, 2026 to proceed while retaining attribution and seek resource-specific confirmation later. |
| data/hanswehr.sqlite | SHA-256 `94E68988BCA0CF9E37D55AFE0D61F09F28F6C175759166B690CB34AF3CF7AA0C`. Operator identified `https://github.com/GibreelAbdullah/HansWehrDictionary` as the source. Its README describes the bundled offline SQLite dictionary, names Hans Wehr/J. Milton Cowan, and credits Jamal Osman and Muhammad Abdurrahman for digitisation and Quran.com for Quranic word breakdown. The artifact has been moved out of `public/` and is exposed only through a root-specific server lookup. | **Accepted follow-up:** the source repository currently displays no license file, so public source availability is not proof of a redistribution license. Operator decided on October 25, 2026 to proceed and seek an explicit license/permission from the repository owner later. Preserve the source attribution and do not call the database open source in legal claims without that evidence. |
| src/lib/data/chapters-data.ts and trivia-questions.json | Static chapter metadata and authored/imported question inventory. | Confirm original sources, attribution and review/update ownership. |
| Supabase game_rounds and learning records | Saved question text/options and user study records support review/progress. | Determine applicable content permissions and correction/expiry policy for retained QF-derived text; user activity retention is not automatically a license for indefinite source-content storage. |
| Remote recitations, avatars, fonts and Mushaf assets | Requests go to external hosts; QF terms contain asset-specific exceptions. | Verify exact hosts/source licenses and cache headers, without assuming an exception applies to all content. |

Current QF terms: https://api-docs.quran.foundation/legal/developer-terms/
QUL resource: https://qul.tarteel.ai/resources/tafsir/519
QUL licensing FAQ: https://qul.tarteel.ai/faq
Hans Wehr source: https://github.com/GibreelAbdullah/HansWehrDictionary
Al-Muyassar bibliographic record: https://quranpedia.net/book/20246
Quranic Arabic Corpus terms: https://corpus.quran.com/download/
Tanzil terms: https://tanzil.net/docs/Text_License

Do not declare the content audit fully cleared or remove data files without a reviewed replacement: several learning features depend on them. Rights/provenance confirmation is an external input, separate from implementing privacy deletion.
