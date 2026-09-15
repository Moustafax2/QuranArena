import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service | QuranArena",
  description: "Terms for reading, training, and playing with QuranArena.",
  robots: { index: false, follow: true },
};

const sections: LegalSection[] = [
  { id: "service", title: "The service and these terms", content: <>
    <p>These proposed Terms of Service (Terms of Use) govern QuranArena’s reader, audio, vocabulary flashcards, memorization exercises, progress dashboard and multiplayer/social features. The legal operator must be identified before the terms take effect. This draft is provided for review and does not itself create an agreement.</p>
    <p>QuranArena independently uses Quran Foundation APIs. Quran Foundation, Quran.com and QuranReflect do not operate or endorse QuranArena merely by making those APIs available. QF account use is separately governed by <a href="https://quran.com/terms-and-conditions">Quran.com’s terms</a>.</p>
  </> },
  { id: "eligibility", title: "Eligibility and accounts", content: <p>The proposed minimum age is 13 or the higher age required by local law; the operator must confirm it before publication. Eligible minors should use the app with permission from a parent or guardian. Keep account information accurate, protect your device and account, and do not impersonate others. QF authenticates your connected account. Guest games also create player records. Report unauthorized account use through the contact channel once it is established.</p> },
  { id: "privacy", title: "Privacy and connected features", content: <>
    <p>The <Link href="/privacy">Privacy Policy</Link> explains account information, learning history, cookies and social visibility. Agreement to these terms does not replace separate consent for sensitive religious data or authorize unrelated processing.</p>
    <p>Connecting QF enables the permissions you authorize. Synced bookmark changes affect your QF account. Signing in may transfer guest learning history to your account. Other players can see relevant profile and game information; do not include confidential information in your public display name. You can stop using connected features, sign out, or seek deletion as described in the policy.</p>
  </> },
  { id: "conduct", title: "Respectful and permitted use", content: <ul>
    <li>Use the service for lawful learning and fair play. Do not harass, threaten, impersonate, spam, cheat or disrupt others.</li>
    <li>Treat Quranic material respectfully. Do not change Quran text or present excerpts misleadingly. Do not combine it with hate, extremism, unlawful or sexually inappropriate content.</li>
    <li>Do not bypass authentication, permissions or rate limits, exploit vulnerabilities, or collect other players’ information without authorization.</li>
    <li>Do not extract QF content or raw API responses into a dataset, feed or redistribution service without the necessary written rights. Do not use content or user information for unauthorized advertising profiles or machine-learning training.</li>
  </ul> },
  { id: "content", title: "Content and ownership", content: <>
    <p>Quran text, translations, recitations, images, fonts and other materials remain subject to their respective rights and source licenses. Access to QuranArena grants permission to use its supported features; it does not transfer ownership or grant rights to sell or sublicense third-party materials. Source-specific and open-source licenses continue to apply.</p>
    <p>You retain any rights in information you contribute. You give the operator only the permission needed to store, process and display it for the features you request, subject to the Privacy Policy. This does not grant a general right to sell personal data or train AI on your content.</p>
  </> },
  { id: "learning", title: "Learning tools and accuracy", content: <p>Exercises, generated questions, translations, vocabulary analyses, review schedules and scores are learning aids. They can contain mistakes and do not certify memorization, religious knowledge or spiritual standing. Consult authoritative sources and qualified teachers for interpretation and religious guidance. Please report content errors once the support contact is available.</p> },
  { id: "availability", title: "Availability and changes", content: <p>Features depend on your connection and external services, including QF and Supabase. The operator may maintain, change or discontinue features, or restrict access to address abuse, security concerns or legal requirements. Reasonable notice should be provided where feasible. Local progress can be lost if browser data is cleared; signing out does not erase server-side information. The current app has no payment or subscription checkout; any future paid offering must disclose its own price and terms before purchase.</p> },
  { id: "liability", title: "Disclaimers and your legal rights", content: <p>To the extent permitted by applicable law, the service is provided as available without a promise of uninterrupted operation, error-free content or a particular learning outcome. The operator is not responsible for losses caused solely by events outside its reasonable control. Nothing in these terms excludes liability that cannot legally be excluded or limits mandatory consumer or privacy rights. No governing jurisdiction, arbitration requirement or financial liability cap has been selected in this draft.</p> },
  { id: "ending", title: "Ending use and resolving concerns", content: <p>You may stop using QuranArena at any time. Account restrictions do not remove your privacy rights. See <Link href="/privacy#delete-my-data">Delete My Data and retention</Link> for the current deletion limitations and proposed process. The final operator identity, contact channel and applicable jurisdiction must be confirmed before publication so that users can raise and resolve concerns.</p> },
  { id: "changes", title: "Updates and contact", content: <p>Final terms will display an effective date. Material changes should be communicated in the app before they take effect, with fresh acceptance where required. Operator and contact details are listed in <Link href="/privacy#contact">Contact</Link>; those details remain pending for this draft.</p> },
];

export default function TermsPage() {
  return <LegalPage title="Terms of Service" description="The proposed rules for using QuranArena and learning together respectfully." sections={sections} />;
}
