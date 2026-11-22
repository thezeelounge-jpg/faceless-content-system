import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { HumanReviewRow, HumanReviewStore, ReviewOutcome } from "@/lib/qa/human-review";
import { createVideoFiles } from "@/lib/video-store";

// p5-b3: the Supabase side of Admin → QA queue. SECRET key: call only after requireAdmin().
// Columns are always named (never select *).

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`[qa-queue] ${what}: ${error?.message ?? "no data"}`);
}

const reviewAnswer = z.object({
  outcome: z.enum(["approved", "rejected", "not_in_queue", "not_found", "checklist_incomplete", "no_final_file", "bad_input"]),
  brand_id: z.string().nullish(),
});

/** The review_queued_video answer (exported for tests). */
export function reviewResult(data: unknown): { outcome: ReviewOutcome; brandId: string | null } {
  const parsed = reviewAnswer.safeParse(data);
  if (!parsed.success) fail("review video", { message: "unexpected answer" });
  return { outcome: parsed.data.outcome, brandId: parsed.data.brand_id ?? null };
}

export function createHumanReviewStore(): HumanReviewStore {
  const db = createAdminClient();
  return {
    async review(args) {
      const { data, error } = await db.rpc("review_queued_video", {
        p_video_id: args.videoId,
        p_decision: args.decision,
        p_checklist: args.checklist,
        p_reason: args.reason,
        p_note: args.note,
        p_admin: args.adminEmail,
      });
      if (error) fail("review video", error);
      return reviewResult(data);
    },
  };
}

/** One gate report as the queue shows it. */
export type QueueReport = {
  id: string;
  gate: string;
  passed: boolean;
  score: number | null;
  issues: { code?: string; detail?: string; at_seconds?: number | null; severity?: string }[];
  auto_fix: string | null;
  created_at: string;
};

export type QueueItem = {
  id: string;
  brand_id: string;
  post_id: string | null;
  script_id: string | null;
  attempt: number;
  error: string | null;
  final_path: string | null;
  raw_path: string | null;
  watermark: boolean;
  ai_label: boolean;
  created_at: string;
  /** p5-b4: human_reviews = earlier Gate 6 decisions of this post (server only; admins). */
  post: { title: string; status: string; status_reason: string | null; human_reviews?: HumanReviewRow[] } | null;
  brand: { name: string } | null;
  /** Every gate report of this video AND of its script (Gates 1-2 are per script). Oldest first. */
  reports: QueueReport[];
  /** A 10-minute signed link to the final edit (else the raw render), made on the server. */
  playUrl: string | null;
  playsRaw: boolean;
};

/** How long a queue player link works. */
const QUEUE_PLAYBACK_SECONDS = 600;
/** The queue page shows at most this many videos (oldest first, so nothing waits forever). */
const QUEUE_LIMIT = 30;

export async function listQueue(): Promise<QueueItem[]> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("videos")
    .select(
      "id, brand_id, post_id, script_id, attempt, error, final_path, raw_path, watermark, ai_label, created_at, post:posts(title, status, status_reason, human_reviews(decision, reason, note, admin, created_at)), brand:brands(name)",
    )
    .eq("kind", "post")
    .eq("status", "team_review")
    .order("created_at", { ascending: true })
    .limit(QUEUE_LIMIT);
  if (error) fail("list queue", error);
  const videos = (data ?? []) as unknown as Omit<QueueItem, "reports" | "playUrl" | "playsRaw">[];
  if (videos.length === 0) return [];

  const videoIds = videos.map((v) => v.id);
  const scriptIds = videos.map((v) => v.script_id).filter((id): id is string => Boolean(id));
  const columns = "id, video_id, script_id, gate, passed, score, issues, auto_fix, created_at";
  const [byVideo, byScript] = await Promise.all([
    db.from("qa_reports").select(columns).in("video_id", videoIds).order("created_at", { ascending: true }),
    scriptIds.length > 0
      ? db.from("qa_reports").select(columns).in("script_id", scriptIds).is("video_id", null).order("created_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (byVideo.error) fail("load gate reports", byVideo.error);
  if (byScript.error) fail("load script reports", byScript.error);
  type Row = QueueReport & { video_id: string | null; script_id: string | null };
  const rows = [...((byVideo.data ?? []) as Row[]), ...((byScript.data ?? []) as Row[])].map((r) => ({
    ...r,
    score: r.score === null ? null : Number(r.score),
  }));

  const files = createVideoFiles();
  return Promise.all(
    videos.map(async (video) => {
      const path = video.final_path ?? video.raw_path;
      let playUrl: string | null = null;
      if (path) {
        try {
          playUrl = await files.signedUrl(path, QUEUE_PLAYBACK_SECONDS);
        } catch {
          playUrl = null; // the page says "no player link"; the decision still works
        }
      }
      const reports = rows
        .filter((r) => r.video_id === video.id || (r.video_id === null && r.script_id === video.script_id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { ...video, reports, playUrl, playsRaw: !video.final_path && Boolean(video.raw_path) };
    }),
  );
}
