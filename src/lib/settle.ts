export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs `work` and reports how it ended. The returned promise never rejects,
 * even when `work` throws synchronously.
 *
 * Components use it in place of try/finally (A4 review #10). The React
 * Compiler lint skips a whole component that has try/finally, or a
 * conditional inside a try block. With `await settle(...)` the line after it
 * always runs, so `setBusy(false)` placed there is reset on every exit path,
 * and the component is still checked.
 */
export async function settle<T>(work: () => Promise<T> | T): Promise<Settled<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}
