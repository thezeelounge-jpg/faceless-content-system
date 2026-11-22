// p5-b3: Admin → Usage and spend → Quality (QA-SPEC "Metrics"). Pure: the rows come from
// lib/qa/quality-store.ts (service role, after requireAdmin). Targets live in lib/qa/config.ts
// (QUALITY.targets); nothing here changes a gate.
//
// How each metric is read from the rows:
// - First-time pass rate, per gate: qa_reports with auto_fix null (a first run, not the run after
//   an automatic fix) → passed / runs, for Gates 1-6 (gate 6 = 'human': approved / reviewed).
// - Automatic fix success rate: qa_reports with auto_fix set (the run right after a fix) → passed / runs.
// - Human reject rate: gate 'human' rejected / reviewed. Customer redo rate: gate 'customer' (Phase 6).
// - Average cost per delivered video: real (non-mock) HeyGen render spend + Claude spend in the range,
//   re-renders included, / videos delivered in the range (videos.delivered_at).
// - Time from approval to Ready: from scripts.approved_at (p5-b4) to delivered_at; old rows without
//   approved_at start at the post's first render request (its first post video, "Make video").
// - Top failure codes: issue codes of failed reports in the last QUALITY.top_failure_days days of the range.
import { QUALITY } from "@/lib/qa/config";
import { GATES, GATE_LABELS } from "@/lib/qa/gates";

export type QualityReport = {
  gate: string;
  passed: boolean;
  auto_fix: string | null;
  issues: { code?: string; detail?: string; severity?: string }[];
  created_at: string;
  video_id: string | null;
};

type Rate = { rate: number | null; ok: boolean | null };
export type GateRate = { gate: string; label: string; runs: number; passed: number } & Rate;
export type Quality = {
  range: { from: Date; to: Date };
  perGate: GateRate[];
  autoFix: { runs: number; passed: number } & Rate;
  humanReject: { reviews: number; rejected: number } & Rate;
  customerRedo: { reviews: number; redos: number } & Rate;
  cost: { delivered: number; total_usd: number; average_usd: number | null };
  approvalToReady: { count: number; average_hours: number | null; ok: boolean | null };
  topFailureCodes: { code: string; count: number }[];
};

export type QualityInput = {
  reports: QualityReport[];
  /** Videos delivered in the range; started_at = scripts.approved_at, else the post's first render request. */
  delivered: { id: string; delivered_at: string; started_at: string | null }[];
  /** Real spend in the range (mock rows are never counted). */
  spend: { heygen_usd: number; claude_usd: number };
};

const DAY_MS = 86_400_000;
const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);
const atLeast = (rate: number | null, min: number) => (rate === null ? null : rate > min);
const under = (rate: number | null, max: number) => (rate === null ? null : rate < max);

export function computeQuality(input: QualityInput, range: { from: Date; to: Date }): Quality {
  const inRange = (iso: string) => {
    const t = Date.parse(iso);
    return t >= range.from.getTime() && t <= range.to.getTime();
  };
  const reports = input.reports.filter((r) => inRange(r.created_at));
  const t = QUALITY.targets;

  const perGate = GATES.map((gate) => {
    const firsts = reports.filter((r) => r.gate === gate && r.auto_fix === null);
    const passed = firsts.filter((r) => r.passed).length;
    const rate = ratio(passed, firsts.length);
    return { gate, label: GATE_LABELS[gate], runs: firsts.length, passed, rate, ok: atLeast(rate, t.first_pass_min) };
  });

  const fixed = reports.filter((r) => r.auto_fix !== null && r.gate !== "human" && r.gate !== "customer");
  const fixedPassed = fixed.filter((r) => r.passed).length;
  const fixRate = ratio(fixedPassed, fixed.length);

  const human = reports.filter((r) => r.gate === "human");
  const rejected = human.filter((r) => !r.passed).length;
  const rejectRate = ratio(rejected, human.length);

  const customer = reports.filter((r) => r.gate === "customer");
  const redos = customer.filter((r) => !r.passed).length;
  const redoRate = ratio(redos, customer.length);

  const delivered = input.delivered.filter((d) => inRange(d.delivered_at));
  const total = round2(input.spend.heygen_usd + input.spend.claude_usd);
  const waits = delivered
    .filter((d) => d.started_at)
    .map((d) => (Date.parse(d.delivered_at) - Date.parse(d.started_at!)) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0);
  const averageHours = waits.length === 0 ? null : round2(waits.reduce((a, b) => a + b, 0) / waits.length);

  const weekStart = range.to.getTime() - QUALITY.top_failure_days * DAY_MS;
  const counts = new Map<string, number>();
  for (const r of reports) {
    if (r.passed || Date.parse(r.created_at) < weekStart) continue;
    const codes = new Set(r.issues.filter((i) => i.severity !== "soft" && i.code).map((i) => i.code!));
    for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const topFailureCodes = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, QUALITY.top_failure_codes);

  return {
    range,
    perGate,
    autoFix: { runs: fixed.length, passed: fixedPassed, rate: fixRate, ok: atLeast(fixRate, t.auto_fix_success_min) },
    humanReject: { reviews: human.length, rejected, rate: rejectRate, ok: under(rejectRate, t.human_reject_max) },
    customerRedo: { reviews: customer.length, redos, rate: redoRate, ok: under(redoRate, t.customer_redo_max) },
    cost: { delivered: delivered.length, total_usd: total, average_usd: delivered.length === 0 ? null : round2(total / delivered.length) },
    approvalToReady: { count: waits.length, average_hours: averageHours, ok: averageHours === null ? null : averageHours < t.approval_to_ready_max_h },
    topFailureCodes,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The page's ?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC days, both included); anything odd → the default range. */
export function parseQualityRange(params: Record<string, string | string[] | undefined>, now: Date): { from: Date; to: Date } {
  const endOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
  const to = endOfDay(now);
  const fallback = { from: new Date(to.getTime() + 1 - QUALITY.default_range_days * DAY_MS), to };
  const { from: f, to: t } = params;
  if (typeof f !== "string" || typeof t !== "string" || !DATE.test(f) || !DATE.test(t)) return fallback;
  const from = new Date(`${f}T00:00:00.000Z`);
  const until = new Date(`${t}T23:59:59.999Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime()) || from > until) return fallback;
  return { from, to: until };
}
