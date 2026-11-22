import type { EditJob } from "@/lib/edit-flow";
import { runAudioGate, type AudioGateDeps, type AudioGateOutcome } from "@/lib/qa/audio-gate";
import type { GateContext } from "@/lib/qa/pipeline-types";
import { runTechnicalGate, type TechnicalGateDeps, type TechnicalGateOutcome } from "@/lib/qa/technical-gate";

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
  | { taskId: "technical-qa"; payload: { videoId: string }; key: string };

/** The edit-video payload from the rows: posts.format, scripts.* and videos.ai_label / watermark. */
export function editJobFor(ctx: GateContext): EditJob {
  return {
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
  if (outcome.status !== "rebuild") return { outcome, next: null };
  const ctx = await deps.store.getGateContext(videoId);
  if (!ctx) return { outcome, next: null };
  return { outcome, next: { taskId: "edit-video", payload: editJobFor(ctx), key: `edit-${videoId}-rebuild-1` } };
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
