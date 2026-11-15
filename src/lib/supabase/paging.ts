// PostgREST returns at most `max_rows` rows per request (1000 in
// supabase/config.toml and on hosted Supabase), and says nothing when it cuts
// a result short (audit M4). These helpers read past that cap.

/** Must not exceed the API's max_rows: a page shorter than this ends the read. */
export const PAGE_SIZE = 1000;

/** Ids per `.in()` filter. Every id goes into the request URL. */
export const IN_CHUNK_SIZE = 100;

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/**
 * Reads every page of a query. `page(from, to)` must apply `.range(from, to)`
 * to a query ordered by a unique key (add `id` as a tie-breaker), or rows can
 * repeat or go missing between pages. Any error is thrown, so a failed page
 * never passes for a short result.
 */
export async function fetchAllPages<T>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

/** Runs `query` once per chunk of `ids` and concatenates the rows. Any error is thrown. */
export async function fetchInChunks<T>(ids: string[], query: (chunk: string[]) => PageResult<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    const { data, error } = await query(ids.slice(i, i + IN_CHUNK_SIZE));
    if (error) throw error;
    rows.push(...(data ?? []));
  }
  return rows;
}
