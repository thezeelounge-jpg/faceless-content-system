import "server-only";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logAdminError } from "@/lib/admin-errors";
import { buildSpokenText, pronunciationInput, type PronunciationEntry } from "@/lib/pronunciation/dictionary";
import { ClaudeError } from "@/lib/claude";
import { probeDurationS, runFfmpeg } from "@/lib/edit-flow";
import { PlainError } from "@/lib/plain-error";
import {
  audioHealthIssues,
  compareTranscript,
  keyTermsFor,
  maxWerFor,
  parseAstats,
  parseSilenceRanges,
  referenceText,
  type Astats,
  type KeyTermKind,
  type TermMismatch,
  type TimeRange,
} from "@/lib/qa/audio-checks";
import { AUDIO_QA } from "@/lib/qa/config";
import type { PipelineStore } from "@/lib/qa/pipeline-types";
import type { QaIssue } from "@/lib/qa/script-checks";
import type { RunTask } from "@/lib/qa/script-pipeline";
import type { RenderStart } from "@/lib/render";
import { countWords } from "@/lib/scripts";
import { getSttProvider, transcriptSchema, type SttLanguage, type SttProvider, type Transcript } from "@/lib/stt";
import type { VideoRowStatus } from "@/lib/video-store-types";

// Gate 3: Audio and pronunciation QA (QA-SPEC), after the render and before the edit.
//
//  1. Only a post video that is 'rendered' (or 'audio_qa': a retry) is checked; video + post → audio_qa.
//  2. Transcript: the one saved on the row (a retry never pays twice), else speech-to-text on the raw
//     MP4 (lib/stt.ts, MOCK_STT; the spoken text goes along as a hint), saved to videos.transcript.
//     The editor reuses it for caption timings. HeyGen's SRT is never used.
//  3. Checks (lib/qa/audio-checks.ts): WER against spoken_text (respellings turned back into the
//     written word), key terms (Claude FAST decides same sound vs mispronounced), audio health
//     (silence inside speech, clipping, duration vs est_seconds and the plan maximum).
//  4. ONE qa_reports row (gate 'audio'); auto_fix = the fix that made this video (a re-render), or null.
//  5. Passed → video and post stay audio_qa: the edit is next (lib/qa/pipeline.ts).
//     Failed, first render, and every hard problem is one a re-render can fix (key terms, WER,
//     silence, clipping): ONE automatic fix: each mispronounced word gets an APPROVED dictionary
//     respelling (source 'qa'), spoken_text is rebuilt, rpc create_qa_rerender makes attempt 2
//     (counts_toward_plan = false) and it is rendered through the normal path (renderVideo: spend
//     guard, claim, 10-at-once cap; in real mode it still needs the admin's spend OK).
//     Otherwise (a second fail, or a problem a re-render can't fix) → team_review with the exact
//     words and times. Never needs_you: our failures never reach the customer.

export type AudioMeasure = { durationS: number; silences: TimeRange[]; astats: Astats };

export type AudioGateDeps = {
  store: PipelineStore;
  files: { download(path: string): Promise<Uint8Array> };
  /** Claude tasks: runClaudeTask in the app (MOCK_CLAUDE by default), a mock in tests. */
  run: RunTask;
  /** Sends the re-render through the normal render path (lib/render.ts renderVideo). */
  render: (videoId: string) => Promise<RenderStart>;
  /** Default: getSttProvider() (the mock unless MOCK_STT is exactly "false"). */
  stt?: SttProvider;
  /** Default: ffmpeg silencedetect + astats and ffprobe on the raw file (measureRawAudio). */
  measureAudio?: (file: string) => Promise<AudioMeasure>;
  tmpRoot?: string;
};

export type AudioGateOutcome =
  | { status: "passed"; videoId: string; transcript: Transcript }
  /** videoId = the NEW video (the one automatic re-render). */
  | { status: "rerendering"; videoId: string; previousVideoId: string; render: RenderStart }
  /** The re-render was made but could not be sent (e.g. real HeyGen needs the admin's spend OK). */
  | { status: "rerender_blocked"; videoId: string; reason: string }
  | { status: "team_review"; videoId: string; reason: string }
  | { status: "skipped"; videoId: string; why: string };

const CHECKABLE: VideoRowStatus[] = ["rendered", "audio_qa"];
/** Hard problems a fresh render (with new respellings) can fix. Duration problems can't. */
const FIXABLE = new Set(["key_term", "wer", "silence", "clipping"]);
const KIND_WORDS: Record<KeyTermKind, string> = {
  brand: "brand name",
  person: "person",
  offer: "offer",
  cta: "call to action",
  dictionary: "dictionary word",
};
const STT_LANGUAGE: Record<string, SttLanguage> = { en: "en", roman_urdu: "ur", hinglish: "hi" };

/** ffmpeg: silences of at least AUDIO_QA.max_silence_s and the overall sample peak, audio only, nothing written. */
export function audioMeasureArgs(file: string): string[] {
  if (!path.isAbsolute(file)) throw new Error("The raw video must be an absolute file path.");
  return [
    "-nostdin", "-hide_banner", "-nostats", "-i", file, "-vn",
    "-af", `silencedetect=noise=${AUDIO_QA.silence_noise_db}dB:d=${AUDIO_QA.max_silence_s},astats=measure_perchannel=none`,
    "-f", "null", "-",
  ];
}

/** The real measurement (local ffmpeg + ffprobe, no shell, time limits). */
export async function measureRawAudio(file: string): Promise<AudioMeasure> {
  const { stderr } = await runFfmpeg(audioMeasureArgs(file), { timeoutS: AUDIO_QA.measure_timeout_s });
  const durationS = await probeDurationS(file);
  return { durationS, silences: parseSilenceRanges(stderr, durationS), astats: parseAstats(stderr) };
}

const pairKey = (written: string, heard: string) => `${written.toLowerCase()}|${heard.toLowerCase()}`;
const at = (m: TermMismatch) => (m.at_seconds === null ? "" : ` at ${m.at_seconds} s`);
const heardAs = (m: TermMismatch) =>
  m.heard ? `"${m.term.written}" (${KIND_WORDS[m.term.kind]}) was heard as "${m.heard}"${at(m)}` : `"${m.term.written}" (${KIND_WORDS[m.term.kind]}) was not heard${at(m)}`;

type Judged = { mismatch: TermMismatch; verdict: "same_sound" | "mispronounced"; respelling: string };

/** Claude (FAST) judges each key-term mismatch. If Claude can't answer, every one counts as mispronounced (fail safe). */
async function judgeMismatches(
  mismatches: TermMismatch[],
  ctx: { brand: Parameters<RunTask>[1]["brand"]; language: string },
  run: RunTask,
  notes: QaIssue[],
): Promise<Judged[]> {
  if (mismatches.length === 0) return [];
  const unique = [...new Map(mismatches.map((m) => [pairKey(m.term.written, m.heard), { written: m.term.written, heard: m.heard }])).values()];
  const answers = new Map<string, { verdict: Judged["verdict"]; respelling: string }>();
  try {
    const answer = await run("key_term_check", { brand: ctx.brand, input: { language: ctx.language, terms: unique.slice(0, 30) } });
    for (const j of answer.judgements) answers.set(pairKey(j.written, j.heard), { verdict: j.verdict, respelling: j.respelling.trim() });
  } catch (error) {
    if (!(error instanceof ClaudeError)) throw error;
    notes.push({ code: "key_term_judge_failed", detail: `Couldn't ask whether these are the same sound (${error.message})`, at_seconds: null, severity: "soft" });
  }
  return mismatches.map((mismatch) => {
    const a = answers.get(pairKey(mismatch.term.written, mismatch.heard));
    return { mismatch, verdict: a?.verdict ?? "mispronounced", respelling: a?.respelling ?? "" };
  });
}

export async function runAudioGate(videoId: string, deps: AudioGateDeps): Promise<AudioGateOutcome> {
  const ctx = await deps.store.getGateContext(videoId);
  if (!ctx) throw new PlainError("Video not found.");
  const { video, script, brand } = ctx;
  if (video.kind !== "post") throw new PlainError("Only post videos go through the audio check.");
  if (!CHECKABLE.includes(video.status)) return { status: "skipped", videoId, why: `it is ${video.status}` };
  if (!video.raw_path) throw new PlainError("The video has no raw file yet.");
  if (!(await deps.store.moveVideo(video.id, "audio_qa", CHECKABLE))) return { status: "skipped", videoId, why: "it moved on" };
  await deps.store.setPostStatus(video.post_id, "audio_qa", null);

  const workDir = await mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), "audio-qa-"));
  let transcript: Transcript;
  let measure: AudioMeasure;
  try {
    const rawFile = path.join(workDir, "raw.mp4");
    await writeFile(rawFile, await deps.files.download(video.raw_path));
    const saved = transcriptSchema.safeParse(video.transcript);
    if (saved.success) {
      transcript = saved.data;
    } else {
      transcript = transcriptSchema.parse(
        await (deps.stt ?? getSttProvider()).transcribe({
          audioPath: rawFile,
          language: STT_LANGUAGE[brand.language] ?? "en",
          expectedText: script.spoken_text,
        }),
      );
      await deps.store.saveTranscript(video.id, transcript);
    }
    measure = await (deps.measureAudio ?? measureRawAudio)(rawFile);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  // The checks.
  const notes: QaIssue[] = [];
  const terms = keyTermsFor({ brandName: brand.name, personName: ctx.personName, offers: brand.offers, cta: script.cta, entries: ctx.dictionary });
  const compared = compareTranscript({ reference: referenceText(script.spoken_text, ctx.dictionary), heard: transcript.words, terms });
  const judged = await judgeMismatches(compared.mismatches, { brand, language: brand.language }, deps.run, notes);
  const issues: QaIssue[] = [];
  const maxWer = maxWerFor(brand.language);
  if (compared.wer > maxWer) {
    const pct = (n: number) => Math.round(n * 1000) / 10;
    issues.push({ code: "wer", detail: `Word error rate ${pct(compared.wer)}% (limit ${pct(maxWer)}%).`, at_seconds: null, severity: "hard" });
  }
  for (const j of judged) {
    if (j.verdict === "same_sound") {
      issues.push({ code: "key_term_same_sound", detail: `${heardAs(j.mismatch)}: the same sound (a spelling variant).`, at_seconds: j.mismatch.at_seconds, severity: "soft" });
    } else {
      issues.push({ code: "key_term", detail: `${heardAs(j.mismatch)}.`, at_seconds: j.mismatch.at_seconds, severity: "hard" });
    }
  }
  const durationS = video.duration_s !== null && video.duration_s > 0 ? Number(video.duration_s) : measure.durationS;
  issues.push(
    ...audioHealthIssues({
      words: transcript.words,
      silences: measure.silences,
      astats: measure.astats,
      durationS,
      estSeconds: Number(script.est_seconds),
      maxSeconds: ctx.maxSeconds,
    }),
  );
  issues.push(...notes);
  const hardIssues = issues.filter((i) => i.severity === "hard");
  const keyTermFails = hardIssues.filter((i) => i.code === "key_term").length;
  const passed = hardIssues.length === 0 && keyTermFails <= AUDIO_QA.max_key_term_mismatches;

  await deps.store.insertQaReport({
    video_id: video.id,
    script_id: script.id,
    gate: "audio",
    passed,
    score: Math.round(compared.wer * 1000) / 1000,
    issues,
    auto_fix: video.qa_fix_note,
  });
  if (passed) return { status: "passed", videoId: video.id, transcript };

  const toTeam = async (reason: string): Promise<AudioGateOutcome> => {
    const text = reason.slice(0, 1000);
    // p5-b1 (QA NICE 6): the post follows only when THIS run moved the video (else it moved on).
    if (!(await deps.store.moveVideo(video.id, "team_review", ["audio_qa"], text))) return { status: "skipped", videoId: video.id, why: "it moved on" };
    await deps.store.setPostStatus(video.post_id, "team_review", text);
    return { status: "team_review", videoId: video.id, reason: text };
  };
  const teamReason = `Audio check failed${video.attempt > 1 ? " after one re-render" : ""}: ${hardIssues.map((i) => i.detail).join(" ")}`;
  const canFix = video.attempt <= AUDIO_QA.max_rerenders && hardIssues.every((i) => FIXABLE.has(i.code));
  if (!canFix) return toTeam(teamReason);

  // The one automatic fix: respell the mispronounced words, rebuild spoken_text, re-render once.
  const fixes = new Map<string, { written: string; sayAs: string }>();
  for (const j of judged) {
    if (j.verdict !== "mispronounced") continue;
    const entry = pronunciationInput.safeParse({ written: j.mismatch.term.written, say_as: j.respelling });
    if (entry.success && !fixes.has(entry.data.written.toLowerCase())) {
      fixes.set(entry.data.written.toLowerCase(), { written: entry.data.written, sayAs: entry.data.say_as });
    }
  }
  let spoken = script.spoken_text;
  if (fixes.size > 0) {
    for (const f of fixes.values()) await deps.store.saveQaRespelling(brand.id!, f.written, f.sayAs);
    const dictionary: PronunciationEntry[] = [
      ...ctx.dictionary.filter((e) => !fixes.has(e.written.trim().toLowerCase())),
      ...[...fixes.values()].map((f) => ({ written: f.written, say_as: f.sayAs, status: "approved" as const })),
    ];
    spoken = buildSpokenText(script.display_text, dictionary);
    if (spoken !== script.spoken_text) await deps.store.updateSpokenText(script.id, spoken);
  }
  const list = [...fixes.values()].map((f) => `${f.written} → ${f.sayAs}`).join(", ");
  const note =
    fixes.size > 0
      ? `Re-rendered once with ${fixes.size === 1 ? "a new respelling" : "new respellings"}: ${list}.`
      : `Re-rendered once (${[...new Set(hardIssues.map((i) => i.code))].join(", ")}).`;
  const made = await deps.store.createQaRerender(video.id, countWords(spoken), note);
  if (made.outcome !== "created" || !made.videoId) return toTeam(teamReason);

  try {
    const render = await deps.render(made.videoId);
    return { status: "rerendering", videoId: made.videoId, previousVideoId: video.id, render };
  } catch (error) {
    // Nothing was sent (renderVideo refuses before any paid call: no spend OK, paused, daily cap).
    // The re-render stays queued; the post goes back to approved, so "Make video" finds it
    // (createPostRender answers 'existing') and the admin renders it with "I agree to spend".
    logAdminError("[audio-qa] the re-render was made but not sent", { videoId: made.videoId }, error);
    const why = error instanceof PlainError ? error.message : "The render could not be started.";
    const reason = `Audio check: one re-render (our cost) is queued but was not sent. ${why} A real render needs an admin's OK: press Make video and tick “I agree to spend”.`.slice(0, 1000);
    await deps.store.setPostStatus(video.post_id, "approved", reason);
    return { status: "rerender_blocked", videoId: made.videoId, reason };
  }
}
