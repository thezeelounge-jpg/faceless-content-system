import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QualityTable } from "@/components/admin/quality-table";
import { QUALITY } from "@/lib/qa/config";
import { computeQuality, parseQualityRange, type QualityReport } from "@/lib/qa/quality";

// p5-b3: Admin → Usage and spend → Quality (QA-SPEC "Metrics"): first-time pass rate per gate,
// automatic fix success rate, human reject rate, customer redo rate, average cost per delivered
// video, time from approval to Ready, top 5 failure codes this week.

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();
let n = 0;
const report = (gate: string, passed: boolean, opts: Partial<QualityReport> = {}): QualityReport => ({
  gate,
  passed,
  auto_fix: null,
  issues: [],
  created_at: at(20),
  ...opts,
  video_id: opts.video_id ?? `v${n++}`,
});
const many = (count: number, make: () => QualityReport) => Array.from({ length: count }, make);
const issue = (code: string) => [{ code, detail: "x", severity: "hard" }];

// Seed: gates 1-6 with known first-run results, plus fixes, customer reviews and failure codes.
const REPORTS: QualityReport[] = [
  ...many(9, () => report("script", true)), ...many(1, () => report("script", false, { issues: issue("hook") })), // 90%
  ...many(10, () => report("pronunciation_prep", true)), // 100%
  ...many(3, () => report("audio", true)), ...many(1, () => report("audio", false, { issues: issue("key_term") })), // 75%
  ...many(4, () => report("technical", true)), ...many(1, () => report("technical", false, { issues: issue("freeze") })), // 80%
  ...many(1, () => report("visual", true)), ...many(1, () => report("visual", false, { issues: issue("captions_clear_of_face") })), // 50%
  ...many(19, () => report("human", true)), ...many(1, () => report("human", false, { issues: issue("human_lip_sync") })), // reject 5%
  // Automatic fixes: 3 runs after a fix, 2 passed (67%). They are not first runs.
  report("audio", true, { auto_fix: "respelled Ayesha" }),
  report("visual", true, { auto_fix: "lower caption style" }),
  report("technical", false, { auto_fix: "rebuilt the edit", issues: issue("freeze") }),
  // Customer review (Phase 6): 1 redo of 4.
  ...many(3, () => report("customer", true)), report("customer", false, { issues: issue("customer_captions") }),
  // An old failure outside "this week" (range ends 22 Nov): not in the top codes.
  report("script", false, { created_at: at(2), issues: issue("old_code") }),
];

const RANGE = { from: new Date(Date.UTC(2026, 10, 1)), to: new Date(Date.UTC(2026, 10, 22, 23, 59, 59)) };
const INPUT = {
  reports: REPORTS,
  delivered: [
    { id: "d1", delivered_at: at(20, 11), started_at: at(20, 9) }, // 2 h
    { id: "d2", delivered_at: at(21, 10), started_at: at(21, 9) }, // 1 h
  ],
  spend: { heygen_usd: 6, claude_usd: 1 },
};

describe("computeQuality", () => {
  const q = computeQuality(INPUT, RANGE);

  it("first-time pass rate per gate (runs with no automatic fix), each against the 85% target", () => {
    const rate = Object.fromEntries(q.perGate.map((g) => [g.gate, [g.passed, g.runs, g.rate, g.ok]]));
    expect(rate).toEqual({
      script: [9, 11, 9 / 11, false], // the old failure is in the range too: 82%, under the target
      pronunciation_prep: [10, 10, 1, true],
      audio: [3, 4, 0.75, false],
      technical: [4, 5, 0.8, false],
      visual: [1, 2, 0.5, false],
      human: [19, 20, 0.95, true],
    });
    expect(QUALITY.targets.first_pass_min).toBe(0.85);
  });

  it("automatic fix success, human reject, customer redo", () => {
    expect(q.autoFix).toEqual({ runs: 3, passed: 2, rate: 2 / 3, ok: false });
    expect(q.humanReject).toEqual({ reviews: 20, rejected: 1, rate: 0.05, ok: false }); // target is UNDER 5%
    expect(q.customerRedo).toEqual({ reviews: 4, redos: 1, rate: 0.25, ok: false });
  });

  it("cost per delivered video (HeyGen + Claude, re-renders included) and time from approval to Ready", () => {
    expect(q.cost).toEqual({ delivered: 2, total_usd: 7, average_usd: 3.5 });
    expect(q.approvalToReady).toEqual({ count: 2, average_hours: 1.5, ok: true });
  });

  it("top 5 failure codes of the last 7 days of the range", () => {
    expect(q.topFailureCodes).toEqual([
      { code: "freeze", count: 2 },
      { code: "captions_clear_of_face", count: 1 },
      { code: "customer_captions", count: 1 },
      { code: "hook", count: 1 },
      { code: "human_lip_sync", count: 1 },
    ]);
  });

  it("no data: rates are null (shown as 'no data'), never 0% or NaN", () => {
    const empty = computeQuality({ reports: [], delivered: [], spend: { heygen_usd: 0, claude_usd: 0 } }, RANGE);
    expect(empty.perGate.every((g) => g.rate === null && g.ok === null)).toBe(true);
    expect(empty.autoFix.rate).toBeNull();
    expect(empty.cost.average_usd).toBeNull();
    expect(empty.approvalToReady.average_hours).toBeNull();
    expect(empty.topFailureCodes).toEqual([]);
  });
});

describe("parseQualityRange", () => {
  const now = new Date(Date.UTC(2026, 10, 22, 12));
  it("defaults to the last QUALITY.default_range_days days", () => {
    const r = parseQualityRange({}, now);
    expect(r.to.toISOString()).toBe("2026-11-22T23:59:59.999Z");
    expect((r.to.getTime() - r.from.getTime()) / 86_400_000).toBeCloseTo(QUALITY.default_range_days, 0);
  });
  it("reads from/to as YYYY-MM-DD; bad or reversed values fall back to the default", () => {
    expect(parseQualityRange({ from: "2026-11-01", to: "2026-11-15" }, now)).toEqual({
      from: new Date("2026-11-01T00:00:00.000Z"),
      to: new Date("2026-11-15T23:59:59.999Z"),
    });
    expect(parseQualityRange({ from: "2026-11-15", to: "2026-11-01" }, now)).toEqual(parseQualityRange({}, now));
    expect(parseQualityRange({ from: "drop table", to: ["x"] }, now)).toEqual(parseQualityRange({}, now));
  });
});

describe("Done when: the Quality page shows pass rates per gate", () => {
  it("renders every gate's first-time pass rate and the other QA-SPEC metrics", () => {
    const html = renderToStaticMarkup(createElement(QualityTable, { quality: computeQuality(INPUT, RANGE) }));
    for (const [label, text] of [
      ["Gate 1 · Script", "82% (9 of 11)"],
      ["Gate 2 · Pronunciation prep", "100% (10 of 10)"],
      ["Gate 3 · Audio", "75% (3 of 4)"],
      ["Gate 4 · Technical", "80% (4 of 5)"],
      ["Gate 5 · Visual", "50% (1 of 2)"],
      ["Gate 6 · Human review", "95% (19 of 20)"],
    ]) {
      expect(html).toContain(label);
      expect(html).toContain(text);
    }
    expect(html).toContain("Automatic fix success rate");
    expect(html).toContain("67% (2 of 3)");
    expect(html).toContain("Human reject rate");
    expect(html).toContain("5% (1 of 20)");
    expect(html).toContain("Customer redo rate");
    expect(html).toContain("$3.50");
    expect(html).toContain("1.5 h");
    expect(html).toContain("freeze");
    expect(html).toContain("over 85%");
    expect(html).toContain("under 5%");
  });

  it("an empty range says 'no data' instead of a number", () => {
    const html = renderToStaticMarkup(
      createElement(QualityTable, { quality: computeQuality({ reports: [], delivered: [], spend: { heygen_usd: 0, claude_usd: 0 } }, RANGE) }),
    );
    expect(html).toContain("No data");
    expect(html).not.toContain("NaN");
  });
});
