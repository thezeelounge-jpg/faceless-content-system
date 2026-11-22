import { Card, CardContent } from "@/components/ui/card";
import { QUALITY } from "@/lib/qa/config";
import type { Quality } from "@/lib/qa/quality";

// p5-b3: the QA-SPEC metrics table (Admin → Usage and spend → Quality). Read only.

const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const t = QUALITY.targets;

type Row = { metric: string; value: string; target: string; ok: boolean | null };

function rateValue(rate: number | null, part: number, whole: number): string {
  return rate === null ? "No data" : `${pct(rate)} (${part} of ${whole})`;
}

export function QualityTable({ quality: q }: { quality: Quality }) {
  const rows: Row[] = [
    ...q.perGate.map((g) => ({
      metric: `First-time pass rate · ${g.label}`,
      value: rateValue(g.rate, g.passed, g.runs),
      target: `over ${pct(t.first_pass_min)}`,
      ok: g.ok,
    })),
    {
      metric: "Automatic fix success rate",
      value: rateValue(q.autoFix.rate, q.autoFix.passed, q.autoFix.runs),
      target: `over ${pct(t.auto_fix_success_min)}`,
      ok: q.autoFix.ok,
    },
    {
      metric: "Human reject rate",
      value: rateValue(q.humanReject.rate, q.humanReject.rejected, q.humanReject.reviews),
      target: `under ${pct(t.human_reject_max)}`,
      ok: q.humanReject.ok,
    },
    {
      metric: "Customer redo rate",
      value: rateValue(q.customerRedo.rate, q.customerRedo.redos, q.customerRedo.reviews),
      target: `under ${pct(t.customer_redo_max)}`,
      ok: q.customerRedo.ok,
    },
    {
      metric: "Average cost per delivered video (including re-renders)",
      value:
        q.cost.average_usd === null
          ? "No data"
          : `$${q.cost.average_usd.toFixed(2)} ($${q.cost.total_usd.toFixed(2)} for ${q.cost.delivered} video${q.cost.delivered === 1 ? "" : "s"})`,
      target: "track weekly",
      ok: null,
    },
    {
      metric: "Time from approval to Ready",
      value: q.approvalToReady.average_hours === null ? "No data" : `${q.approvalToReady.average_hours} h average (${q.approvalToReady.count} videos)`,
      target: `under ${t.approval_to_ready_max_h} hours`,
      ok: q.approvalToReady.ok,
    },
  ];
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1 pr-3 font-normal">Metric</th>
                <th className="py-1 pr-3 font-normal">Value</th>
                <th className="py-1 font-normal">Target</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {rows.map((row) => (
                <tr key={row.metric}>
                  <td className="py-1.5 pr-3">{row.metric}</td>
                  <td className="py-1.5 pr-3">
                    {row.value}
                    {row.ok === true && <span className="text-green-700"> ✓</span>}
                    {row.ok === false && <span className="text-destructive"> ✗ off target</span>}
                  </td>
                  <td className="text-muted-foreground py-1.5">{row.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <section className="space-y-1 text-sm">
          <h3 className="font-medium">Top {QUALITY.top_failure_codes} failure codes this week (review every Monday)</h3>
          {q.topFailureCodes.length === 0 ? (
            <p className="text-muted-foreground">No data</p>
          ) : (
            <ol className="ml-4 list-decimal">
              {q.topFailureCodes.map((c) => (
                <li key={c.code}>
                  <code>{c.code}</code> · {c.count}
                </li>
              ))}
            </ol>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
