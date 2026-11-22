import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CalibrationView } from "@/components/admin/calibration-view";
import { calibrate, type CalibrationInput } from "@/lib/qa/calibration";
import { loadCalibrationInput } from "@/lib/qa/calibration-store";
import { AUDIO_QA, CALIBRATION, SCRIPT_QA, TECH_QA, VISUAL_QA } from "@/lib/qa/config";
import { readOnlyDb } from "@/tests/helpers/read-only-db";

// p5-b3: calibration (PROMPTS Phase 5 item 8): after the first 10 REAL videos, show each gate's
// scores against its current threshold and PROPOSE a value with the reasoning. Read only: nothing
// is written and lib/qa/config.ts is never changed. Mock videos never count toward the 10.

const ids = (n: number, prefix = "v") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function input(realCount: number, mockCount = 0): CalibrationInput {
  const real = ids(realCount);
  const mock = ids(mockCount, "m");
  return {
    renders: [...real.map((video_id) => ({ video_id, mock: false })), ...mock.map((video_id) => ({ video_id, mock: true }))],
    videos: [...real, ...mock].map((id) => ({ id, script_id: `s-${id}`, language: "en" })),
    reports: [...real, ...mock].flatMap((id, i) => [
      { gate: "script", passed: true, score: 8, video_id: null, script_id: `s-${id}` },
      { gate: "audio", passed: true, score: 0.02 + (i % 3) * 0.01, video_id: id, script_id: null },
      { gate: "technical", passed: true, score: -14 + (i % 2) * 0.4, video_id: id, script_id: null },
      { gate: "visual", passed: true, score: 8 + (i % 2), video_id: id, script_id: null },
    ]),
  };
}

describe("calibrate", () => {
  it(`below ${CALIBRATION.min_real_videos} real videos: says how many more are needed; mock videos never count`, () => {
    expect(CALIBRATION.min_real_videos).toBe(10);
    expect(calibrate(input(7, 20))).toEqual({ ready: false, realVideos: 7, needed: 3 });
    expect(calibrate(input(0, 50))).toEqual({ ready: false, realVideos: 0, needed: 10 });
    // A video with both a mock and a real render row is real; duplicates count once.
    const twice = input(9);
    twice.renders.push({ video_id: "v0", mock: false }, { video_id: "v1", mock: true });
    expect(calibrate(twice)).toMatchObject({ ready: false, realVideos: 9 });
  });

  it("at 10 real videos: each gate's distribution against its CURRENT threshold (from lib/qa/config.ts)", () => {
    const result = calibrate(input(10, 5));
    if (!result.ready) throw new Error("expected ready");
    expect(result.realVideos).toBe(10);
    const byKey = Object.fromEntries(result.gates.map((g) => [g.key, g]));
    expect(Object.keys(byKey).sort()).toEqual(["audio_en", "script", "technical", "visual"]);
    expect(byKey.script).toMatchObject({ threshold: SCRIPT_QA.voice_pass_score, direction: "higher", count: 10 });
    expect(byKey.audio_en).toMatchObject({ threshold: AUDIO_QA.max_wer.en, direction: "lower", count: 10 });
    expect(byKey.visual).toMatchObject({ threshold: VISUAL_QA.pass_realism_score, direction: "higher", count: 10 });
    expect(byKey.technical).toMatchObject({ threshold: TECH_QA.loudness_target_lufs, direction: "band", count: 10 });
    expect(byKey.visual.stats).toEqual({ min: 8, median: 8.5, max: 9 });
    // Mock videos' scores are not in the distribution (10, not 15).
    expect(result.gates.every((g) => g.count === 10)).toBe(true);
  });

  it("no rejected video passed a gate → keep the current value, with the reason", () => {
    const result = calibrate(input(10));
    if (!result.ready) throw new Error("expected ready");
    const visual = result.gates.find((g) => g.key === "visual")!;
    expect(visual.proposed).toBe(VISUAL_QA.pass_realism_score);
    expect(visual.reasoning).toMatch(/keep/i);
  });

  it("a video the team rejected that passed Gate 5 → propose a stricter realism score, saying why", () => {
    const data = input(10);
    data.reports.push({ gate: "human", passed: false, score: null, video_id: "v1", script_id: null });
    const result = calibrate(data);
    if (!result.ready) throw new Error("expected ready");
    const visual = result.gates.find((g) => g.key === "visual")!;
    // v1 scored 9 at Gate 5 (passed at 8) and was rejected by a person: proposing 10 would have caught it.
    expect(visual.proposed).toBe(10);
    expect(visual.reasoning).toMatch(/1 video .*rejected/i);
    // Audio (lower is better): v1's WER 0.03 passed at 0.08 → propose just under it.
    const audio = result.gates.find((g) => g.key === "audio_en")!;
    expect(audio.proposed).toBeCloseTo(0.02, 5);
  });
});

describe("calibration never writes", () => {
  it("the loader only reads (any insert/update/delete/rpc/storage call throws) and counts real renders only", async () => {
    const { db, calls } = readOnlyDb({
      provider_usage: [{ video_id: "v1", mock: false }],
      videos: [{ id: "v1", script_id: "s1", brand: { language: "en" } }],
      qa_reports: [{ gate: "visual", passed: true, score: 9, video_id: "v1", script_id: null }],
    });
    const loaded = await loadCalibrationInput(db as never);
    expect(loaded.renders).toEqual([{ video_id: "v1", mock: false }]);
    expect(loaded.videos).toEqual([{ id: "v1", script_id: "s1", language: "en" }]);
    const on = (table: string, op: string) => calls.filter((c) => c.table === table && c.op === op).map((c) => c.args);
    expect(on("provider_usage", "eq")).toEqual(expect.arrayContaining([["provider", "heygen"], ["kind", "render"], ["mock", false], ["status", "succeeded"]]));
    expect(calls.some((c) => ["insert", "update", "upsert", "delete"].includes(c.op))).toBe(false);
  });

  it("p5-b4 (QA SF3): pages through every table, so a 1000-row cap per answer never cuts the input short", async () => {
    const n = (count: number) => Array.from({ length: count }, (_, i) => i);
    const { db, calls } = readOnlyDb(
      {
        provider_usage: n(1800).map((i) => ({ video_id: `v${i}`, mock: false })),
        videos: n(1800).map((i) => ({ id: `v${i}`, script_id: `s${i}`, brand: { language: "en" } })),
        qa_reports: [
          ...n(2600).map((i) => ({ gate: "visual", passed: true, score: 9, video_id: `v${i % 1800}`, script_id: null, created_at: "2026-11-20T09:00:00Z" })),
          ...n(1100).map((i) => ({ gate: "script", passed: true, score: 8, video_id: null, script_id: `s${i}`, created_at: "2026-11-20T08:00:00Z" })),
        ],
      },
      { maxRows: 1000 },
    );
    const loaded = await loadCalibrationInput(db as never);
    expect(loaded.renders).toHaveLength(1800);
    expect(loaded.videos).toHaveLength(1800);
    expect(loaded.reports.filter((r) => r.gate === "visual")).toHaveLength(2600);
    expect(loaded.reports.filter((r) => r.gate === "script" && r.video_id === null)).toHaveLength(1100);
    expect(calls.some((c) => c.op === "range")).toBe(true);
  });

  it("calibrating leaves lib/qa/config.ts byte for byte the same", () => {
    const file = path.resolve(process.cwd(), "lib/qa/config.ts");
    const before = readFileSync(file, "utf8");
    const data = input(12);
    data.reports.push({ gate: "human", passed: false, score: null, video_id: "v1", script_id: null });
    calibrate(data);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("no Server Action, form or button can change a threshold from the calibration code", () => {
    const files = [
      "lib/qa/calibration.ts",
      "lib/qa/calibration-store.ts",
      "components/admin/calibration-view.tsx",
      ...readdirSync(path.resolve(process.cwd(), "app/admin/usage")).map((f) => `app/admin/usage/${f}`),
    ];
    for (const f of files) {
      const src = readFileSync(path.resolve(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/["']use server["']/);
      expect(src, f).not.toMatch(/writeFile|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
    }
    const view = readFileSync(path.resolve(process.cwd(), "components/admin/calibration-view.tsx"), "utf8");
    expect(view).not.toMatch(/<form|<button|<Button|ActionForm/);
  });
});

describe("CalibrationView", () => {
  it("below 10: how many more real videos are needed", () => {
    const html = renderToStaticMarkup(createElement(CalibrationView, { result: calibrate(input(7, 3)) }));
    expect(html).toContain("7 of 10 real videos");
    expect(html).toContain("3 more");
    expect(html).toMatch(/mock videos never count/i);
  });

  it("at 10: each gate's current and proposed value with the reasoning, marked read only", () => {
    const data = input(10);
    data.reports.push({ gate: "human", passed: false, score: null, video_id: "v1", script_id: null });
    const html = renderToStaticMarkup(createElement(CalibrationView, { result: calibrate(data) }));
    expect(html).toContain("Gate 5 · Visual");
    expect(html).toContain("Current: 8");
    expect(html).toContain("Proposed: 10");
    expect(html).toMatch(/read only/i);
    expect(html).toMatch(/lib\/qa\/config\.ts/);
  });
});
