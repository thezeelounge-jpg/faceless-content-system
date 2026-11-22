// p5-b3: a stand-in for the Supabase client that can only READ. Any write (insert, update, upsert,
// delete), any rpc and any storage call throws, and every call is recorded, so a test can prove a
// loader never writes. Each `from(table)` answers with `tables[table]` (filters are recorded, not
// applied: the test data is already what the query would return).

export type DbCall = { table: string; op: string; args: unknown[] };

export function readOnlyDb(tables: Record<string, unknown[]>) {
  const calls: DbCall[] = [];
  const forbidden = (what: string) => () => {
    throw new Error(`read-only db: ${what} is not allowed`);
  };
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    for (const op of ["select", "eq", "neq", "in", "is", "gte", "lte", "gt", "lt", "order", "limit", "range", "not"]) {
      b[op] = (...args: unknown[]) => {
        calls.push({ table, op, args });
        return b;
      };
    }
    for (const op of ["insert", "update", "upsert", "delete"]) b[op] = forbidden(`${op} on ${table}`);
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject);
    return b;
  }
  const db = {
    from: (table: string) => builder(table),
    rpc: forbidden("rpc"),
    storage: { from: forbidden("storage") },
  };
  return { db, calls };
}
