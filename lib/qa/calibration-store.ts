// p5-b3: the calibration section's server-side query. READ ONLY (tests/unit/calibration.test.ts
// runs it on a client where any write throws). The caller passes the service-role client after
// requireAdmin(). Real videos only: a succeeded, NON-mock HeyGen render row (provider_usage).
// p5-b4 (QA SF3): every query pages through ALL its rows (lib/qa/paging.ts); long id lists are
// split, so PostgREST's 1000-row cap can never cut the input short.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CalibrationInput } from "@/lib/qa/calibration";
import { readAllPages, readAllPagesIn } from "@/lib/qa/paging";

function failer(what: string) {
  return (error: { message: string } | null): never => {
    throw new Error(`[calibration] ${what}: ${error?.message ?? "no data"}`);
  };
}

export async function loadCalibrationInput(db: SupabaseClient): Promise<CalibrationInput> {
  const renders = await readAllPages<{ video_id: string; mock: boolean }>(
    (a, b) =>
      db
        .from("provider_usage")
        .select("video_id, mock")
        .eq("provider", "heygen")
        .eq("kind", "render")
        .eq("mock", false)
        .eq("status", "succeeded")
        .not("video_id", "is", null)
        .order("id", { ascending: true })
        .range(a, b),
    failer("load real renders"),
  );
  const renderRows = renders.map((r) => ({ video_id: r.video_id, mock: r.mock }));
  const videoIds = [...new Set(renderRows.map((r) => r.video_id))];
  if (videoIds.length === 0) return { renders: renderRows, videos: [], reports: [] };

  type VideoRow = { id: string; script_id: string | null; brand: { language: string | null } | null };
  const videos = await readAllPagesIn<VideoRow>(
    videoIds,
    (slice, a, b) =>
      db
        .from("videos")
        .select("id, script_id, brand:brands(language)")
        .eq("kind", "post")
        .in("id", slice)
        .order("id", { ascending: true })
        .range(a, b) as unknown as PromiseLike<{ data: VideoRow[] | null; error: { message: string } | null }>,
    failer("load real videos"),
  );
  const videoRows = videos.map((v) => ({ id: v.id, script_id: v.script_id, language: v.brand?.language ?? "en" }));
  const scriptIds = [...new Set(videoRows.map((v) => v.script_id).filter((id): id is string => Boolean(id)))];

  type ReportRow = { gate: string; passed: boolean; score: string | number | null; video_id: string | null; script_id: string | null; created_at: string };
  const columns = "gate, passed, score, video_id, script_id, created_at";
  const [byVideo, byScript] = await Promise.all([
    readAllPagesIn<ReportRow>(
      videoIds,
      (slice, a, b) =>
        db.from("qa_reports").select(columns).in("video_id", slice).order("created_at", { ascending: true }).order("id", { ascending: true }).range(a, b),
      failer("load gate reports"),
    ),
    readAllPagesIn<ReportRow>(
      scriptIds,
      (slice, a, b) =>
        db
          .from("qa_reports")
          .select(columns)
          .eq("gate", "script")
          .in("script_id", slice)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(a, b),
      failer("load script reports"),
    ),
  ]);
  const reports = [...byVideo, ...byScript]
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .map((r) => ({ gate: r.gate, passed: r.passed, score: r.score === null ? null : Number(r.score), video_id: r.video_id, script_id: r.script_id }));

  return { renders: renderRows, videos: videoRows, reports };
}
