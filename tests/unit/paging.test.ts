import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { ID_CHUNK, readAllPages, readAllPagesIn } from "@/lib/qa/paging";
import { readOnlyDb } from "@/tests/helpers/read-only-db";

// p5-b4 (QA SF3): every row, whatever the server's row cap.
const fail = (e: { message: string }): never => {
  throw new Error(e.message);
};

describe("readAllPages", () => {
  it("a server cap SMALLER than our page size still returns every row (stops only on an empty page)", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => ({ id: i }));
    const db = readOnlyDb({ t: rows }, { maxRows: 300 }).db as unknown as SupabaseClient;
    const got = await readAllPages<{ id: number }>((a, b) => db.from("t").select("id").order("id").range(a, b) as never, fail);
    expect(got.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("an error stops it with the loader's message", async () => {
    await expect(readAllPages(() => Promise.resolve({ data: null, error: { message: "boom" } }), fail)).rejects.toThrow("boom");
  });

  it("readAllPagesIn splits long id lists into slices of ID_CHUNK", async () => {
    const ids = Array.from({ length: ID_CHUNK * 2 + 5 }, (_, i) => `v${i}`);
    const fake = readOnlyDb({ t: ids.map((id) => ({ id })) }, { maxRows: 1000 });
    const db = fake.db as unknown as SupabaseClient;
    const calls = fake.calls;
    const got = await readAllPagesIn<{ id: string }>(ids, (slice, a, b) => db.from("t").select("id").in("id", slice).range(a, b) as never, fail);
    expect(got.map((r) => r.id)).toEqual(ids);
    const slices = calls.filter((c) => c.op === "in").map((c) => (c.args[1] as string[]).length);
    expect(Math.max(...slices)).toBe(ID_CHUNK);
  });
});
