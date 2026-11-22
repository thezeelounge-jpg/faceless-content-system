import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffprobeBin, probeArgs } from "@/lib/clip-checks/media";
import { runFfmpeg, type FfmpegRunner } from "@/lib/edit-flow";
import { audioFilterGraph, getMusicLibrary, type MusicLibrary } from "@/lib/music";
import { PlainError } from "@/lib/plain-error";
import { EDIT, TECH_QA } from "@/lib/qa/config";
import { editManifestSchema } from "@/lib/qa/edit-manifest";
import type { PipelineStore } from "@/lib/qa/pipeline-types";
import type { QaIssue } from "@/lib/qa/script-checks";
import {
  firstOfMoovMdat,
  parseBlackdetect,
  parseEbur128,
  parseFinalProbe,
  parseFreezedetect,
  technicalIssues,
} from "@/lib/qa/technical-checks";
import { transcriptSchema } from "@/lib/stt";

// Gate 4: Technical QA (QA-SPEC), after the edit. ffprobe + ffmpeg filters, no AI.
//
//  1. Only a post video in 'final_qa' with a final file is checked.
//  2. ffprobe (size, codecs, fps, sample rate, length) + the file's top-level boxes (moov before
//     mdat = +faststart) + ONE ffmpeg pass over the final file: blackdetect, freezedetect and
//     ebur128 (peak=true: integrated LUFS and true peak).
//  3. Music vs voice: the editor's own audio chain (lib/music.ts audioFilterGraph, the same bed,
//     bed_gain_db and sidechain ducking) is run twice on the raw voice + the bed, once rendering only
//     the voice stem and once only the music stem, each measured with ebur128. Loudnorm is left out:
//     in linear mode it is one constant gain on the mix, so it moves both stems equally and the gap
//     between them is the gap in the final mix.
//  4. The edit manifest (what the editor built) gives caption pages + word times, b-roll cuts and
//     the protected hook/CTA, the bed, label/watermark; checked by lib/qa/technical-checks.ts.
//  5. ONE qa_reports row (gate 'technical', score = integrated LUFS). Passed → stays final_qa
//     (ready for Gate 5). Failed the first time → back to audio_qa so the edit is rebuilt ONCE (all
//     edit settings come from code: the rebuild re-runs the editor; a deterministic problem fails
//     again). Failed again → team_review with the issues. Never needs_you; never counted.

export type TechnicalGateDeps = {
  store: PipelineStore;
  files: { download(path: string): Promise<Uint8Array> };
  /** Default: runFfmpeg (FFMPEG_PATH, no shell, time limit). */
  ffmpeg?: FfmpegRunner;
  /** ffprobe -show_format -show_streams JSON. Default: the local ffprobe. */
  probeJson?: (file: string) => Promise<string>;
  /** Default: getMusicLibrary() (the mock set). The same seed (video id) picks the same bed as the edit. */
  music?: MusicLibrary;
  tmpRoot?: string;
};

export type TechnicalGateOutcome =
  | { status: "passed"; videoId: string }
  /** Back to audio_qa: the caller starts the edit again (once). */
  | { status: "rebuild"; videoId: string; reason: string }
  | { status: "team_review"; videoId: string; reason: string }
  | { status: "skipped"; videoId: string; why: string };

const LEAD = ["-nostdin", "-hide_banner", "-nostats"];

/** One pass over the final file: black and frozen frames (video), loudness and true peak (audio). Nothing is written. */
export function finalMeasureArgs(file: string): string[] {
  if (!path.isAbsolute(file)) throw new Error("The final video must be an absolute file path.");
  const q = TECH_QA;
  return [
    ...LEAD, "-i", file,
    "-filter_complex",
    `[0:v]blackdetect=d=${q.black_report_s}:pix_th=${q.black_pix_th},freezedetect=n=${q.freeze_noise_db}dB:d=${q.freeze_report_s}[v];` +
      "[0:a]ebur128=peak=true:framelog=quiet[a]",
    "-map", "[v]", "-map", "[a]", "-f", "null", "-",
  ];
}

/** The editor's audio chain on the raw voice + the bed, rendering one stem only, measured with ebur128. */
export function stemMeasureArgs(input: { raw: string; bed: string; durationS: number; stem: "voice" | "music" }): string[] {
  for (const file of [input.raw, input.bed]) if (!path.isAbsolute(file)) throw new Error("Stem inputs must be absolute file paths.");
  return [
    ...LEAD, "-i", input.raw, "-stream_loop", "-1", "-i", input.bed,
    "-filter_complex",
    `${audioFilterGraph({ music: { input: 1, durationS: input.durationS }, loudness: null, stem: input.stem })};[aout]ebur128=peak=true:framelog=quiet[m]`,
    "-map", "[m]", "-f", "null", "-",
  ];
}

/** The local ffprobe's JSON for a file (no shell, time limit). */
export const probeFinalJson = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      ffprobeBin(),
      probeArgs(file),
      { encoding: "utf8", timeout: EDIT.probe_timeout_s * 1000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => (error ? reject(new Error(`ffprobe failed: ${stderr.slice(-400)}`, { cause: error })) : resolve(stdout)),
    );
  });

/** moov or mdat first, read from the file's box headers. */
async function boxOrder(file: string): Promise<"moov" | "mdat" | null> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const headers = new Map<number, Buffer>();
    // firstOfMoovMdat is synchronous: read the chain of headers first (at most 64 boxes).
    let offset = 0;
    for (let n = 0; n < 64 && offset < size; n++) {
      const buf = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buf, 0, 16, offset);
      const header = buf.subarray(0, bytesRead);
      headers.set(offset, header);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (type === "moov" || type === "mdat") break;
      if (boxSize === 1 && bytesRead >= 16) boxSize = Number(header.readBigUInt64BE(8));
      if (boxSize < 8) break;
      offset += boxSize;
    }
    return firstOfMoovMdat((at) => headers.get(at) ?? null);
  } finally {
    await handle.close();
  }
}

const hard = (code: string, detail: string): QaIssue => ({ code, detail, at_seconds: null, severity: "hard" });

export async function runTechnicalGate(videoId: string, deps: TechnicalGateDeps): Promise<TechnicalGateOutcome> {
  const ctx = await deps.store.getGateContext(videoId);
  if (!ctx) throw new PlainError("Video not found.");
  const { video, script, brand } = ctx;
  if (video.kind !== "post") throw new PlainError("Only post videos go through the technical check.");
  if (video.status !== "final_qa") return { status: "skipped", videoId, why: `it is ${video.status}` };
  if (!video.final_path) throw new PlainError("The video has no final file yet.");
  const failedBefore = await deps.store.countFailedReports(video.id, "technical");
  const ffmpeg = deps.ffmpeg ?? runFfmpeg;

  const workDir = await mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), "tech-qa-"));
  let issues: QaIssue[];
  let score: number | null = null;
  try {
    const manifest = editManifestSchema.safeParse(video.edit_manifest);
    if (!manifest.success) {
      issues = [hard("no_manifest", "The edit did not record what it built (edit_manifest), so it can't be checked.")];
    } else {
      const finalFile = path.join(workDir, "final.mp4");
      await writeFile(finalFile, await deps.files.download(video.final_path));
      const probe = parseFinalProbe(await (deps.probeJson ?? probeFinalJson)(finalFile));
      const boxFirst = await boxOrder(finalFile);
      const { stderr } = await ffmpeg(finalMeasureArgs(finalFile), { timeoutS: TECH_QA.measure_timeout_s });
      const loudness = parseEbur128(stderr);
      score = loudness && Number.isFinite(loudness.i) ? Math.round(loudness.i * 10) / 10 : null;

      let stems: { voice: number; music: number } | null = null;
      const extra: QaIssue[] = [];
      if (manifest.data.music && video.raw_path) {
        const bed = (deps.music ?? getMusicLibrary()).pick(video.id);
        if (bed.id === manifest.data.music.bed_id) {
          const rawFile = path.join(workDir, "raw.mp4");
          await writeFile(rawFile, await deps.files.download(video.raw_path));
          const measure = async (stem: "voice" | "music") =>
            parseEbur128(
              (await ffmpeg(stemMeasureArgs({ raw: rawFile, bed: bed.file, durationS: manifest.data.raw_duration_s, stem }), { timeoutS: TECH_QA.measure_timeout_s }))
                .stderr,
            )?.i ?? NaN;
          const voice = await measure("voice");
          const music = await measure("music");
          // NaN = no summary (not measured); -inf is a real answer (silence).
          if (!Number.isNaN(voice) && !Number.isNaN(music)) stems = { voice, music };
        }
      }
      const transcript = transcriptSchema.safeParse(video.transcript);
      if (!transcript.success) extra.push(hard("no_transcript", "No speech-to-text transcript on the video, so caption timing can't be checked."));
      issues = [
        ...technicalIssues({
          probe,
          boxFirst,
          loudness,
          black: parseBlackdetect(stderr),
          freeze: parseFreezedetect(stderr, probe.durationS),
          stems,
          manifest: manifest.data,
          transcript: transcript.success ? transcript.data : { language: "en", duration_s: 0, words: [] },
          displayText: script.display_text,
          names: [brand.name, ...ctx.dictionary.filter((e) => e.status === "approved").map((e) => e.written)],
          aiLabel: video.ai_label,
          watermark: video.watermark,
          maxSeconds: ctx.maxSeconds,
        }),
        ...extra,
      ];
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const passed = issues.every((i) => i.severity !== "hard");
  await deps.store.insertQaReport({
    video_id: video.id,
    script_id: script.id,
    gate: "technical",
    passed,
    score,
    issues,
    auto_fix: failedBefore > 0 ? "Rebuilt the edit once." : null,
  });
  if (passed) {
    await deps.store.setPostStatus(video.post_id, "final_qa", null);
    return { status: "passed", videoId: video.id };
  }

  const problems = issues.filter((i) => i.severity === "hard").map((i) => i.detail).join(" ");
  if (failedBefore < TECH_QA.max_rebuilds) {
    const reason = `Technical check failed; rebuilding the edit once: ${problems}`.slice(0, 1000);
    if (await deps.store.moveVideo(video.id, "audio_qa", ["final_qa"], reason)) {
      await deps.store.setPostStatus(video.post_id, "editing", null);
      return { status: "rebuild", videoId: video.id, reason };
    }
  }
  const reason = `Technical check failed${failedBefore > 0 ? " after one rebuild" : ""}: ${problems}`.slice(0, 1000);
  // p5-b1 (QA NICE 6): the post follows only when THIS run moved the video (else it moved on).
  if (!(await deps.store.moveVideo(video.id, "team_review", ["final_qa"], reason))) return { status: "skipped", videoId: video.id, why: "it moved on" };
  await deps.store.setPostStatus(video.post_id, "team_review", reason);
  return { status: "team_review", videoId: video.id, reason };
}
