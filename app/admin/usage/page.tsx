import { AdminPage } from "@/components/admin/admin-page";
import { CalibrationView } from "@/components/admin/calibration-view";
import { QualityTable } from "@/components/admin/quality-table";
import { Button } from "@/components/ui/button";
import { adminSection } from "@/lib/admin-sections";
import { requireAdmin } from "@/lib/auth";
import { calibrate } from "@/lib/qa/calibration";
import { loadCalibrationInput } from "@/lib/qa/calibration-store";
import { computeQuality, parseQualityRange } from "@/lib/qa/quality";
import { loadQualityInput } from "@/lib/qa/quality-store";
import { createAdminClient } from "@/lib/supabase/admin";

const section = adminSection("/admin/usage");

// p5-b3: Usage and spend → Quality (QA-SPEC "Metrics"), over a date range (?from=&to=, UTC days).
export default function UsageAndSpendPage({ searchParams }: PageProps<"/admin/usage">) {
  return (
    <AdminPage title={section.label} description={section.about}>
      <Quality searchParams={searchParams} />
      <Calibration />
    </AdminPage>
  );
}

const day = (d: Date) => d.toISOString().slice(0, 10);

async function Quality({ searchParams }: Pick<PageProps<"/admin/usage">, "searchParams">) {
  await requireAdmin();
  const range = parseQualityRange(await searchParams, new Date());
  const quality = computeQuality(await loadQualityInput(createAdminClient(), range), range);
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Quality</h2>
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <label className="space-y-1">
          <span className="block">From</span>
          <input type="date" name="from" defaultValue={day(range.from)} className="border-input rounded-md border px-2 py-1" />
        </label>
        <label className="space-y-1">
          <span className="block">To</span>
          <input type="date" name="to" defaultValue={day(range.to)} className="border-input rounded-md border px-2 py-1" />
        </label>
        <Button type="submit" size="sm" variant="outline">
          Show
        </Button>
      </form>
      <p className="text-muted-foreground text-xs">
        {day(range.from)} to {day(range.to)} (UTC). Spend counts real HeyGen renders and Claude calls only; mock rows never count.
      </p>
      <QualityTable quality={quality} />
    </section>
  );
}

// p5-b3: calibration, read only (PROMPTS Phase 5 item 8). Never writes a threshold.
async function Calibration() {
  await requireAdmin();
  const result = calibrate(await loadCalibrationInput(createAdminClient()));
  return (
    <section className="mt-8 space-y-3">
      <h2 className="text-lg font-semibold">Calibration</h2>
      <CalibrationView result={result} />
    </section>
  );
}
