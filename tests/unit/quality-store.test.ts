import { describe, expect, it } from "vitest";
import { loadQualityInput } from "@/lib/qa/quality-store";
import { readOnlyDb } from "@/tests/helpers/read-only-db";

// p5-b3: the Quality page's server-side query (service role, after requireAdmin). Read only;
// filtered to the range; real spend only (mock rows never count).

const RANGE = { from: new Date("2026-11-01T00:00:00.000Z"), to: new Date("2026-11-22T23:59:59.999Z") };

describe("loadQualityInput", () => {
  it("reads reports, delivered videos (+ the post's first render request), real HeyGen render spend and Claude spend in the range", async () => {
    const { db, calls } = readOnlyDb({
      qa_reports: [{ gate: "audio", passed: true, auto_fix: null, issues: [], created_at: "2026-11-20T09:00:00Z", video_id: "v1" }],
      videos: [
        { id: "v2", post_id: "p1", delivered_at: "2026-11-20T11:00:00Z", created_at: "2026-11-20T10:00:00Z" },
        { id: "v1", post_id: "p1", delivered_at: null, created_at: "2026-11-20T09:00:00Z" },
      ],
      provider_usage: [{ cost_usd: "2.5000" }, { cost_usd: "1.0000" }],
      ai_usage: [{ cost_usd: "0.0100" }],
    });
    const input = await loadQualityInput(db as never, RANGE);
    expect(input.reports).toHaveLength(1);
    expect(input.spend).toEqual({ heygen_usd: 3.5, claude_usd: 0.01 });
    expect(input.delivered).toEqual([{ id: "v2", delivered_at: "2026-11-20T11:00:00Z", started_at: "2026-11-20T09:00:00Z" }]);

    const on = (table: string, op: string) => calls.filter((c) => c.table === table && c.op === op).map((c) => c.args);
    expect(on("qa_reports", "gte")).toContainEqual(["created_at", RANGE.from.toISOString()]);
    expect(on("qa_reports", "lte")).toContainEqual(["created_at", RANGE.to.toISOString()]);
    expect(on("provider_usage", "eq")).toEqual(
      expect.arrayContaining([["provider", "heygen"], ["kind", "render"], ["mock", false], ["status", "succeeded"]]),
    );
    expect(on("videos", "gte")).toContainEqual(["delivered_at", RANGE.from.toISOString()]);
    // Columns are named, never "*".
    for (const c of calls.filter((x) => x.op === "select")) expect(String(c.args[0])).not.toContain("*");
  });

  it("p5-b4 (Rowan 7): time to Ready starts at scripts.approved_at; old rows without it fall back to the post's first Make video", async () => {
    const { db } = readOnlyDb({
      qa_reports: [],
      videos: [
        { id: "v1", post_id: "p1", script_id: "s1", delivered_at: "2026-11-20T11:00:00Z", created_at: "2026-11-20T10:00:00Z" },
        { id: "v2", post_id: "p2", script_id: "s2", delivered_at: "2026-11-20T12:00:00Z", created_at: "2026-11-20T09:30:00Z" },
      ],
      scripts: [
        { id: "s1", approved_at: "2026-11-20T08:00:00Z" },
        { id: "s2", approved_at: null },
      ],
      provider_usage: [],
      ai_usage: [],
    });
    const input = await loadQualityInput(db as never, RANGE);
    expect(input.delivered).toEqual([
      { id: "v1", delivered_at: "2026-11-20T11:00:00Z", started_at: "2026-11-20T08:00:00Z" },
      { id: "v2", delivered_at: "2026-11-20T12:00:00Z", started_at: "2026-11-20T09:30:00Z" },
    ]);
  });

  it("p5-b4 (QA SF3): pages through every table, so a 1000-row cap per answer never cuts the numbers short", async () => {
    const n = (count: number) => Array.from({ length: count }, (_, i) => i);
    const { db, calls } = readOnlyDb(
      {
        qa_reports: n(2500).map((i) => ({ gate: "audio", passed: i % 2 === 0, auto_fix: null, issues: [], created_at: "2026-11-20T09:00:00Z", video_id: `v${i}` })),
        videos: n(1500).map((i) => ({ id: `v${i}`, post_id: `p${i}`, delivered_at: "2026-11-20T11:00:00Z", created_at: "2026-11-20T10:00:00Z" })),
        provider_usage: n(2300).map(() => ({ cost_usd: "1.0000" })),
        ai_usage: n(1200).map(() => ({ cost_usd: "0.0100" })),
        scripts: [],
      },
      { maxRows: 1000 },
    );
    const input = await loadQualityInput(db as never, RANGE);
    expect(input.reports).toHaveLength(2500);
    expect(input.delivered).toHaveLength(1500);
    expect(input.spend).toEqual({ heygen_usd: 2300, claude_usd: 12 });
    // Every started_at was found (the per-post lookups paged / split too).
    expect(input.delivered.every((d) => d.started_at === "2026-11-20T10:00:00Z")).toBe(true);
    // Paging needs a stable order on every paged query.
    expect(calls.some((c) => c.op === "range")).toBe(true);
  });

  it("never writes (any insert/update/delete/rpc would throw)", async () => {
    const { db, calls } = readOnlyDb({});
    await expect(loadQualityInput(db as never, RANGE)).resolves.toBeDefined();
    expect(calls.every((c) => !["insert", "update", "upsert", "delete"].includes(c.op))).toBe(true);
  });
});
