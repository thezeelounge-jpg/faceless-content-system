// p5-b3: the calibration section's server-side query. READ ONLY (tests/unit/calibration.test.ts
// runs it on a client where any write throws). The caller passes the service-role client after
// requireAdmin(). Real videos only: a succeeded, NON-mock HeyGen render row (provider_usage).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CalibrationInput } from "@/lib/qa/calibration";

/** The first real videos are what calibration is about; this is far more than enough. */
const CALIBRATION_ROW_LIMIT = 5_000;

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`[calibration] ${what}: ${error?.message ?? "no data"}`);
}

export async function loadCalibrationInput(db: SupabaseClient): Promise<CalibrationInput> {
  const renders = await db
    .from("provider_usage")
    .select("video_id, mock")
    .eq("provider", "heygen")
    .eq("kind", "render")
    .eq("mock", false)
    .eq("status", "succeeded")
    .not("video_id", "is", null)
    .limit(CALIBRATION_ROW_LIMIT);
  if (renders.error) fail("load real renders", renders.error);
  const renderRows = ((renders.data ?? []) as { video_id: string; mock: boolean }[]).map((r) => ({ video_id: r.video_id, mock: r.mock }));
  const videoIds = [...new Set(renderRows.map((r) => r.video_id))];
  if (videoIds.length === 0) return { renders: renderRows, videos: [], reports: [] };

  const videos = await db.from("videos").select("id, script_id, brand:brands(language)").eq("kind", "post").in("id", videoIds).limit(CALIBRATION_ROW_LIMIT);
  if (videos.error) fail("load real videos", videos.error);
  type VideoRow = { id: string; script_id: string | null; brand: { language: string | null } | null };
  const videoRows = ((videos.data ?? []) as unknown as VideoRow[]).map((v) => ({ id: v.id, script_id: v.script_id, language: v.brand?.language ?? "en" }));
  const scriptIds = [...new Set(videoRows.map((v) => v.script_id).filter((id): id is string => Boolean(id)))];

  const columns = "gate, passed, score, video_id, script_id, created_at";
  const [byVideo, byScript] = await Promise.all([
    db.from("qa_reports").select(columns).in("video_id", videoIds).order("created_at", { ascending: true }).limit(CALIBRATION_ROW_LIMIT),
    scriptIds.length > 0
      ? db.from("qa_reports").select(columns).eq("gate", "script").in("script_id", scriptIds).order("created_at", { ascending: true }).limit(CALIBRATION_ROW_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (byVideo.error) fail("load gate reports", byVideo.error);
  if (byScript.error) fail("load script reports", byScript.error);
  type ReportRow = { gate: string; passed: boolean; score: string | number | null; video_id: string | null; script_id: string | null; created_at: string };
  const reports = [...((byVideo.data ?? []) as ReportRow[]), ...((byScript.data ?? []) as ReportRow[])]
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .map((r) => ({ gate: r.gate, passed: r.passed, score: r.score === null ? null : Number(r.score), video_id: r.video_id, script_id: r.script_id }));

  return { renders: renderRows, videos: videoRows, reports };
}
