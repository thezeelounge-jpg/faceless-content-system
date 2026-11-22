// p5-b3: a stand-in for the Supabase client that can only READ. Any write (insert, update, upsert,
// delete), any rpc and any storage call throws, and every call is recorded, so a test can prove a
// loader never writes. Each `from(table)` answers with `tables[table]` (filters are recorded, not
// applied: the test data is already what the query would return).
//
// p5-b4 (QA SF3): `maxRows` acts like PostgREST's row cap: `.range(a, b)` returns rows a..b of the
// table, and no answer ever holds more than `maxRows` rows (a `.limit()` above it is ignored, as
// PostgREST's max-rows does). `.range()` is always applied; `.in()` filters only with `maxRows`.

export type DbCall = { table: string; op: string; args: unknown[] };

export function readOnlyDb(tables: Record<string, unknown[]>, options: { maxRows?: number } = {}) {
  const calls: DbCall[] = [];
  const forbidden = (what: string) => () => {
    throw new Error(`read-only db: ${what} is not allowed`);
  };
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    let range: [number, number] | null = null;
    const inFilters: [string, unknown[]][] = [];
    for (const op of ["select", "eq", "neq", "in", "is", "gte", "lte", "gt", "lt", "order", "limit", "range", "not"]) {
      b[op] = (...args: unknown[]) => {
        calls.push({ table, op, args });
        if (op === "range") range = [Number(args[0]), Number(args[1])];
        if (op === "in") inFilters.push([String(args[0]), args[1] as unknown[]]);
        return b;
      };
    }
    for (const op of ["insert", "update", "upsert", "delete"]) b[op] = forbidden(`${op} on ${table}`);
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      let rows = tables[table] ?? [];
      if (options.maxRows !== undefined) {
        // With a row cap, `.in(column, values)` is applied too (loaders split long id lists).
        for (const [column, values] of inFilters) rows = rows.filter((r) => values.includes((r as Record<string, unknown>)[column]));
      }
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (options.maxRows !== undefined) rows = rows.slice(0, options.maxRows);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    };
    return b;
  }
  const db = {
    from: (table: string) => builder(table),
    rpc: forbidden("rpc"),
    storage: { from: forbidden("storage") },
  };
  return { db, calls };
}
