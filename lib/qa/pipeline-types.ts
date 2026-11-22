import type { ScriptOutput } from "@/lib/ai-schemas";
import type { PronunciationEntry } from "@/lib/pronunciation/dictionary";
import type { QaIssue } from "@/lib/qa/script-checks";
import type { QaBrand } from "@/lib/qa/script-pipeline";
import type { VideoRowStatus } from "@/lib/video-store-types";

// The rows the video QA gates (Gate 3 audio, Gate 4 technical) read and write.
// The real store is lib/qa/pipeline-store.ts (Supabase, secret key, server
// only); tests use tests/helpers/pipeline-memory.ts.

export type PipelineVideo = {
  id: string;
  brand_id: string;
  post_id: string;
  script_id: string;
  kind: "post" | "likeness_test";
  status: VideoRowStatus;
  /** 1 = the first render; 2 = our one QA re-render (videos.rerender_of points at the first). */
  attempt: number;
  raw_path: string | null;
  final_path: string | null;
  duration_s: number | null;
  transcript: unknown;
  ai_label: boolean;
  watermark: boolean;
  counts_toward_plan: boolean;
  /** What the editor built (lib/qa/edit-manifest.ts), saved with the final file. */
  edit_manifest: unknown;
  /** The automatic fix that made this video (a Gate 3 re-render), or null. */
  qa_fix_note: string | null;
  /** p5-b1: the edit run that holds (or last held) the edit claim (= the edit-video Trigger run id). */
  edit_run_id: string | null;
};

export type PipelineScript = {
  id: string;
  post_id: string;
  display_text: string;
  spoken_text: string;
  hook: string;
  cta: string;
  est_seconds: number;
  edit_plan: ScriptOutput["edit_plan"];
  broll_keywords: string[];
};

export type GateContext = {
  video: PipelineVideo;
  script: PipelineScript;
  post: { id: string; status: string; format: "talking" | "story" };
  brand: QaBrand;
  /** consents.person_legal_name of the twin (a key term), or null. */
  personName: string | null;
  /** The brand's "How to say names" rows (approved and suggested). */
  dictionary: PronunciationEntry[];
  /** The brand owner's plan limit (lib/plans.ts max_seconds_per_video). */
  maxSeconds: number;
};

/** One qa_reports row written by a video gate. */
export type VideoQaReport = {
  video_id: string;
  script_id: string;
  gate: "audio" | "technical" | "visual";
  passed: boolean;
  score: number | null;
  issues: QaIssue[];
  auto_fix: string | null;
};

export type RerenderOutcome = { outcome: "created" | "limit" | "not_allowed" | "not_found"; videoId: string | null };

/** p5-b2: rpc deliver_post_video. */
export type DeliverOutcome = "delivered" | "not_allowed" | "not_found";

export interface PipelineStore {
  getGateContext(videoId: string): Promise<GateContext | null>;
  /** Moves the video to `to` only while it is in one of `from`. False = it was not. */
  moveVideo(videoId: string, to: VideoRowStatus, from: VideoRowStatus[], error?: string | null): Promise<boolean>;
  setPostStatus(postId: string, status: string, reason: string | null): Promise<void>;
  saveTranscript(videoId: string, transcript: unknown): Promise<void>;
  insertQaReport(row: VideoQaReport): Promise<void>;
  /** How many FAILED reports this video already has for this gate (one automatic fix per gate). */
  countFailedReports(videoId: string, gate: VideoQaReport["gate"]): Promise<number>;
  /** Gate 3 auto-fix: add (or update) the word as APPROVED, source 'qa' (only approved rows are applied). */
  saveQaRespelling(brandId: string, written: string, sayAs: string): Promise<void>;
  updateSpokenText(scriptId: string, spokenText: string): Promise<void>;
  /** rpc create_qa_rerender: the one automatic re-render (attempt 2, counts_toward_plan = false). */
  createQaRerender(videoId: string, spokenWords: number, fixNote: string): Promise<RerenderOutcome>;

  // p5-b2: Gate 5 (visual and realism) and the human-review / usage rules.
  /** FAILED reports of this gate for the SCRIPT (all its videos): Gate 5's one fix is per script, re-renders included. */
  countFailedScriptReports(scriptId: string, gate: VideoQaReport["gate"]): Promise<number>;
  /** How many OTHER posts of the brand have a video that passed this gate (the first-5 rule). */
  countBrandPostsPassed(brandId: string, gate: VideoQaReport["gate"], excludePostId: string): Promise<number>;
  /** brand_qa_settings.team_reviews_every_video (no row = true). Only used for managed brands. */
  teamReviewsEveryVideo(brandId: string): Promise<boolean>;
  /** Gate 5 re-edit: final_qa → audio_qa (the edit can start), qa_fix_note = the fix. False = the video moved on. */
  prepareReedit(videoId: string, fixNote: string, reason: string): Promise<boolean>;
  /** rpc create_visual_rerender: Gate 5's one re-render per script (counts_toward_plan = false). */
  createVisualRerender(videoId: string, fixNote: string): Promise<RerenderOutcome>;
  /** rpc deliver_post_video: final_qa → ready; this video counts, every other video of the post does not; post → ready. */
  deliverVideo(videoId: string): Promise<DeliverOutcome>;
}
