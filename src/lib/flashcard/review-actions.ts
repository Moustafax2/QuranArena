/**
 * Runs one review-page action (saving a rating, or undoing one) at a time.
 * Returns false, without running it, if another action holds the lock, so a
 * double key press or a "Z" during a save can't race it.
 */
export async function runExclusive(lock: { current: boolean }, action: () => Promise<void>): Promise<boolean> {
  if (lock.current) return false;
  lock.current = true;
  try {
    await action();
  } finally {
    lock.current = false;
  }
  return true;
}
