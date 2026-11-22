import type { EditFiles, EditStore } from "@/lib/edit-flow";
import { createHeygenClient } from "@/lib/heygen";
import { buildSpokenText, type PronunciationEntry } from "@/lib/pronunciation/dictionary";
import type { GateContext, PipelineStore, VideoQaReport } from "@/lib/qa/pipeline-types";
import { completeRender, createPostRender, renderVideo } from "@/lib/render";
import { estimateSeconds } from "@/lib/scripts";
import type { VideoRow } from "@/lib/video-store-types";
import { BRAND_ID } from "@/tests/helpers/consent-memory";
import { memorySpendStore } from "@/tests/helpers/spend-memory";
import { memoryVideoFiles, memoryVideoStore } from "@/tests/helpers/video-memory";

// The whole video pipeline in memory (p5-a2): videos/posts/scripts/brands (tests/helpers/video-memory.ts),
// provider_usage (spend-memory), qa_reports, pronunciations, the private videos bucket, plus a
// PipelineStore (Gates 3 and 4) and an EditStore (lib/edit-flow.ts) over the SAME rows. The mock
// HeyGen client (MOCK_HEYGEN path: fixture answers, never a fetch) renders through lib/render.ts.
// createQaRerender mirrors the create_qa_rerender rpc (migration 20261122220000).

export const RAW_BYTES = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

type Extra = {
  post_id: string;
  transcript: unknown;
  final_path: string | null;
  ai_label: boolean;
  watermark: boolean;
  edit_manifest: unknown;
  rerender_of: string | null;
  qa_fix_note: string | null;
  edit_run_id: string | null;
  /** p5-b2: which gate's automatic fix made this video. */
  rerender_gate: "audio" | "visual" | null;
};

type ScriptExtra = Omit<GateContext["script"], "id" | "post_id" | "spoken_text" | "display_text">;

export type SeedPostInput = {
  displayText: string;
  hook: string;
  cta: string;
  format?: "talking" | "story";
  editPlan?: GateContext["script"]["edit_plan"];
  brollKeywords?: string[];
  dictionary?: PronunciationEntry[];
  /** p5-b2: several posts of one brand (default: the one fixed post/script id). */
  postId?: string;
  scriptId?: string;
};

export function memoryPipeline(opts: { personName?: string; language?: string; maxSeconds?: number; spendCaps?: { render?: number } } = {}) {
  const v = memoryVideoStore();
  const spend = memorySpendStore({ caps: opts.spendCaps ?? null });
  const bucket = memoryVideoFiles();
  const heygen = createHeygenClient({ mock: true });
  const extras = new Map<string, Extra>();
  const scriptExtras = new Map<string, ScriptExtra>();
  const postFormat = new Map<string, "talking" | "story">();
  const reports: VideoQaReport[] = [];
  /** brand_qa_settings.team_reviews_every_video (no entry = true). */
  const brandQaSettings = new Map<string, boolean>();
  const pronunciations: (PronunciationEntry & { brand_id: string; source: "manual" | "qa" })[] = [];
  const brandInfo = {
    offers: "Free check-up for new patients" as string | null,
    language: opts.language ?? "en",
    is_managed: true,
    autopilot_level: "review_everything",
  };
  v.brands[0].name = "Bright Smile Dental";

  const postOf = (row: VideoRow) => v.scripts.find((s) => s.id === row.script_id)?.post_id ?? "";
  const extra = (row: VideoRow): Extra => {
    let e = extras.get(row.id);
    if (!e) {
      e = {
        post_id: postOf(row), transcript: null, final_path: null, ai_label: true, watermark: false,
        edit_manifest: null, rerender_of: null, qa_fix_note: null, edit_run_id: null, rerender_gate: null,
      };
      extras.set(row.id, e);
    }
    return e;
  };
  const video = (id: string) => v.videos.find((row) => row.id === id);
  const entries = (brandId: string): PronunciationEntry[] =>
    pronunciations.filter((p) => p.brand_id === brandId).map(({ written, say_as, status }) => ({ written, say_as, status }));

  const store: PipelineStore = {
    async getGateContext(videoId) {
      const row = video(videoId);
      if (!row) return null;
      const e = extra(row);
      const script = v.scripts.find((s) => s.id === row.script_id)!;
      const post = v.posts.find((p) => p.id === script.post_id)!;
      const b = v.brands.find((x) => x.id === row.brand_id)!;
      const sx = scriptExtras.get(script.id)!;
      return structuredClone({
        video: {
          id: row.id, brand_id: row.brand_id, post_id: e.post_id, script_id: script.id, kind: row.kind, status: row.status,
          attempt: row.attempt, raw_path: row.raw_path, final_path: e.final_path, duration_s: row.duration_s, transcript: e.transcript,
          ai_label: e.ai_label, watermark: e.watermark, counts_toward_plan: row.counts_toward_plan, edit_manifest: e.edit_manifest,
          qa_fix_note: e.qa_fix_note, edit_run_id: e.edit_run_id,
        },
        script: { id: script.id, post_id: script.post_id, display_text: script.display_text ?? "", spoken_text: script.spoken_text ?? "", ...sx },
        post: { id: post.id, status: post.status, format: postFormat.get(post.id) ?? "talking" },
        brand: {
          id: b.id, name: b.name, niche: "dentist", audience: null, offers: brandInfo.offers, tone: null, sound_answers: {}, samples: null,
          banned_words: [], language: brandInfo.language, profile_md: null, pillars: [], words_per_second: b.words_per_second,
          is_managed: brandInfo.is_managed, autopilot_level: brandInfo.autopilot_level,
        },
        personName: opts.personName ?? "Ayesha Khan",
        dictionary: entries(b.id),
        maxSeconds: opts.maxSeconds ?? 60,
      });
    },
    async moveVideo(videoId, to, from, error) {
      const row = video(videoId);
      if (!row || !from.includes(row.status)) return false;
      row.status = to;
      if (error !== undefined) row.error = error;
      return true;
    },
    async setPostStatus(postId, status, reason) {
      await v.store.setPostStatus(postId, status, reason);
    },
    async saveTranscript(videoId, transcript) {
      extra(video(videoId)!).transcript = structuredClone(transcript);
    },
    async insertQaReport(row) {
      reports.push(structuredClone(row));
    },
    async countFailedReports(videoId, gate) {
      return reports.filter((r) => r.video_id === videoId && r.gate === gate && !r.passed).length;
    },
    async saveQaRespelling(brandId, written, sayAs) {
      const found = pronunciations.find((p) => p.brand_id === brandId && p.written.toLowerCase() === written.toLowerCase());
      if (found) Object.assign(found, { say_as: sayAs, status: "approved", source: "qa" });
      else pronunciations.push({ brand_id: brandId, written, say_as: sayAs, status: "approved", source: "qa" });
    },
    async updateSpokenText(scriptId, spokenText) {
      v.scripts.find((s) => s.id === scriptId)!.spoken_text = spokenText;
    },
    // Mirrors create_qa_rerender (migration 20261122220000); one JS turn = the per-post lock.
    async createQaRerender(videoId, spokenWords, fixNote) {
      const row = video(videoId);
      if (!row || row.kind !== "post") return { outcome: "not_found", videoId: null };
      if (row.status !== "audio_qa") return { outcome: "not_allowed", videoId: null };
      if (row.attempt > 1) return { outcome: "limit", videoId: null };
      const postId = postOf(row);
      const latest = v.scripts.filter((s) => s.post_id === postId).sort((a, b) => b.version - a.version)[0];
      if (latest?.id !== row.script_id) return { outcome: "not_allowed", videoId: null };
      const old = extra(row);
      Object.assign(row, { status: "failed", error: "Failed the audio check (Gate 3); re-rendered once at our cost." });
      const made = await v.store.insertVideo({
        brand_id: row.brand_id, script_id: row.script_id, avatar_id: row.avatar_id, kind: "post", engine: row.engine, spoken_words: spokenWords,
      });
      Object.assign(video(made.id)!, { attempt: row.attempt + 1, counts_toward_plan: false });
      extras.set(made.id, {
        post_id: postId, transcript: null, final_path: null, ai_label: old.ai_label, watermark: old.watermark, edit_manifest: null,
        rerender_of: row.id, qa_fix_note: fixNote, edit_run_id: null, rerender_gate: "audio",
      });
      return { outcome: "created", videoId: made.id };
    },
    // p5-b2 (Gate 5, human review, usage rule).
    async countFailedScriptReports(scriptId, gate) {
      return reports.filter((r) => r.script_id === scriptId && r.gate === gate && !r.passed).length;
    },
    async countBrandPostsPassed(brandId, gate, excludePostId) {
      const posts = new Set<string>();
      for (const r of reports) {
        const row = video(r.video_id);
        if (!row || row.brand_id !== brandId || r.gate !== gate || !r.passed) continue;
        const post = extra(row).post_id;
        if (post !== excludePostId) posts.add(post);
      }
      return posts.size;
    },
    async teamReviewsEveryVideo(brandId) {
      return brandQaSettings.get(brandId) ?? true;
    },
    async prepareReedit(videoId, fixNote, reason) {
      const row = video(videoId);
      if (!row || row.status !== "final_qa") return false;
      Object.assign(row, { status: "audio_qa", error: reason });
      extra(row).qa_fix_note = fixNote;
      return true;
    },
    // Mirrors create_visual_rerender (migration 20261123000000).
    async createVisualRerender(videoId, fixNote) {
      const row = video(videoId);
      if (!row || row.kind !== "post") return { outcome: "not_found", videoId: null };
      if (row.status !== "final_qa") return { outcome: "not_allowed", videoId: null };
      const postId = postOf(row);
      const latest = v.scripts.filter((s) => s.post_id === postId).sort((a, b) => b.version - a.version)[0];
      if (latest?.id !== row.script_id) return { outcome: "not_allowed", videoId: null };
      if (v.videos.filter((x) => x.script_id === row.script_id && extra(x).rerender_gate === "visual").length >= 1) {
        return { outcome: "limit", videoId: null };
      }
      const old = extra(row);
      Object.assign(row, { status: "failed", error: "Failed the visual check (Gate 5); re-rendered once at our cost." });
      const made = await v.store.insertVideo({
        brand_id: row.brand_id, script_id: row.script_id, avatar_id: row.avatar_id, kind: "post", engine: row.engine, spoken_words: row.spoken_words,
      });
      Object.assign(video(made.id)!, { attempt: row.attempt + 1, counts_toward_plan: false });
      extras.set(made.id, {
        post_id: postId, transcript: null, final_path: null, ai_label: old.ai_label, watermark: old.watermark, edit_manifest: null,
        rerender_of: row.id, qa_fix_note: fixNote, edit_run_id: null, rerender_gate: "visual",
      });
      return { outcome: "created", videoId: made.id };
    },
    // Mirrors deliver_post_video (migration 20261123000000).
    async deliverVideo(videoId) {
      const row = video(videoId);
      if (!row || row.kind !== "post") return "not_found";
      if (row.status !== "final_qa") return "not_allowed";
      const postId = postOf(row);
      for (const other of v.videos) if (other.id !== row.id && postOf(other) === postId) other.counts_toward_plan = false;
      Object.assign(row, { status: "ready", counts_toward_plan: true, error: null });
      await v.store.setPostStatus(postId, "ready", null);
      return "delivered";
    },
  };

  // lib/edit-flow.ts EditStore over the same rows (mirrors start_edit and the owner-only saves).
  const editStore: EditStore = {
    async getVideo(id) {
      const row = video(id);
      if (!row) return null;
      const e = extra(row);
      return {
        id: row.id, brand_id: row.brand_id, kind: row.kind, status: row.status, raw_path: row.raw_path, final_path: e.final_path,
        transcript: structuredClone(e.transcript), error: row.error, ai_label: e.ai_label, watermark: e.watermark,
      };
    },
    async startEdit(id, run) {
      const row = video(id);
      if (!row || row.kind !== "post" || !row.raw_path) return false;
      const e = extra(row);
      if (!(["rendered", "audio_qa"].includes(row.status) || (row.status === "editing" && e.edit_run_id === run))) return false;
      Object.assign(row, { status: "editing", error: null });
      e.edit_run_id = run;
      return true;
    },
    async saveTranscript(id, run, transcript) {
      const row = video(id)!;
      if (row.status !== "editing" || extra(row).edit_run_id !== run) return false;
      extra(row).transcript = structuredClone(transcript);
      return true;
    },
    async finishEdit(id, run, patch) {
      const row = video(id)!;
      const e = extra(row);
      if (row.status !== "editing" || e.edit_run_id !== run) return false;
      Object.assign(row, { status: patch.status, error: patch.error });
      e.final_path = patch.final_path;
      if ("edit_manifest" in patch) e.edit_manifest = structuredClone(patch.edit_manifest);
      return true;
    },
    async setPostStatusForVideo(id, status, reason) {
      const row = video(id);
      if (row) await v.store.setPostStatus(postOf(row), status, reason);
    },
  };

  const files: EditFiles & { download(path: string): Promise<Uint8Array> } = {
    async download(path) {
      const f = bucket.files[path];
      if (!f) throw new Error(`no such object ${path}`);
      return f.bytes;
    },
    async upload(path, bytes, contentType) {
      await bucket.storage.upload(path, bytes, contentType);
    },
    async remove(path) {
      delete bucket.files[path];
    },
  };

  /** A ready twin, an approved post with a passed script whose spoken_text is built from the dictionary. */
  let twinSeeded = false;
  async function seedPost(input: SeedPostInput) {
    if (!twinSeeded) await v.seedReadyTwin();
    twinSeeded = true;
    for (const e of input.dictionary ?? []) pronunciations.push({ ...e, brand_id: BRAND_ID, source: "manual" });
    const spoken = buildSpokenText(input.displayText, entries(BRAND_ID));
    const { postId, scriptId } = v.seedApprovedPost({ spoken, id: input.postId, scriptId: input.scriptId });
    v.scripts.find((s) => s.id === scriptId)!.display_text = input.displayText;
    scriptExtras.set(scriptId, {
      hook: input.hook,
      cta: input.cta,
      est_seconds: estimateSeconds(input.displayText, 2.4),
      edit_plan: input.editPlan ?? { broll_moments: [], emphasis_words: [] },
      broll_keywords: input.brollKeywords ?? [],
    });
    postFormat.set(postId, input.format ?? "talking");
    return { postId, scriptId };
  }

  const renderDeps = () => ({ videos: v.store, heygen, spend: spend.store });
  /** Make video → the mock HeyGen POST (spend guard, claim) → finished (raw MP4 in the bucket). */
  async function makeVideo(postId: string, durationS = 7.6): Promise<string> {
    const row = await createPostRender(postId, { videos: v.store });
    await renderVideo(row.id, renderDeps());
    await finishRender(row.id, durationS);
    return row.id;
  }
  /** The webhook/poll part of a render: HeyGen says done → download → 'rendered'. */
  async function finishRender(videoId: string, durationS = 7.6) {
    return completeRender(videoId, { ok: true, videoUrl: null, durationS }, {
      videos: v.store, heygen, files: bucket.storage, download: async () => RAW_BYTES,
    });
  }

  return {
    v, spend, bucket, heygen, store, editStore, files, extras, reports, pronunciations, brandInfo, postFormat, brandQaSettings,
    seedPost, makeVideo, finishRender, render: (id: string) => renderVideo(id, renderDeps()), video, extra,
  };
}
