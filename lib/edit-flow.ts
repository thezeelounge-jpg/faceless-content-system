import "server-only";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { logAdminError } from "@/lib/admin-errors";
import { scriptOutput } from "@/lib/ai-schemas";
import { getBrollProvider, planBroll, type BrollProvider } from "@/lib/broll";
import { CAPTION_STYLES, CAPTION_STYLE_NAMES, alignWords, buildAss } from "@/lib/captions";
import { ffprobeBin, ffmpegBin, parseProbe, probeArgs } from "@/lib/clip-checks/media";
import { buildEditArgs, buildLoudnessMeasureArgs, notYetApplied, type BrollCut, type EditExtras } from "@/lib/edit";
import { getMusicLibrary, parseLoudnormJson, type MusicLibrary } from "@/lib/music";
import { PlainError } from "@/lib/plain-error";
import { EDIT } from "@/lib/qa/config";
import { getSttProvider, transcriptSchema, type SttProvider, type Transcript } from "@/lib/stt";

// The edit job (Phase 4, docs/EDITOR-NOTES.md): raw HeyGen MP4 → finished
// 1080x1920 reel with word-by-word captions, b-roll, music, the AI label
// (and the trial watermark), normalised to -14 LUFS. Run by trigger/edit-video.ts.
//
//  1. Check the video row: a post render, status rendered / audio_qa / editing
//     (a retry), and the raw path in the payload is the row's own raw_path.
//  2. Claim the edit for this run (rpc start_edit, p4-b1: another run is
//     refused while the claim is fresh). Status → editing (video and post).
//  3. Download the raw MP4 from the PRIVATE videos bucket into a fresh temp folder.
//  4. Transcript: from the payload, else the one saved on the row (Gate 3
//     will save it in Phase 5), else speech-to-text (MOCK in this phase),
//     which is then saved to videos.transcript.
//  5. Captions (.ass) from display_text + transcript (lib/captions.ts).
//  6. p4-b2: the video's length (ffprobe); b-roll plan (lib/broll.ts) + one
//     clip per cut from the b-roll provider (MOCK_PEXELS); a music bed
//     (lib/music.ts); loudness pass 1 (ffmpeg, measure only).
//  7. ffmpeg with the args from lib/edit.ts (execFile, no shell, time limit).
//     AI label when the payload OR the row says so (default on); watermark when
//     the payload OR videos.watermark says trial; +faststart always.
//  8. Upload to final/<brand>/<video>.mp4; status → final_qa (Gate 4 is next),
//     but only if every requested extra is in the real ffmpeg argv; otherwise
//     team_review with a plain reason (p4-b1 publish guard: e.g. "AI label not added yet.").
//  On any failure: a plain error on the row, status team_review (video and
//  post), no final file left in storage, the temp folder always deleted.
//  All saves are only for the run that owns the claim (p4-b1).
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
  /** videos.ai_label (on by default). The label is drawn if this OR the row says so. */
  aiLabel: z.boolean().default(true),
  /**
   * Trial videos only. Where "trial" comes from: the video row's `watermark`
   * column (initial schema), set to true when a trial preview's video row is
   * made (PRODUCT.md: the free trial's one preview is watermarked; Phase 7
   * sets it from profiles.plan_status = 'trial'). The editor draws the
   * watermark if this OR videos.watermark is true, so a payload can never remove it.
   */
  watermark: z.boolean().default(false),
  /** posts.format: b-roll coverage limit (talking ≤ 25%, story ≤ 60%). */
  format: z.enum(["talking", "story"]).default("talking"),
  /** scripts.hook and scripts.cta: the face stays on screen while they are said. */
  hook: z.string().trim().min(1).max(1000),
  cta: z.string().trim().min(1).max(1000),
  /** scripts.broll_keywords: extra cuts when fewer than 2 edit_plan moments fit. */
  brollKeywords: z.array(z.string().min(1)).max(10).default([]),
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
  ai_label: boolean;
  watermark: boolean;
};

/** Video statuses an edit may start from ('editing' = a retry of a crashed run). */
export const EDITABLE_STATUSES = ["rendered", "audio_qa", "editing"] as const;

export interface EditStore {
  getVideo(id: string): Promise<EditVideoRow | null>;
  /**
   * p4-b1 (QA SF2), rpc start_edit: status → editing and the claim → `run`, only for a post
   * render with a raw_path that is rendered/audio_qa, or editing by the SAME run (a retry), or
   * editing under a claim older than EDIT.claim_stale_s. False = refused (another run edits it).
   */
  startEdit(id: string, run: string): Promise<boolean>;
  saveTranscript(id: string, transcript: Transcript): Promise<void>;
  /** Saves only while the row is still 'editing' and claimed by `run`. False = another run owns it now. */
  finishEdit(
    id: string,
    run: string,
    patch: { status: "final_qa" | "team_review"; final_path: string | null; error: string | null },
  ): Promise<boolean>;
  setPostStatusForVideo(id: string, status: "editing" | "final_qa" | "team_review", reason: string | null): Promise<void>;
}

/** The PRIVATE videos bucket. */
export interface EditFiles {
  download(path: string): Promise<Uint8Array>;
  /** Overwrites: a re-edit lands on the same path. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** timeoutS: default EDIT.ffmpeg_timeout_s (the final encode). */
export type FfmpegRunner = (args: string[], options?: { timeoutS?: number }) => Promise<{ stderr: string }>;

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
  /** This run's claim token (the task passes ctx.run.id, the same on a retry). Default: a fresh UUID. */
  runToken?: string;
  /** Default: getBrollProvider() (the mock unless MOCK_PEXELS is exactly "false"). */
  broll?: BrollProvider;
  /** Default: getMusicLibrary() (the mock set). */
  music?: MusicLibrary;
  /** The raw video's length in seconds. Default: ffprobe. */
  probeDurationS?: (file: string) => Promise<number>;
};

export type EditOutcome =
  | { status: "edited"; finalPath: string; notApplied: string[] }
  | { status: "failed"; error: string }
  /** p4-b1 (QA SF3): edited, but a requested extra was not applied → team_review, never final_qa. */
  | { status: "needs_team"; finalPath: string; notApplied: string[] }
  /** p4-b1: another run took over this video's edit; this run changed nothing it does not own. */
  | { status: "superseded" };

/** Plain errors saved on videos.error (admin wording; customers never see this column). */
export const EDIT_ERRORS = {
  ffmpeg: "The editor could not make this video (ffmpeg failed). The team will look at it.",
  download: "The raw video could not be loaded from storage.",
  upload: "The finished video could not be saved to storage.",
  fonts: "The caption fonts are missing from this build (assets/fonts).",
  generic: "The edit failed for an unexpected reason. The team will look at it.",
} as const;

export const TEAM_EDIT_REASON = "The edit failed. Open the video to see why.";

/**
 * p4-b1 (QA SF3), permanent publish guard: a requested extra that the editor did not apply
 * (notYetApplied) never lets a video reach final_qa. Team wording for posts.status_reason.
 */
export const EXTRAS_TEAM_REASON = "The edit is missing something it needs (for example the AI label). Open the video to see what.";

/** One plain sentence per missing extra, saved on videos.error (admin wording). */
const MISSING_EXTRA: Record<string, string> = {
  ai_label: "AI label not added yet.",
  watermark: "Trial watermark not added yet.",
  broll: "B-roll not added yet.",
  music: "Music not added yet.",
  faststart: "Fast start not set yet.",
  loudness: "Loudness not set yet.",
};

export function missingExtrasMessage(names: string[]): string {
  return names.map((n) => MISSING_EXTRA[n] ?? `${n} not added yet.`).join(" ");
}

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
export const runFfmpeg: FfmpegRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      ffmpegBin(),
      args,
      {
        encoding: "utf8",
        timeout: (options?.timeoutS ?? EDIT.ffmpeg_timeout_s) * 1000,
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
        shell: false,
      },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`ffmpeg failed: ${stderr.slice(-800)}`, { cause: error }));
        else resolve({ stderr });
      },
    );
  });

/** The video's length in seconds (ffprobe, FFPROBE_PATH, no shell, time limit). */
export const probeDurationS = (file: string): Promise<number> =>
  new Promise((resolve, reject) => {
    execFile(
      ffprobeBin(),
      probeArgs(file),
      { encoding: "utf8", timeout: EDIT.probe_timeout_s * 1000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`ffprobe failed: ${stderr.slice(-400)}`, { cause: error }));
        const { durationS } = parseProbe(stdout);
        if (!(durationS > 0)) return reject(new Error("ffprobe found no length"));
        resolve(durationS);
      },
    );
  });

const refuse = (why: string) => new PlainError(`This video can't be edited: ${why}.`);

type Stage = "download" | "transcript" | "fonts" | "probe" | "broll" | "music" | "loudness" | "ffmpeg" | "upload";

function plainMessage(error: unknown, stage: Stage): string {
  if (error instanceof PlainError) return error.message;
  if (stage === "download") return EDIT_ERRORS.download;
  if (stage === "probe" || stage === "loudness" || stage === "ffmpeg") return EDIT_ERRORS.ffmpeg;
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
  const run = deps.runToken ?? randomUUID();
  if (!(await deps.store.startEdit(video.id, run))) throw refuse("it is not waiting for an edit (or another edit is running)");
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
      buildAss({
        displayText: job.displayText,
        transcript,
        style: job.captionStyle,
        brandColour: job.brandColour,
        emphasisWords: job.editPlan.emphasis_words,
      }),
      "utf8",
    );

    stage = "fonts";
    const fontsDir = deps.fontsDir ?? captionFontsDir();
    try {
      await Promise.all(Object.values(CAPTION_STYLES).map((s) => access(path.join(fontsDir, s.font_file))));
    } catch (error) {
      throw new PlainError(EDIT_ERRORS.fonts, { cause: error });
    }

    stage = "probe";
    const durationS = await (deps.probeDurationS ?? probeDurationS)(rawFile);

    // p4-b2: b-roll. The plan is pure (lib/broll.ts); each cut gets the provider's best clip
    // that is long enough, a different clip per cut when there is one. A cut with no clip is dropped.
    stage = "broll";
    const plan = planBroll({
      words: alignWords(job.displayText, transcript),
      moments: job.editPlan.broll_moments,
      keywords: job.brollKeywords,
      format: job.format,
      durationS,
      hook: job.hook,
      cta: job.cta,
    });
    const provider = deps.broll ?? getBrollProvider();
    const broll: BrollCut[] = [];
    const usedClips = new Set<string>();
    for (const cut of plan.cuts) {
      const clips = await provider.search(cut.keyword, { orientation: "portrait", minDuration_s: cut.duration_s });
      const clip = clips.find((c) => !usedClips.has(c.id)) ?? clips[0];
      if (!clip) continue;
      usedClips.add(clip.id);
      broll.push({ path: clip.file, start_s: cut.start_s, duration_s: cut.duration_s });
    }
    console.info(
      `[edit] broll video=${video.id} cuts=${broll.length} coverage=${plan.coverage_s}s/${plan.max_coverage_s}s skipped=${plan.skipped.map((s) => s.why).join(",") || "none"}`,
    );

    stage = "music";
    const bed = (deps.music ?? getMusicLibrary()).pick(video.id);

    // p4-b2: loudness pass 1 (the same audio chain, measure only); pass 2 is in the final command.
    stage = "loudness";
    const measured = parseLoudnormJson(
      (await deps.ffmpeg(buildLoudnessMeasureArgs({ input: rawFile, musicPath: bed.file, durationS }), { timeoutS: EDIT.loudness_timeout_s })).stderr,
    );

    stage = "ffmpeg";
    const finalFile = path.join(workDir, "final.mp4");
    const extras: EditExtras = {
      broll,
      music: { path: bed.file },
      loudness: measured,
      ai_label: job.aiLabel || video.ai_label,
      watermark: job.watermark || video.watermark,
      faststart: true,
    };
    const args = buildEditArgs({ input: rawFile, output: finalFile, captionsPath: captionsFile, fontsDir, durationS, extras });
    await deps.ffmpeg(args);
    if ((await stat(finalFile)).size === 0) throw new Error("ffmpeg wrote an empty file");

    stage = "upload";
    uploadStarted = true;
    await deps.files.upload(finalPath, new Uint8Array(await readFile(finalFile)), "video/mp4");
    // p4-b1 (QA SF3): never final_qa while a requested extra (the AI label above all) is missing
    // from the command ffmpeg actually ran. The file is kept (final_path saved) for the team.
    const notApplied = notYetApplied(extras, args);
    if (notApplied.length > 0) {
      const saved = await deps.store.finishEdit(video.id, run, {
        status: "team_review",
        final_path: finalPath,
        error: missingExtrasMessage(notApplied),
      });
      if (!saved) return { status: "superseded" };
      await deps.store.setPostStatusForVideo(video.id, "team_review", EXTRAS_TEAM_REASON);
      return { status: "needs_team", finalPath, notApplied };
    }
    if (!(await deps.store.finishEdit(video.id, run, { status: "final_qa", final_path: finalPath, error: null }))) {
      // Another run took over (our claim went stale). Our file is a valid edit on the same
      // path; the row and post belong to the other run now, so touch nothing else.
      console.warn(`[edit] superseded after upload video=${video.id}`);
      return { status: "superseded" };
    }
    await deps.store.setPostStatusForVideo(video.id, "final_qa", null);
    return { status: "edited", finalPath, notApplied: [] };
  } catch (error) {
    const message = plainMessage(error, stage);
    logAdminError("[edit] failed", { videoId: video.id, stage }, error);
    // p4-b1 (QA SF2): record the failure only while THIS run still owns the claim. If another
    // run took over (and maybe finished: final_qa), its row, post and final file are not ours.
    const owned = await deps.store.finishEdit(video.id, run, { status: "team_review", final_path: null, error: message });
    if (!owned) return { status: "superseded" };
    // Never leave a half-written or unrecorded final in storage (ours: the row is team_review now).
    if (uploadStarted) await deps.files.remove(finalPath).catch((e) => logAdminError("[edit] cleanup failed", { videoId: video.id }, e));
    await deps.store.setPostStatusForVideo(video.id, "team_review", TEAM_EDIT_REASON);
    return { status: "failed", error: message };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
