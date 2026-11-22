// p5-b3: the Quality page's server-side query. READ ONLY (tests/unit/quality-store.test.ts runs it
// on a client where any write throws). The caller passes the service-role client
// (lib/supabase/admin.ts) after requireAdmin(). Columns are always named.
// p5-b4 (QA SF3): every query pages through ALL its rows (lib/qa/paging.ts), so PostgREST's
// 1000-row cap can never cut the numbers short without anyone noticing.
import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages, readAllPagesIn } from "@/lib/qa/paging";
import type { QualityInput, QualityReport } from "@/lib/qa/quality";

function failer(what: string) {
  return (error: { message: string } | null): never => {
    throw new Error(`[quality] ${what}: ${error?.message ?? "no data"}`);
  };
}

const sum = (rows: { cost_usd: string | number }[]) => Math.round(rows.reduce((a, r) => a + Number(r.cost_usd), 0) * 10_000) / 10_000;

export async function loadQualityInput(db: SupabaseClient, range: { from: Date; to: Date }): Promise<QualityInput> {
  const from = range.from.toISOString();
  const to = range.to.toISOString();

  type VideoRow = { id: string; post_id: string | null; script_id?: string | null; delivered_at: string | null; created_at: string };
  const [reports, delivered, heygen, claude] = await Promise.all([
    readAllPages<QualityReport>(
      (a, b) =>
        db
          .from("qa_reports")
          .select("gate, passed, auto_fix, issues, created_at, video_id")
          .gte("created_at", from)
          .lte("created_at", to)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(a, b),
      failer("load qa reports"),
    ),
    readAllPages<VideoRow>(
      (a, b) =>
        db
          .from("videos")
          .select("id, post_id, script_id, delivered_at, created_at")
          .eq("kind", "post")
          .gte("delivered_at", from)
          .lte("delivered_at", to)
          .order("id", { ascending: true })
          .range(a, b),
      failer("load delivered videos"),
    ),
    // Real HeyGen render spend (re-renders included). Mock rows (cost 0, mock = true) never count.
    readAllPages<{ cost_usd: string }>(
      (a, b) =>
        db
          .from("provider_usage")
          .select("cost_usd")
          .eq("provider", "heygen")
          .eq("kind", "render")
          .eq("mock", false)
          .eq("status", "succeeded")
          .gte("created_at", from)
          .lte("created_at", to)
          .order("id", { ascending: true })
          .range(a, b),
      failer("load HeyGen spend"),
    ),
    readAllPages<{ cost_usd: string }>(
      (a, b) => db.from("ai_usage").select("cost_usd").gte("created_at", from).lte("created_at", to).order("id", { ascending: true }).range(a, b),
      failer("load Claude spend"),
    ),
  ]);

  const done = delivered.filter((v) => v.delivered_at);

  // p5-b4 (Rowan 7): "Approval to Ready" starts at scripts.approved_at (stamped by trigger
  // posts_stamp_script_approved, migration 20261123020000). Old rows without it fall back to the
  // post's FIRST post video (made by "Make video" after approval).
  const scriptIds = [...new Set(done.map((v) => v.script_id).filter((id): id is string => Boolean(id)))];
  const approvedAt = new Map<string, string>();
  const scripts = await readAllPagesIn<{ id: string; approved_at: string | null }>(
    scriptIds,
    (slice, a, b) => db.from("scripts").select("id, approved_at").in("id", slice).order("id", { ascending: true }).range(a, b),
    failer("load script approvals"),
  );
  for (const s of scripts) if (s.approved_at) approvedAt.set(s.id, s.approved_at);

  const postIds = [...new Set(done.map((v) => v.post_id).filter((id): id is string => Boolean(id)))];
  const firstRender = new Map<string, string>();
  const rows = await readAllPagesIn<{ post_id: string; created_at: string }>(
    postIds,
    (slice, a, b) => db.from("videos").select("post_id, created_at").eq("kind", "post").in("post_id", slice).order("id", { ascending: true }).range(a, b),
    failer("load first render requests"),
  );
  for (const row of rows) {
    const seen = firstRender.get(row.post_id);
    if (!seen || row.created_at < seen) firstRender.set(row.post_id, row.created_at);
  }

  return {
    reports: reports.map((r) => ({ ...r, issues: Array.isArray(r.issues) ? r.issues : [] })),
    delivered: done.map((v) => ({
      id: v.id,
      delivered_at: v.delivered_at!,
      started_at: (v.script_id && approvedAt.get(v.script_id)) || (v.post_id && firstRender.get(v.post_id)) || null,
    })),
    spend: { heygen_usd: sum(heygen), claude_usd: sum(claude) },
  };
}
