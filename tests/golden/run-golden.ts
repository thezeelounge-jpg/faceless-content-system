// Runs one golden brand through the brain: script writer → Gate 1 → Gate 2,
// against the in-memory store. Used by the sample snapshot test (always mock)
// and by `npm run eval:scripts` (mock unless MOCK_CLAUDE is exactly "false").
import { planLimits } from "@/lib/plans";
import { runScriptChecks, type QaReportRow, type RunTask, type ScriptChecksResult } from "@/lib/qa/script-pipeline";
import { writeScriptForPost } from "@/lib/scripts";
import { memoryStore, seedScript, type MemoryStore } from "../helpers/memory-store";
import type { GoldenBrand } from "./brands";

export type GoldenRun = {
  golden: GoldenBrand;
  result: ScriptChecksResult;
  store: MemoryStore;
  reports: QaReportRow[];
};

export async function runGoldenBrand(golden: GoldenBrand, run: RunTask): Promise<GoldenRun> {
  const store = memoryStore();
  for (const entry of golden.dictionary) {
    store.pronunciations.push({ ...entry, brand_id: golden.brand.id!, source: "manual" });
  }
  const maxSeconds = planLimits(golden.plan).max_seconds_per_video;
  const row = await writeScriptForPost({
    brand: golden.brand,
    post: golden.post,
    maxSeconds,
    runScript: (ctx) => run("script", ctx),
  });
  const script = await seedScript(store, row);
  const result = await runScriptChecks({ brand: golden.brand, postId: golden.post.id, script, maxSeconds, run, store });
  return { golden, result, store, reports: store.reports };
}
