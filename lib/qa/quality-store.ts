// p5-b3: the Quality page's server-side query. READ ONLY (tests/unit/quality-store.test.ts runs it
// on a client where any write throws). The caller passes the service-role client
// (lib/supabase/admin.ts) after requireAdmin(). Columns are always named.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QualityInput, QualityReport } from "@/lib/qa/quality";

/** Far more rows than a range of real videos makes; the page says so if it is ever reached. */
export const QUALITY_ROW_LIMIT = 20_000;

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`[quality] ${what}: ${error?.message ?? "no data"}`);
}

const sum = (rows: { cost_usd: string | number }[] | null) => Math.round((rows ?? []).reduce((a, r) => a + Number(r.cost_usd), 0) * 10_000) / 10_000;

export async function loadQualityInput(db: SupabaseClient, range: { from: Date; to: Date }): Promise<QualityInput> {
  const from = range.from.toISOString();
  const to = range.to.toISOString();

  const [reports, delivered, heygen, claude] = await Promise.all([
    db
      .from("qa_reports")
      .select("gate, passed, auto_fix, issues, created_at, video_id")
      .gte("created_at", from)
      .lte("created_at", to)
      .order("created_at", { ascending: true })
      .limit(QUALITY_ROW_LIMIT),
    db
      .from("videos")
      .select("id, post_id, delivered_at, created_at")
      .eq("kind", "post")
      .gte("delivered_at", from)
      .lte("delivered_at", to)
      .limit(QUALITY_ROW_LIMIT),
    // Real HeyGen render spend (re-renders included). Mock rows (cost 0, mock = true) never count.
    db
      .from("provider_usage")
      .select("cost_usd")
      .eq("provider", "heygen")
      .eq("kind", "render")
      .eq("mock", false)
      .eq("status", "succeeded")
      .gte("created_at", from)
      .lte("created_at", to)
      .limit(QUALITY_ROW_LIMIT),
    db.from("ai_usage").select("cost_usd").gte("created_at", from).lte("created_at", to).limit(QUALITY_ROW_LIMIT),
  ]);
  if (reports.error) fail("load qa reports", reports.error);
  if (delivered.error) fail("load delivered videos", delivered.error);
  if (heygen.error) fail("load HeyGen spend", heygen.error);
  if (claude.error) fail("load Claude spend", claude.error);

  type VideoRow = { id: string; post_id: string | null; delivered_at: string | null; created_at: string };
  const done = ((delivered.data ?? []) as VideoRow[]).filter((v) => v.delivered_at);

  // "Approval to Ready" starts at the post's FIRST post video (made by "Make video" after approval).
  const postIds = [...new Set(done.map((v) => v.post_id).filter((id): id is string => Boolean(id)))];
  const firstRender = new Map<string, string>();
  if (postIds.length > 0) {
    const { data, error } = await db.from("videos").select("post_id, created_at").eq("kind", "post").in("post_id", postIds).limit(QUALITY_ROW_LIMIT);
    if (error) fail("load first render requests", error);
    for (const row of (data ?? []) as { post_id: string; created_at: string }[]) {
      const seen = firstRender.get(row.post_id);
      if (!seen || row.created_at < seen) firstRender.set(row.post_id, row.created_at);
    }
  }

  return {
    reports: ((reports.data ?? []) as QualityReport[]).map((r) => ({ ...r, issues: Array.isArray(r.issues) ? r.issues : [] })),
    delivered: done.map((v) => ({ id: v.id, delivered_at: v.delivered_at!, started_at: (v.post_id && firstRender.get(v.post_id)) || null })),
    spend: { heygen_usd: sum(heygen.data as { cost_usd: string }[] | null), claude_usd: sum(claude.data as { cost_usd: string }[] | null) },
  };
}
