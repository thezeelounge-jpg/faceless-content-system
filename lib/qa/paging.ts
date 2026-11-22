// p5-b4 (QA SF3): read EVERY matching row from Supabase. PostgREST answers at most its
// `max-rows` (1000 by default) per request and says nothing when it cuts an answer short, so a
// plain `.limit(20_000)` silently loses rows. readAllPages asks for one page at a time with
// `.range(from, to)` and moves on by the number of rows it got, until a page comes back EMPTY
// (so even a server cap smaller than PAGE_SIZE can't cut it short). The query must have a stable
// order (e.g. `.order("id")`), else rows could move between pages.
//
// Long id lists are split (inChunks) so a `.in()` filter never makes a too-long URL.

/** Rows asked for per request (PostgREST's default max-rows). */
export const PAGE_SIZE = 1000;
/** Ids per `.in()` request (36-character uuids keep the URL far under common limits). */
export const ID_CHUNK = 100;
/** A runaway guard: no loader here should ever read this many pages. */
const MAX_PAGES = 1000;

type Answer<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export async function readAllPages<T>(page: (from: number, to: number) => Answer<T>, onError: (error: { message: string }) => never): Promise<T[]> {
  const rows: T[] = [];
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const { data, error } = await page(rows.length, rows.length + PAGE_SIZE - 1);
    if (error) onError(error);
    const got = data ?? [];
    if (got.length === 0) return rows;
    rows.push(...got);
  }
  return onError({ message: `more than ${MAX_PAGES * PAGE_SIZE} rows` });
}

/** readAllPages for each slice of `ids` (ID_CHUNK at a time); the rows of every slice, in order. */
export async function readAllPagesIn<T>(
  ids: string[],
  page: (slice: string[], from: number, to: number) => Answer<T>,
  onError: (error: { message: string }) => never,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const slice = ids.slice(i, i + ID_CHUNK);
    rows.push(...(await readAllPages((from, to) => page(slice, from, to), onError)));
  }
  return rows;
}
