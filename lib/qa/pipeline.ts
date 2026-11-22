import { logAdminError } from "@/lib/admin-errors";
import type { EditJob } from "@/lib/edit-flow";
import { runAudioGate, type AudioGateDeps, type AudioGateOutcome } from "@/lib/qa/audio-gate";
import { editManifestSchema } from "@/lib/qa/edit-manifest";
import type { GateContext, PipelineStore } from "@/lib/qa/pipeline-types";
import { runTechnicalGate, type TechnicalGateDeps, type TechnicalGateOutcome } from "@/lib/qa/technical-gate";
import { runVisualGate, type VisualGateDeps, type VisualGateOutcome } from "@/lib/qa/visual-gate";

// The QA pipeline orchestrator (Phase 5, p5-a2): which gate runs after which step, and what runs
// next. The Trigger.dev tasks stay thin: they call these and trigger the task named in `next`
// (by id, with `key` as a global idempotency key, so a retry never starts a step twice).
//
//   render finished ('rendered', poll-render)   → audio-qa      (Gate 3)
//   Gate 3 passed                                → edit-video
//   Gate 3 failed once (fixable)                 → the re-render was sent → poll-render (or render-video when all slots were busy)
//   edit finished into final_qa                  → technical-qa  (Gate 4)
//   Gate 4 failed once                           → edit-video again (the one rebuild)
//   Gate 4 passed                                → ready for Gate 5 (part 5b): nothing yet
//   anything else (team_review, blocked)         → nothing: the team queue has it
//
// Statuses (docs/PRODUCT.md): video + post rendering → audio_qa → editing → final_qa; failures
// after the one automatic fix → team_review (never needs_you). Our re-renders never count.

export type NextTask =
  | { taskId: "edit-video"; payload: EditJob; key: string }
  | { taskId: "poll-render"; payload: { videoId: string }; key: string }
  | { taskId: "render-video"; payload: { videoId: string }; key: string }
  | { taskId: "audio-qa"; payload: { videoId: string }; key: string }
  | { taskId: "technical-qa"; payload: { videoId: string }; key: string }
  | { taskId: "visual-qa"; payload: { videoId: string }; key: string };

/**
 * Gate 5 on an edit that passed Gate 4, then the next step: the one re-edit (edit-video with the
 * fixed caption style / the rejected b-roll clip avoided), the poll for the one re-render (or
 * render-video when all slots are busy), or nothing (delivered, in the QA queue, or the team has it).
 */
export async function afterVisual(videoId: string, deps: VisualGateDeps): Promise<{ outcome: VisualGateOutcome; next: NextTask | null }> {
  const outcome = await runVisualGate(videoId, deps);
  if (outcome.status === "reedit") {
    const ctx = await deps.store.getGateContext(videoId);
    if (!ctx) return { outcome, next: null };
    const job = editJobFor(ctx);
    const payload: EditJob = {
      ...job,
      captionStyle: outcome.captionStyle ?? job.captionStyle,
      avoidBrollClips: [...new Set([...(job.avoidBrollClips ?? []), ...outcome.avoidClips])],
    };
    return { outcome, next: { taskId: "edit-video", payload, key: `edit-${videoId}-visual-1` } };
  }
  if (outcome.status === "rerendering") {
    const id = outcome.videoId;
    if (outcome.render.status === "waiting") return { outcome, next: { taskId: "render-video", payload: { videoId: id }, key: `render-${id}` } };
    return { outcome, next: { taskId: "poll-render", payload: { videoId: id }, key: `poll-render-${id}` } };
  }
  return { outcome, next: null };
}

/**
 * The edit-video payload from the rows: posts.format, scripts.* and videos.ai_label / watermark.
 * p5-b2: when the video was already edited, its manifest's caption style and avoided b-roll clips are
 * kept, so a Gate 4 rebuild after a Gate 5 re-edit never undoes the Gate 5 fix.
 */
export function editJobFor(ctx: GateContext): EditJob {
  const manifest = editManifestSchema.safeParse(ctx.video.edit_manifest);
  return {
    ...(manifest.success ? { captionStyle: manifest.data.caption_style, avoidBrollClips: manifest.data.avoid_clips } : {}),
    videoId: ctx.video.id,
    rawPath: ctx.video.raw_path ?? "",
    displayText: ctx.script.display_text,
    editPlan: ctx.script.edit_plan,
    hook: ctx.script.hook,
    cta: ctx.script.cta,
    format: ctx.post.format,
    brollKeywords: ctx.script.broll_keywords.slice(0, 10),
    // The editor also ORs these with the row, so a payload can never remove the label or the watermark.
    aiLabel: ctx.video.ai_label,
    watermark: ctx.video.watermark,
  };
}

/** Gate 3 on a finished render, then the next step. */
export async function afterRender(videoId: string, deps: AudioGateDeps): Promise<{ outcome: AudioGateOutcome; next: NextTask | null }> {
  const outcome = await runAudioGate(videoId, deps);
  if (outcome.status === "passed") {
    const ctx = await deps.store.getGateContext(videoId);
    if (!ctx) return { outcome, next: null };
    return { outcome, next: { taskId: "edit-video", payload: editJobFor(ctx), key: `edit-${videoId}-1` } };
  }
  if (outcome.status === "rerendering") {
    const id = outcome.videoId;
    // All 10 render slots busy: the render task waits for one. Otherwise the poll finishes it.
    if (outcome.render.status === "waiting") return { outcome, next: { taskId: "render-video", payload: { videoId: id }, key: `render-${id}` } };
    return { outcome, next: { taskId: "poll-render", payload: { videoId: id }, key: `poll-render-${id}` } };
  }
  return { outcome, next: null };
}

/** Gate 4 on a finished edit, then the next step (the one rebuild, or nothing). */
export async function afterEdit(
  videoId: string,
  deps: TechnicalGateDeps,
): Promise<{ outcome: TechnicalGateOutcome; next: NextTask | null }> {
  const outcome = await runTechnicalGate(videoId, deps);
  if (outcome.status !== "rebuild" && outcome.status !== "passed") return { outcome, next: null };
  const ctx = await deps.store.getGateContext(videoId);
  if (!ctx) return { outcome, next: null };
  // p5-b2: passed → Gate 5, one key per edit run (a retry of Gate 4 never starts Gate 5 twice;
  // the re-edit after a Gate 5 fix is a new edit run, so it gets its own Gate 5).
  if (outcome.status === "passed") {
    return { outcome, next: { taskId: "visual-qa", payload: { videoId }, key: `visual-qa-${videoId}-${ctx.video.edit_run_id ?? "edit"}` } };
  }
  return { outcome, next: { taskId: "edit-video", payload: editJobFor(ctx), key: `edit-${videoId}-rebuild-1` } };
}

export const GATE_CRASH_REASONS = {
  audio: "The audio check stopped with an error. The team will look at this video.",
  technical: "The technical check stopped with an error. The team will look at this video.",
  visual: "The visual check stopped with an error. The team will look at this video.",
} as const;

/** The status a video waits in while each gate runs: only a row still there is moved. Gate 5 runs while it is final_qa. */
const GATE_STATUS = { audio: "audio_qa", technical: "final_qa", visual: "final_qa" } as const;

/**
 * p5-b1 (QA SF1): the audio-qa / technical-qa task crashed and will not be retried (the task's
 * onFailure hook). The video (still in that gate's status) and its post go to team_review with a
 * plain reason, so nothing is left stuck. Safe to run more than once: a row that already left the
 * gate's status (a later run moved it on, or this ran before) is never touched. True = it moved.
 */
export async function gateCrashed(
  gate: keyof typeof GATE_CRASH_REASONS,
  videoId: string,
  error: unknown,
  store: PipelineStore,
): Promise<boolean> {
  logAdminError(`[${gate}-qa] the gate crashed and will not be retried`, { videoId }, error);
  const ctx = await store.getGateContext(videoId);
  if (!ctx || ctx.video.kind !== "post") return false;
  const reason = GATE_CRASH_REASONS[gate];
  if (!(await store.moveVideo(videoId, "team_review", [GATE_STATUS[gate]], reason))) return false;
  await store.setPostStatus(ctx.video.post_id, "team_review", reason);
  return true;
}

export const RESYNC_TEAM_REASON = "The edit finished but needs a look from the team.";

/**
 * p5-b1 (Rowan 4): the edit was saved and promoted (videos.final_path set, video final_qa or
 * team_review) but the post update after it failed (lib/edit-flow.ts afterPromotion only logs it),
 * so the post is stuck in 'editing'. Moves the post to the status the video implies and, for a
 * final_qa video, hands back Gate 4 with the SAME key edit-video uses for that edit run
 * (`technical-qa-<video>-<edit run>`, global idempotency key): Gate 4 never starts twice.
 * Idempotent: once the post is not in 'editing' it is not touched again.
 */
export async function resyncAfterEdit(videoId: string, store: PipelineStore): Promise<{ moved: boolean; next: NextTask | null }> {
  const ctx = await store.getGateContext(videoId);
  if (!ctx) return { moved: false, next: null };
  const { video, post } = ctx;
  if (video.kind !== "post" || !video.final_path || (video.status !== "final_qa" && video.status !== "team_review")) {
    return { moved: false, next: null };
  }
  let moved = false;
  if (post.status === "editing") {
    await store.setPostStatus(post.id, video.status, video.status === "team_review" ? RESYNC_TEAM_REASON : null);
    moved = true;
  }
  const next = video.status === "final_qa" && video.edit_run_id ? afterEditTask({ status: "edited" }, video.id, video.edit_run_id) : null;
  return { moved, next };
}

/** poll-render finished: a post render that is now 'rendered' goes to Gate 3. */
export function afterPoll(result: { done: boolean; status: string }, video: { id: string; kind: string } | null): NextTask | null {
  if (!result.done || result.status !== "rendered" || !video || video.kind !== "post") return null;
  return { taskId: "audio-qa", payload: { videoId: video.id }, key: `audio-qa-${video.id}` };
}

/** edit-video finished: an edit that reached final_qa goes to Gate 4 (one key per edit run). */
export function afterEditTask(outcome: { status: string }, videoId: string, run: string): NextTask | null {
  if (outcome.status !== "edited") return null;
  return { taskId: "technical-qa", payload: { videoId }, key: `technical-qa-${videoId}-${run}` };
}
