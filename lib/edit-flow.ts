import "server-only";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { logAdminError } from "@/lib/admin-errors";
import { scriptOutput } from "@/lib/ai-schemas";
import { CAPTION_STYLES, CAPTION_STYLE_NAMES, buildAss } from "@/lib/captions";
import { ffmpegBin } from "@/lib/clip-checks/media";
import { buildEditArgs, notYetApplied } from "@/lib/edit";
import { PlainError } from "@/lib/plain-error";
import { EDIT } from "@/lib/qa/config";
import { getSttProvider, transcriptSchema, type SttProvider, type Transcript } from "@/lib/stt";

// The edit job (Phase 4, docs/EDITOR-NOTES.md): raw HeyGen MP4 → finished
// 1080x1920 reel with word-by-word captions. Run by trigger/edit-video.ts.
//
//  1. Check the video row: a post render, status rendered / audio_qa / editing
//     (a retry), and the raw path in the payload is the row's own raw_path.
//  2. Status → editing (video and post).
//  3. Download the raw MP4 from the PRIVATE videos bucket into a fresh temp folder.
//  4. Transcript: from the payload, else the one saved on the row (Gate 3
//     will save it in Phase 5), else speech-to-text (MOCK in this phase),
//     which is then saved to videos.transcript.
//  5. Captions (.ass) from display_text + transcript (lib/captions.ts).
//  6. ffmpeg with the args from lib/edit.ts (execFile, no shell, time limit).
//  7. Upload to final/<brand>/<video>.mp4; status → final_qa (Gate 4 is next).
//  On any failure: a plain error on the row, status team_review (video and
//  post), no final file left in storage, the temp folder always deleted.
//  Store, storage, ffmpeg and speech-to-text are injected; tests use fakes.

export const editJobSchema = z.object({
  videoId: z.string().uuid(),
  /** raw/<brand uuid>/<video uuid>.mp4, as saved by lib/render.ts (checked against the row too). */
  rawPath: z.string().max(200).regex(/^raw\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/i),
  transcript: transcriptSchema.optional(),
  displayText: z.string().trim().min(1).max(5000),
  /** Used by part B (b-roll moments); carried now so the payload does not change. */
  editPlan: scriptOutput.shape.edit_plan,
  brandColour: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
  captionStyle: z.enum(CAPTION_STYLE_NAMES).default("big_words"),
  aiLabel: z.boolean().default(true),
  watermark: z.boolean().default(false),
});
export type EditJob = z.input<typeof editJobSchema>;

export type EditVideoRow = {
  id: string;
  brand_id: string;
  kind: "post" | "likeness_test";
  status: string;
  raw_path: string | null;
  final_path: string | null;
  transcript: unknown;
  error: string | null;
};

/** Video statuses an edit may start from ('editing' = a retry of a crashed run). */
export const EDITABLE_STATUSES = ["rendered", "audio_qa", "editing"] as const;

export interface EditStore {
  getVideo(id: string): Promise<EditVideoRow | null>;
  /** Status → editing, only for a post render in EDITABLE_STATUSES with a raw_path. False = refused. */
  startEdit(id: string): Promise<boolean>;
  saveTranscript(id: string, transcript: Transcript): Promise<void>;
  finishEdit(id: string, patch: { status: "final_qa" | "team_review"; final_path: string | null; error: string | null }): Promise<void>;
  setPostStatusForVideo(id: string, status: "editing" | "final_qa" | "team_review", reason: string | null): Promise<void>;
}

/** The PRIVATE videos bucket. */
export interface EditFiles {
  download(path: string): Promise<Uint8Array>;
  /** Overwrites: a re-edit lands on the same path. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export type FfmpegRunner = (args: string[]) => Promise<{ stderr: string }>;

export type EditDeps = {
  store: EditStore;
  files: EditFiles;
  ffmpeg: FfmpegRunner;
  /** Default: getSttProvider() (the mock unless MOCK_STT is exactly "false"). */
  stt?: SttProvider;
  /** Default: captionFontsDir(). */
  fontsDir?: string;
  /** Default: the system temp folder. */
  tmpRoot?: string;
};

export type EditOutcome =
  | { status: "edited"; finalPath: string; notApplied: string[] }
  | { status: "failed"; error: string };

/** Plain errors saved on videos.error (admin wording; customers never see this column). */
export const EDIT_ERRORS = {
  ffmpeg: "The editor could not make this video (ffmpeg failed). The team will look at it.",
  download: "The raw video could not be loaded from storage.",
  upload: "The finished video could not be saved to storage.",
  fonts: "The caption fonts are missing from this build (assets/fonts).",
  generic: "The edit failed for an unexpected reason. The team will look at it.",
} as const;

export const TEAM_EDIT_REASON = "The edit failed. Open the video to see why.";

export function finalPathFor(brandId: string, videoId: string): string {
  return `final/${brandId}/${videoId}.mp4`;
}

/**
 * assets/fonts next to the app. Locally and in `trigger dev` process.cwd() is
 * the project folder; in a deployed Trigger.dev task it is the build folder,
 * where the additionalFiles extension copies assets/fonts (trigger.config.ts;
 * docs: "use path.join(process.cwd(), ...)"). Check on the first deploy.
 */
export function captionFontsDir(): string {
  return path.join(process.cwd(), "assets", "fonts");
}

/** Runs ffmpeg (FFMPEG_PATH, as the clip checks do) without a shell, with a time limit. */
export const runFfmpeg: FfmpegRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      ffmpegBin(),
      args,
      { encoding: "utf8", timeout: EDIT.ffmpeg_timeout_s * 1000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, shell: false },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`ffmpeg failed: ${stderr.slice(-800)}`, { cause: error }));
        else resolve({ stderr });
      },
    );
  });

const refuse = (why: string) => new PlainError(`This video can't be edited: ${why}.`);

type Stage = "download" | "transcript" | "fonts" | "ffmpeg" | "upload";

function plainMessage(error: unknown, stage: Stage): string {
  if (error instanceof PlainError) return error.message;
  if (stage === "download") return EDIT_ERRORS.download;
  if (stage === "ffmpeg") return EDIT_ERRORS.ffmpeg;
  if (stage === "upload") return EDIT_ERRORS.upload;
  return EDIT_ERRORS.generic;
}

export async function runEditJob(input: EditJob, deps: EditDeps): Promise<EditOutcome> {
  const job = editJobSchema.parse(input);
  const video = await deps.store.getVideo(job.videoId);
  if (!video) throw refuse("we can't find it");
  if (video.kind !== "post") throw refuse("it is a likeness test");
  if (!video.raw_path || video.raw_path !== job.rawPath) throw refuse("the raw file does not match this video");
  if (!(EDITABLE_STATUSES as readonly string[]).includes(video.status)) throw refuse(`it is ${video.status}`);
  if (!(await deps.store.startEdit(video.id))) throw refuse("it is not waiting for an edit");
  await deps.store.setPostStatusForVideo(video.id, "editing", null);

  const finalPath = finalPathFor(video.brand_id, video.id);
  const workDir = await mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), "edit-"));
  let stage: Stage = "download";
  let uploadStarted = false;
  try {
    const rawFile = path.join(workDir, "raw.mp4");
    await writeFile(rawFile, await deps.files.download(video.raw_path));

    stage = "transcript";
    let transcript = job.transcript ?? null;
    if (!transcript) {
      const saved = transcriptSchema.safeParse(video.transcript);
      if (saved.success) transcript = saved.data;
    }
    if (!transcript) {
      transcript = transcriptSchema.parse(await (deps.stt ?? getSttProvider()).transcribe({ audioPath: rawFile }));
      await deps.store.saveTranscript(video.id, transcript);
    }
    const captionsFile = path.join(workDir, "captions.ass");
    await writeFile(
      captionsFile,
      buildAss({ displayText: job.displayText, transcript, style: job.captionStyle, brandColour: job.brandColour }),
      "utf8",
    );

    stage = "fonts";
    const fontsDir = deps.fontsDir ?? captionFontsDir();
    try {
      await Promise.all(Object.values(CAPTION_STYLES).map((s) => access(path.join(fontsDir, s.font_file))));
    } catch (error) {
      throw new PlainError(EDIT_ERRORS.fonts, { cause: error });
    }

    stage = "ffmpeg";
    const finalFile = path.join(workDir, "final.mp4");
    const extras = { ai_label: job.aiLabel, watermark: job.watermark };
    await deps.ffmpeg(buildEditArgs({ input: rawFile, output: finalFile, captionsPath: captionsFile, fontsDir, extras }));
    if ((await stat(finalFile)).size === 0) throw new Error("ffmpeg wrote an empty file");

    stage = "upload";
    uploadStarted = true;
    await deps.files.upload(finalPath, new Uint8Array(await readFile(finalFile)), "video/mp4");
    await deps.store.finishEdit(video.id, { status: "final_qa", final_path: finalPath, error: null });
    await deps.store.setPostStatusForVideo(video.id, "final_qa", null);
    return { status: "edited", finalPath, notApplied: notYetApplied(extras) };
  } catch (error) {
    const message = plainMessage(error, stage);
    logAdminError("[edit] failed", { videoId: video.id, stage }, error);
    // Never leave a half-written or unrecorded final in storage.
    if (uploadStarted) await deps.files.remove(finalPath).catch((e) => logAdminError("[edit] cleanup failed", { videoId: video.id }, e));
    await deps.store.finishEdit(video.id, { status: "team_review", final_path: null, error: message });
    await deps.store.setPostStatusForVideo(video.id, "team_review", TEAM_EDIT_REASON);
    return { status: "failed", error: message };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
