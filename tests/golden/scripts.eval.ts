// `npm run eval:scripts` (see vitest.eval.config.mts). NOT part of `npm test`.
// For each golden brand: write a script, run Gate 1 (with its one rewrite)
// and Gate 2, then print a table and the overall pass rate.
// Mock unless MOCK_CLAUDE is exactly "false". Live runs cost a few cents:
// ask the owner first.
import { expect, it } from "vitest";
import { logUsageToDatabase, runClaudeTask, type ClaudeContext, type ClaudeTaskName, type TaskOutput, type UsageRow } from "@/lib/claude";
import { isMockClaude } from "@/lib/config";
import { GOLDEN_BRANDS } from "./brands";
import { runGoldenBrand, type GoldenRun } from "./run-golden";

const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));

function row(run: GoldenRun): string[] {
  const scriptReports = run.reports.filter((r) => r.gate === "script");
  const lastScript = scriptReports[scriptReports.length - 1];
  const prep = run.reports.find((r) => r.gate === "pronunciation_prep");
  const passed = run.result.outcome === "script_review" || run.result.outcome === "approved";
  const hard = [...new Set(run.reports.flatMap((r) => r.issues.filter((i) => i.severity === "hard").map((i) => i.code)))];
  const newWords = prep?.issues.filter((i) => i.code === "new_word").length ?? 0;
  return [
    run.golden.key,
    run.golden.brand.language,
    passed ? "yes" : "NO",
    String(lastScript?.score ?? "-"),
    String(scriptReports.length - 1),
    [hard.length ? `hard: ${hard.join(", ")}` : "", newWords ? `${newWords} new word(s)` : ""].filter(Boolean).join("; ") || "-",
  ];
}

it("golden set: script writer → Gate 1 → Gate 2", async () => {
  const mock = isMockClaude();
  const usage: UsageRow[] = [];
  const logUsage = async (entry: UsageRow) => {
    usage.push(entry);
    // Golden brands are not database rows, so live usage is saved without a brand.
    if (!mock) await logUsageToDatabase({ ...entry, brand_id: null, task: `eval:${entry.task}` });
  };
  const run = <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>): Promise<TaskOutput<T>> =>
    runClaudeTask(task, ctx, { logUsage });

  const lines: string[] = [
    "",
    mock
      ? "MODE: MOCK (sample answers from lib/claude-mocks.ts, no Claude calls, costs nothing)"
      : "MODE: LIVE (real Claude API calls, costs a few cents)",
    "",
  ];

  const runs: GoldenRun[] = [];
  const failures: string[] = [];
  for (const golden of GOLDEN_BRANDS) {
    try {
      runs.push(await runGoldenBrand(golden, run));
    } catch (error) {
      failures.push(`${golden.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const widths = [28, 11, 7, 6, 9, 60];
  const header = ["Brand", "Language", "Passed", "Voice", "Rewrites", "Issues"];
  lines.push(header.map((h, i) => pad(h, widths[i])).join(" "));
  lines.push(widths.map((w) => "-".repeat(w)).join(" "));
  for (const r of runs) lines.push(row(r).map((cell, i) => pad(cell, widths[i])).join(" "));
  for (const f of failures) lines.push(`ERROR ${f}`);

  const passedCount = runs.filter((r) => r.result.outcome === "script_review" || r.result.outcome === "approved").length;
  const voices = runs.flatMap((r) => r.reports.filter((x) => x.gate === "script").slice(-1).map((x) => Number(x.score)));
  const avgVoice = voices.length ? (voices.reduce((a, b) => a + b, 0) / voices.length).toFixed(1) : "-";
  const cost = usage.reduce((sum, u) => sum + u.cost_usd, 0);
  lines.push("");
  lines.push(`Pass rate: ${passedCount}/${GOLDEN_BRANDS.length} (${Math.round((passedCount / GOLDEN_BRANDS.length) * 100)}%)`);
  lines.push(`Average voice score: ${avgVoice}`);
  lines.push(`Claude calls: ${usage.length}, estimated cost: $${cost.toFixed(4)}`);
  lines.push("");
  console.log(lines.join("\n"));

  expect(runs.length + failures.length).toBe(GOLDEN_BRANDS.length);
});
