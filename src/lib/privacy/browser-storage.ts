// Browser-local guest learning data cannot be erased while the browser is
// closed. Enforce its inactivity limit before mounting study/game features.
export const LAST_ACTIVITY = "quranarena_guest_last_activity";
export function clearLearningStorage() {
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (/^(quran|qalamspace|memorization|flashcard|fsrs|sm2)/i.test(key)) storage.removeItem(key);
    }
  }
}
export function touchGuestStorage(now = Date.now()) {
  const last = Number(localStorage.getItem(LAST_ACTIVITY));
  if (last && now - last >= 86400000) clearLearningStorage();
  localStorage.setItem(LAST_ACTIVITY, String(now));
}
export function checkGuestStorage(now = Date.now()) {
  const last = Number(localStorage.getItem(LAST_ACTIVITY));
  if (!last || now - last >= 86400000) touchGuestStorage(now);
}
// The device copy of the signed-in account's scheduler settings: getPreferences
// (flashcard-storage-supabase) writes the account's saved algorithm and FSRS
// parameters into the first two, and the flag marks this browser's own
// settings as uploaded already. Left after sign-out, the next person here
// would study with them, and the next account's sign-in could upload them into
// that account. The account keeps its settings on the server.
const ACCOUNT_SCHEDULER_COPY = ["qalamspace_algorithm", "qalamspace_fsrs_params", "qalamspace_scheduler_prefs_synced"];
/** Called on explicit sign-out, before the browser leaves for the logout route. */
export function forgetAccountSchedulerCopy() {
  for (const key of ACCOUNT_SCHEDULER_COPY) localStorage.removeItem(key);
}
