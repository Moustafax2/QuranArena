import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy | QuranArena",
  description: "How QuranArena handles account information, bookmarks, learning progress, and multiplayer activity.",
  robots: { index: false, follow: true },
};

const sections: LegalSection[] = [
  { id: "about", title: "About this policy", content: <>
    <p>QuranArena is an independent Quran reading, vocabulary, memorization, and multiplayer learning application. It uses Quran Foundation (QF) APIs. QF also operates services in the <a href="https://quran.com">Quran.com</a> and <a href="https://quranreflect.com">QuranReflect</a> ecosystem. QuranArena is not an official QF application, and does not currently import your QuranReflect reflections.</p>
    <p>This policy covers information handled by QuranArena. QF account services have their own <a href="https://quran.com/privacy">privacy policy</a>. The legal name of the QuranArena operator and its contact details must be supplied before publication; see <a href="#contact">Contact</a>.</p>
  </> },
  { id: "information", title: "Information used by each feature", content: <>
    <ul>
      <li><strong>Account and authentication:</strong> QF subject identifier, name, email and avatar when supplied by QF, a local player identifier, login timestamps, and access/refresh tokens connect your account and maintain your session. Your QF password is entered on QF’s hosted sign-in page, not collected by QuranArena.</li>
      <li><strong>Reading:</strong> verse bookmarks and creation times let you return to saved passages. Signed-in bookmarks are read from and written to QF; guest bookmarks stay in browser storage. Passage/search requests retrieve Quran text, translations, recitations, images and metadata. Public content retrieval does not import another user’s personal information.</li>
      <li><strong>Training and progress:</strong> selected words or passages, flashcards, review ratings and timing, scheduling state, study preferences, memorization answers and attempts, and derived statistics support review scheduling and your progress dashboard. Guest training data is stored locally; signing in can migrate local training history to your account.</li>
      <li><strong>Multiplayer and social:</strong> guest or account player identifiers, display names, avatars, room membership and presence, answers, scores, wins, friendships, requests and invitations run games and help you find other players. Guest multiplayer also creates server-side records.</li>
      <li><strong>Technical information:</strong> requests necessarily expose network information such as IP address, requested URL and browser headers to the receiving server. Hosting and database services may keep operational or security logs. Their production retention settings still need confirmation.</li>
    </ul>
    <p>Use is limited to the features you authorize. The proposed lawful bases are providing requested services, legitimate interests in security and reliability, compliance with legal duties, and separate explicit consent where sensitive information requires it.</p>
  </> },
  { id: "sensitive-data", title: "Religious information and consent", content: <>
    <p>Saved passages and learning activity can reveal religious beliefs and deserve sensitive-data protection. Before publication, QuranArena must provide a separate, initially unticked opt-in before processing this activity, including local-to-account migration. General acceptance of the Terms is not that consent. The current application does not yet provide this complete consent flow.</p>
    <p>The proposed policy prohibits advertising profiles and selling, mining or repurposing QF user data. Personal content must not train AI models without prior, specific consent. QuranArena’s spaced-repetition scheduling uses study results to choose review times; the current app has no generative-AI chat or reflection-training integration.</p>
  </> },
  { id: "sharing", title: "Who receives information", content: <>
    <p>QF provides identity, authorized account features and Quran content (<a href="https://quran.com/privacy">QF privacy policy</a>). Supabase is used for player, training, game and social records and realtime updates (<a href="https://supabase.com/privacy">Supabase privacy policy</a>). The configured production URL points to Vercel for web hosting (<a href="https://vercel.com/legal/privacy-policy">Vercel privacy policy</a>); the operator must confirm the production provider list and regions.</p>
    <p>Direct content requests to Quran.com, corpus.quran.com, verses.quran.foundation and files.quran.app, as well as remote avatar/audio URLs, expose connection information to those hosts. The operator must verify the ownership and privacy terms of each content host before finalizing this list.</p>
    <p>Other players can see your display name, avatar and relevant game activity. Player search can match account email; the current display-name fallback can also use your email when QF supplies no name. Avoid using a private email as a public name. Friend and invitation recipients see information needed to identify you.</p>
    <p>No advertising or third-party analytics SDK was identified in the current application. Necessary legal disclosures may occur where required by law. Before release, provider contracts must protect personal information, require respect for Islamic content guidelines and prohibit misuse of Quranic text; these contractual arrangements have not yet been verified.</p>
  </> },
  { id: "device-storage", title: "Cookies and device storage", content: <>
    <p>Encrypted, HTTP-only cookies hold QF login and session information. Login transactions expire after 15 minutes; session cookies can last up to 14 days and may be renewed. Guest identifiers and browser session storage support guest games. Local storage retains guest bookmarks, training history and reader/audio preferences until removed. The service worker also caches responses for offline use.</p>
    <p>Use your browser’s site-data controls to clear cookies, local storage and caches on each device. This may remove unsynced progress and sign you out. It does not delete server records or QF bookmarks. Shared-device users should clear site data after use.</p>
  </> },
  { id: "security", title: "Security and incidents", content: <>
    <p>The implementation encrypts QF session cookies and keeps server credentials outside client code. The proposed production standard is TLS 1.2+, encrypted storage/backups, least-privilege access and secret rotation every 90 days and immediately after suspected compromise. Hosting controls, access reviews and this rotation schedule require operational verification.</p>
    <p>Under QF’s Security Rule 6.9 reference and developer security requirements, the proposed incident procedure starts in less than 24 hours and reports suspected or actual API-related unauthorized access, breaches or exposure to <a href="mailto:developers@quran.com">developers@quran.com</a> within 24 hours of discovery. A responsible operator and monitoring process must be assigned. Affected users and authorities must also be notified when applicable law requires it. No system can guarantee absolute security.</p>
  </> },
  { id: "choices", title: "Access, correction and permissions", content: <>
    <p>You can review your profile on the <Link href="/account">account page</Link>, remove individual <Link href="/quran/bookmarks">bookmarks</Link>, and manage <Link href="/friends">friends</Link>. Correct QF identity information through QF. Removing a synced bookmark changes it in your QF account too.</p>
    <p>Signing out ends the app session and starts QF’s logout flow. Account deletion and revocation of a continuing authorization are separate actions. QF’s <a href="https://oauth2.quran.foundation/oauth2/revoke">OAuth token revocation endpoint</a> is a technical POST endpoint, not a one-click web form; never paste tokens into a URL. An in-app disconnect/permission-management flow remains to be implemented. You may decline requested permissions during QF authorization where offered; dependent features may be unavailable.</p>
    <p>The intended privacy-request process covers copies, correction, deletion, portability, restriction, objections and withdrawal of consent, with a response within 30 days. You may also complain to your local data-protection authority. A verified contact channel is still required below.</p>
  </> },
  { id: "delete-my-data", title: "Delete My Data and retention", content: <>
    <p>There is currently no account-wide deletion button or configured privacy-request inbox. Individual bookmark removal and flashcard reset do not erase all player, game, invitation or memorization records. Do not treat signing out or clearing your browser as an account-deletion request.</p>
    <p>Before release, the operator must enable an authenticated deletion route or verified request channel. Proposed limits: retain account data only while the account is active; complete permanent live-data deletion within 30 days of a verified request and backup removal within 90 days. Deleting a main QF account must also trigger removal of associated QuranArena data. These processes, guest/log retention periods and backup expiry need implementation and confirmation.</p>
  </> },
  { id: "children", title: "Children’s privacy", content: <p>The proposed minimum age is 13, or a higher age required locally, subject to operator confirmation. QuranArena is not intended for users below that threshold. Before release, sign-up must block users known to be underage and a process must remove inadvertently collected information. The current sign-in screen does not verify age. Parents should supervise eligible minors’ multiplayer activity.</p> },
  { id: "transfers", title: "International processing", content: <p>Your information may be processed outside your country by QF and the application’s providers. Production storage locations have not yet been confirmed. Before cross-border processing, the operator must establish applicable safeguards, such as Standard Contractual Clauses or an equivalent recognized transfer mechanism, and meet local privacy and transfer requirements. This draft does not assert that those agreements are already in place.</p> },
  { id: "updates", title: "Changes to this policy", content: <p>The published policy will show its effective and revision dates. Material changes will be announced in the app before taking effect and, where appropriate, by email. A new use requiring consent must obtain that consent first. The notice and consent-version process must be completed before publication.</p> },
  { id: "contact", title: "Contact", content: <>
    <ul>
      <li>Legal operator: [LEGAL OPERATOR NAME]</li>
      <li>Privacy and support email: [PRIVACY EMAIL]</li>
      <li>Public mailing address: [MAILING ADDRESS]</li>
    </ul>
    <p>A working contact and deletion-request channel must replace these placeholders before this draft becomes effective. QF’s developer incident mailbox above is for API security reports; it is not QuranArena’s customer-support or deletion inbox.</p>
  </> },
];

export default function PrivacyPage() {
  return <LegalPage title="Privacy Policy" description="What QuranArena stores, why each feature needs it, and how you can control your information." sections={sections} />;
}
