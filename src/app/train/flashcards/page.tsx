"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  RefreshCw,
  ScrollText,
  Library,
  Type,
  AlertTriangle,
  Flame,
  Settings,
  BarChart3,
  TrendingUp,
  FolderOpen,
  ChevronLeft,
} from "lucide-react";
import { getUnsyncedFlashcardCount, migrateFromLocalStorage, SessionExpiredError } from "@/lib/storage/flashcard-storage-supabase";
import { describeStudyLoad, getHubSummary } from "@/lib/flashcard/session-manager";
import { useAuth } from "@/lib/hooks/useAuth";

function HowItWorksModal({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState(0);
  const totalPages = 4;

  const pages = [
    {
      title: "How it works",
      subtitle: "Understanding your deck and review sessions",
      content: (
        <div className="space-y-4 text-sm text-gray-300">
          <div className="rounded-xl border border-gray-700 bg-gray-800 p-5">
            <div className="mb-2 flex items-center gap-2">
              <BookOpen aria-hidden="true" className="h-5 w-5 text-emerald-400" />
              <p className="font-semibold text-white">Adding words from a Surah</p>
            </div>
            <p className="leading-relaxed">
              When you browse a surah and select a word, it gets added to your{" "}
              <strong className="text-white">single shared deck</strong> — one deck for the entire Quran.
              If the same word appears in multiple surahs, you only learn it once.
              Once a word is in your deck, it won&apos;t show up as &quot;new&quot; again no matter which surah you visit next.
            </p>
          </div>

          <div className="rounded-xl border border-gray-700 bg-gray-800 p-5">
            <div className="mb-2 flex items-center gap-2">
              <RefreshCw aria-hidden="true" className="h-5 w-5 text-emerald-400" />
              <p className="font-semibold text-white">Reviewing a card</p>
            </div>
            <p className="mb-3 leading-relaxed">
              Each card shows the Arabic word on the front. Click the card (or press{" "}
              <kbd className="rounded border border-gray-600 bg-gray-700 px-1.5 py-0.5 text-xs text-gray-200">Space</kbd>
              ) to flip it and see the meaning, root, verb forms, and examples. After flipping, rate
              how well you remembered it — the app uses your rating to decide when to show you the card next.
            </p>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div className="rounded-lg bg-red-500/10 p-3">
                <div className="mb-1 font-bold text-red-400">Forgot</div>
                <div className="text-gray-400">Didn&apos;t remember it — it comes back in a few minutes to relearn</div>
              </div>
              <div className="rounded-lg bg-orange-500/10 p-3">
                <div className="mb-1 font-bold text-orange-400">Hard</div>
                <div className="text-gray-400">Recalled with difficulty — a shorter gap than Got it</div>
              </div>
              <div className="rounded-lg bg-emerald-500/10 p-3">
                <div className="mb-1 font-bold text-emerald-400">Got it</div>
                <div className="text-gray-400">Remembered — the normal next step: minutes apart while a word is new, then days</div>
              </div>
              <div className="rounded-lg bg-blue-500/10 p-3">
                <div className="mb-1 font-bold text-blue-400">Easy</div>
                <div className="text-gray-400">Instant recall — the longest gap; a new word skips straight to days</div>
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      title: "Reference sources",
      subtitle: "Extra context available on every review card",
      content: (
        <div className="space-y-4 text-sm text-gray-300">
          <div className="rounded-xl border border-teal-500/20 bg-teal-500/5 p-5">
            <div className="mb-2 flex items-center gap-2">
              <ScrollText aria-hidden="true" className="h-5 w-5 text-teal-400" />
              <p className="font-semibold text-white">Muyassar Gharib</p>
            </div>
            <p className="leading-relaxed">
              <em className="text-teal-400">Al-Muyassar fi Gharib Al-Quran</em> is a classical Arabic
              scholarly work that explains the meaning of &quot;gharib&quot; (unfamiliar or rare) words in the
              Quran — in Arabic. When enabled on the review card, it shows the scholar&apos;s explanation
              of exactly how that word is used <strong className="text-white">in its specific Quranic context</strong>,
              not just the dictionary meaning. Think of it as a mini-tafsir focused on vocabulary.
              It&apos;s shown in Arabic, so it&apos;s most useful if you have some Arabic reading ability.
            </p>
          </div>

          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
            <div className="mb-2 flex items-center gap-2">
              <Library aria-hidden="true" className="h-5 w-5 text-amber-400" />
              <p className="font-semibold text-white">Hans Wehr Dictionary</p>
            </div>
            <p className="leading-relaxed">
              The <em className="text-amber-400">Hans Wehr Dictionary of Modern Written Arabic</em> is
              one of the most comprehensive Arabic-English dictionaries ever compiled. When enabled, the
              review card pulls the full dictionary entry for the word&apos;s root — showing all derived forms,
              verb patterns (Form II, III, IV…), and the range of meanings the root can carry. Great for
              deepening your understanding beyond the primary translation.
            </p>
          </div>
        </div>
      ),
    },
    {
      title: "A note on Arabic morphology",
      subtitle: "Why basic Sarf knowledge makes a huge difference",
      content: (
        <div className="text-sm text-gray-300">
          <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-5">
            <div className="mb-3 flex items-center gap-2">
              <Type aria-hidden="true" className="h-5 w-5 text-purple-400" />
              <p className="font-semibold text-white">Basic Sarf knowledge helps</p>
            </div>
            <p className="mb-4 leading-relaxed">
              Many morphological duplicates — different conjugated or inflected forms of the same root —
              were intentionally left out of the deck to avoid redundancy. This means a basic familiarity
              with <strong className="text-white">Sarf</strong> (Arabic morphology), particularly verb
              tables, will significantly help you get full value from what you learn here.
            </p>
            <div className="rounded-lg border border-purple-500/20 bg-purple-950/30 p-4 mb-4">
              <p className="mb-3 text-xs font-medium text-purple-300">Example — root ح س ن (to be good / to do good)</p>
              <div dir="rtl" className="font-amiri text-xl text-white leading-loose mb-3">
                إِحْسَان — مُحْسِن — مُحْسِنِين — مُحْسِنُون — أَحْسَنَ — يُحْسِنُ — أَحْسِنْ
              </div>
              <div className="space-y-1 text-xs text-gray-400">
                <div><span className="text-purple-300">Ihsan</span> — excellence / doing good (verbal noun)</div>
                <div><span className="text-purple-300">Muhsin</span> — one who does good (active participle)</div>
                <div><span className="text-purple-300">Muhsineen / Muhsinoon</span> — those who do good (accusative / nominative)</div>
                <div><span className="text-purple-300">Ahsana</span> — he did good (past tense)</div>
                <div><span className="text-purple-300">Yuhsinu</span> — he does good (present tense)</div>
                <div><span className="text-purple-300">Ahsin</span> — do good! (imperative)</div>
              </div>
            </div>
            <p className="leading-relaxed">
              Without knowledge of Sarf, each of these looks like a completely separate word — that is{" "}
              <strong className="text-white">7× the effort</strong> for what is really one root with one
              core meaning. With even a basic grasp of verb tables and pattern recognition, you learn
              the root once and instantly recognise all its forms across the Quran. It is therefore{" "}
              <strong className="text-white">strongly recommended</strong> to study foundational Arabic
              grammar alongside this app to learn as efficiently as possible.
            </p>
          </div>
        </div>
      ),
    },
    {
      title: "Your responsibility",
      subtitle: "Please read before you start memorising",
      content: (
        <div className="text-sm text-gray-300">
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-5">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle aria-hidden="true" className="h-5 w-5 text-rose-400" />
              <p className="font-semibold text-white">Translations may not always be perfect</p>
            </div>
            <p className="mb-4 text-base font-semibold text-rose-300 leading-snug">
              It is your responsibility to verify the meanings you are memorizing before committing them to memory.
            </p>
            <p className="mb-4 leading-relaxed">
              The primary translations shown on the cards are sourced from the{" "}
              <strong className="text-white">Quranic Corpus</strong> — linguistic word-level annotations
              that may occasionally be oversimplified or miss important nuance. If something looks wrong,
              flag it during review to mark it for yourself (flags are saved on this device only), and
              email support@quranarena.ca so it can be corrected for everyone.
            </p>
            <p className="leading-relaxed text-gray-400">
              For the most reliable understanding of a word, treat{" "}
              <strong className="text-teal-400">Muyassar Gharib</strong> as the authority on what a word
              means <em>in its specific Quranic context</em>, and{" "}
              <strong className="text-amber-400">Hans Wehr</strong> as the authority on its broader
              Arabic meaning and usage. These are the sources to trust when the primary translation
              seems off.
            </p>
          </div>
        </div>
      ),
    },
  ];

  const current = pages[page];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4 py-8">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl">
        {/* Header */}
        <div className="shrink-0 px-8 pb-4 pt-8">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex gap-1.5">
              {pages.map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === page
                      ? "w-8 bg-emerald-500"
                      : i < page
                      ? "w-8 bg-emerald-800"
                      : "w-8 bg-gray-700"
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-gray-500">
              {page + 1} / {totalPages}
            </span>
          </div>
          <h2 className="mb-1 text-2xl font-bold text-white">{current.title}</h2>
          <p className="text-sm text-gray-500">{current.subtitle}</p>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-8 py-2">{current.content}</div>

        {/* Footer */}
        <div className="shrink-0 px-8 pb-8 pt-4">
          {page < totalPages - 1 ? (
            <button
              onClick={() => setPage((p) => p + 1)}
              className="w-full rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white transition-all hover:bg-emerald-500"
            >
              Next →
            </button>
          ) : (
            <button
              onClick={onClose}
              className="w-full rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white transition-all hover:bg-emerald-500"
            >
              Got it
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SRExplainerModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-2xl border border-gray-700 bg-gray-900 p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-2xl font-bold text-white">What is Spaced Repetition?</h2>
        <p className="mb-5 text-sm text-gray-500">The science behind how this app helps you memorize Quranic vocabulary</p>

        <div className="space-y-4 text-sm text-gray-300">
          <p>
            <strong className="text-white">Spaced repetition</strong> is a learning technique that shows you
            flashcards at increasing intervals over time — right before you would forget them. By reviewing at the{" "}
            <em>optimal moment</em>, you spend less time studying while retaining more.
          </p>
          <p>
            The key insight is the <strong className="text-white">forgetting curve</strong>: memory decays
            exponentially after learning. If you review just before forgetting, your memory is strengthened and
            the next interval can be longer. Over weeks and months, you build durable long-term memory with
            minimal effort.
          </p>

          <div className="rounded-xl border border-gray-700 bg-gray-800 p-4">
            <p className="mb-2 font-semibold text-white">How ratings work</p>
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <div className="rounded-lg bg-red-500/10 p-3">
                <div className="mb-1 font-bold text-red-400">Forgot</div>
                <div className="text-gray-400">Complete forget — card is re-shown this session and scheduled soon</div>
              </div>
              <div className="rounded-lg bg-orange-500/10 p-3">
                <div className="mb-1 font-bold text-orange-400">Hard</div>
                <div className="text-gray-400">Recalled with difficulty — short interval, easiness decreases</div>
              </div>
              <div className="rounded-lg bg-emerald-500/10 p-3">
                <div className="mb-1 font-bold text-emerald-400">Got it</div>
                <div className="text-gray-400">Correct recall — interval grows normally</div>
              </div>
              <div className="rounded-lg bg-blue-500/10 p-3">
                <div className="mb-1 font-bold text-blue-400">Easy</div>
                <div className="text-gray-400">Instant recall — interval grows quickly</div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-gray-700 bg-gray-800 p-4">
            <p className="mb-3 font-semibold text-white">Algorithms used</p>
            <div className="space-y-3 text-xs">
              <div>
                <span className="font-semibold text-emerald-400">FSRS</span>{" "}
                <span className="text-gray-500">(default)</span> — Free Spaced Repetition Scheduler by Jarrett Ye
                et al. (2022). A state-of-the-art algorithm based on the{" "}
                <em>DSR model</em> (Difficulty, Stability, Retrievability). Significantly outperforms SM-2 in
                predicting the optimal review time.{" "}
                <a
                  href="https://github.com/open-spaced-repetition/ts-fsrs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-400 underline"
                >
                  GitHub
                </a>
              </div>
              <div>
                <span className="font-semibold text-amber-400">Classic</span>{" "}
                <span className="text-gray-500">(SM-2 based)</span> — built on SuperMemo 2 by Piotr Wozniak
                (1987). New and forgotten words get a few short practice steps; after that each word&apos;s
                gap grows by its own ease factor, which your answers nudge up or down. Simpler but less
                accurate than FSRS.{" "}
                <a
                  href="https://www.supermemo.com/en/blog/application-of-a-computer-to-improve-the-results-obtained-in-working-with-the-supermemo-method"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-400 underline"
                >
                  SM-2 (SuperMemo)
                </a>
              </div>
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          className="mt-6 w-full rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white transition-all hover:bg-emerald-500"
        >
          Got it
        </button>
      </div>
    </div>
  );
}

export default function FlashcardsHubPage() {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const [dueCount, setDueCount] = useState(0);
  const [newCount, setNewCount] = useState(0);
  const [totalCards, setTotalCards] = useState(0);
  const [streak, setStreak] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showSRExplainer, setShowSRExplainer] = useState(false);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [loadError, setLoadError] = useState<{ message: string; signIn: boolean } | null>(null);
  const [unsyncedCards, setUnsyncedCards] = useState(0);

  async function loadStats() {
    // One load of each (audit L18).
    const summary = await getHubSummary();
    setDueCount(summary.due);
    setNewCount(summary.newCards);
    setTotalCards(summary.totalCards);
    setStreak(summary.streak);
    setLoading(false);
  }

  useEffect(() => {
    async function initializeAndLoad() {
      try {
        await migrateFromLocalStorage();
        setUnsyncedCards(getUnsyncedFlashcardCount());
        await loadStats();
      } catch (error) {
        console.error("Failed to load flashcards:", error);
        setLoadError(
          error instanceof SessionExpiredError
            ? { message: error.message, signIn: true }
            : { message: "Your flashcards could not be loaded. Please try again.", signIn: false }
        );
        setLoading(false);
        return;
      }
      const seen = localStorage.getItem("flashcard_how_it_works_seen");
      if (!seen) {
        setShowHowItWorks(true);
      }
    }
    initializeAndLoad();
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="text-center">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent"></div>
          <p className="text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  const hasCards = totalCards > 0;
  const studyLoad = describeStudyLoad({ due: dueCount, newCards: newCount });

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 to-gray-900 px-4 py-12">
      {showSRExplainer && <SRExplainerModal onClose={() => setShowSRExplainer(false)} />}
      {showHowItWorks && <HowItWorksModal onClose={() => { localStorage.setItem("flashcard_how_it_works_seen", "1"); setShowHowItWorks(false); }} />}
      <div className="mx-auto max-w-4xl">
        {loadError && (
          <div role="alert" className="mb-6 flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span>
              {loadError.message}{" "}
              {loadError.signIn && (
                <Link href="/login?next=/train/flashcards" className="underline hover:text-red-200">
                  Sign in
                </Link>
              )}
            </span>
          </div>
        )}
        {unsyncedCards > 0 && (
          <div role="status" className="mb-6 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span>
              {unsyncedCards === 1 ? "1 flashcard" : `${unsyncedCards} flashcards`} saved on this device earlier could not be
              added to your account, because their saved data is damaged or their word is no longer in the word list. They are kept on this device and are not in your deck.
            </span>
          </div>
        )}
        {!loadError && !authLoading && !isAuthenticated && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span>
              Your progress is saved on this device only.{" "}
              <Link href="/login?next=/train/flashcards" className="underline hover:text-amber-200">
                Sign in
              </Link>{" "}
              to sync across devices.
            </span>
          </div>
        )}
        <div className="mb-12 text-center">
          <h1 className="mb-3 text-4xl font-bold text-white">
            Ready to learn?
          </h1>
          <p className="mb-4 text-gray-400">
            Master Quranic vocabulary with spaced repetition
          </p>
          <div className="mb-4 flex items-center justify-center gap-3">
            {streak > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/40 bg-orange-500/10 px-4 py-1.5 text-sm font-semibold text-orange-400">
                <Flame aria-hidden="true" className="h-4 w-4" />
                {streak} day streak
              </span>
            )}
            <button
              onClick={() => setShowSRExplainer(true)}
              className="inline-flex items-center gap-2 rounded-full border border-gray-700 bg-gray-800/60 px-4 py-1.5 text-xs text-gray-400 transition-all hover:border-emerald-500/50 hover:text-emerald-400"
            >
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] font-bold">i</span>
              What is spaced repetition?
            </button>
          </div>
        </div>

        {hasCards ? (
          <>
            <div className="mb-8 grid gap-4 sm:grid-cols-2">
              <Link
                href="/train/flashcards/review"
                className="group relative overflow-hidden rounded-3xl border border-emerald-500/30 bg-gradient-to-br from-emerald-600 to-emerald-700 p-8 shadow-xl transition-all hover:scale-105 hover:shadow-2xl hover:shadow-emerald-500/20"
              >
                <div className="absolute right-4 top-4 text-6xl opacity-20">▶</div>
                <div className="relative">
                  <div className="mb-2 text-sm font-medium text-emerald-200">
                    Review Session
                  </div>
                  <div className="mb-4 text-4xl font-bold text-white">
                    {studyLoad.headline}
                  </div>
                  <div className="text-sm text-emerald-100">
                    {studyLoad.detail}
                  </div>
                </div>
              </Link>

              <Link
                href="/train/flashcards/select"
                className="group relative overflow-hidden rounded-3xl border border-blue-500/30 bg-gradient-to-br from-blue-600 to-blue-700 p-8 shadow-xl transition-all hover:scale-105 hover:shadow-2xl hover:shadow-blue-500/20"
              >
                <BookOpen aria-hidden="true" className="absolute right-4 top-4 h-16 w-16 text-white opacity-20" />
                <div className="relative">
                  <div className="mb-2 text-sm font-medium text-blue-200">
                    Learn New Words
                  </div>
                  <div className="mb-4 text-4xl font-bold text-white">
                    Explore Surahs
                  </div>
                  <div className="text-sm text-blue-100">
                    Add words to your deck
                  </div>
                </div>
              </Link>
            </div>

            <div className="mb-8 grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6">
                <div className="mb-2 text-sm text-gray-500">Total Words</div>
                <div className="text-3xl font-bold text-white">{totalCards}</div>
              </div>
              <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6">
                <div className="mb-2 text-sm text-gray-500">New Cards</div>
                <div className="text-3xl font-bold text-blue-400">{newCount}</div>
              </div>
              <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6">
                <div className="mb-2 text-sm text-gray-500">Due Today</div>
                <div className="text-3xl font-bold text-emerald-400">{dueCount}</div>
              </div>
            </div>
          </>
        ) : (
          <div className="mb-8 text-center">
            <Library aria-hidden="true" className="mx-auto mb-6 h-16 w-16 text-gray-700" />
            <h2 className="mb-3 text-2xl font-bold text-white">
              Start Your Journey
            </h2>
            <p className="mb-8 text-gray-400">
              You haven&apos;t added any words yet. Select a surah to begin learning!
            </p>
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
              <Link
                href="/train/flashcards/select"
                className="inline-block rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 px-8 py-4 font-semibold text-white shadow-lg transition-all hover:scale-105 hover:shadow-xl"
              >
                Choose a Surah
              </Link>
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Link
            href="/train/flashcards/settings"
            className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 p-4 transition-all hover:border-gray-700 hover:bg-gray-800"
          >
            <Settings aria-hidden="true" className="h-6 w-6 text-gray-400" />
            <div>
              <div className="font-medium text-white">Settings</div>
              <div className="text-sm text-gray-500">Customize your learning</div>
            </div>
          </Link>
          <Link
            href="/train/flashcards/stats"
            className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 p-4 transition-all hover:border-gray-700 hover:bg-gray-800"
          >
            <BarChart3 aria-hidden="true" className="h-6 w-6 text-gray-400" />
            <div>
              <div className="font-medium text-white">Statistics</div>
              <div className="text-sm text-gray-500">View your progress</div>
            </div>
          </Link>
          <Link
            href="/progress"
            className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 p-4 transition-all hover:border-gray-700 hover:bg-gray-800"
          >
            <TrendingUp aria-hidden="true" className="h-6 w-6 text-emerald-300" />
            <div>
              <div className="font-medium text-white">Global Progress</div>
              <div className="text-sm text-gray-500">See every mode together</div>
            </div>
          </Link>
          <Link
            href="/train/flashcards/browse"
            className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 p-4 transition-all hover:border-gray-700 hover:bg-gray-800"
          >
            <FolderOpen aria-hidden="true" className="h-6 w-6 text-gray-400" />
            <div>
              <div className="font-medium text-white">Browse Deck</div>
              <div className="text-sm text-gray-500">View all your cards</div>
            </div>
          </Link>
          <Link
            href="/train"
            className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 p-4 transition-all hover:border-gray-700 hover:bg-gray-800"
          >
            <ChevronLeft aria-hidden="true" className="h-6 w-6 text-gray-400" />
            <div>
              <div className="font-medium text-white">Back to Training</div>
              <div className="text-sm text-gray-500">Other training modes</div>
            </div>
          </Link>
        </div>

        <div className="mt-8 flex justify-center">
          <button
            onClick={() => setShowHowItWorks(true)}
            className="inline-flex items-center gap-2 rounded-full border border-gray-700 bg-gray-800/60 px-5 py-2 text-sm text-gray-400 transition-all hover:border-gray-600 hover:text-gray-300"
          >
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] font-bold">i</span>
            How does this work?
          </button>
        </div>
      </div>
    </div>
  );
}
