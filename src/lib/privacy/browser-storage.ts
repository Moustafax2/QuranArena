// Browser-local guest learning data cannot be erased while the browser is
// closed. Enforce its inactivity limit before mounting study/game features.
const LAST_ACTIVITY = "quranarena_guest_last_activity";
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
