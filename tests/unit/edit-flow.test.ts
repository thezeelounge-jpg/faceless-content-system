import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import script from "@/tests/fixtures/stt/sample-script.json";
import fixture from "@/tests/fixtures/stt/sample-transcript.json";
import {
  BROLL_TEAM_REASONS,
  EDIT_ERRORS,
  EXTRAS_TEAM_REASON,
  TEAM_EDIT_REASON,
  captionFontsDir,
  editJobSchema,
  finalPathFor,
  missingExtrasMessage,
  runEditJob,
  type EditFiles,
  type EditStore,
  type EditVideoRow,
  type FfmpegRunner,
} from "@/lib/edit-flow";
import { BROLL_NOT_SET_UP } from "@/lib/broll";
import { notYetApplied } from "@/lib/edit";
import { LOUDNORM_SILENT, MUSIC_NOT_SET_UP, fixtureMusicLibrary } from "@/lib/music";
import { EDIT, MUSIC } from "@/lib/qa/config";
import { editManifestSchema } from "@/lib/qa/edit-manifest";
import { NO_STT_PROVIDER, type SttProvider } from "@/lib/stt";

// lib/edit-flow.ts with fakes: no Supabase, no real ffmpeg (that is in
// tests/integration/edit-ffmpeg.test.ts), mock speech-to-text.

const BRAND = "10000000-0000-4000-8000-000000000001";
const VIDEO = "90000000-0000-4000-8000-000000000001";
const RAW = `raw/${BRAND}/${VIDEO}.mp4`;
const RUN = "run_test";
/** p4-b3: each run uploads to its own object (QA SF1). */
const FINAL = `final/${BRAND}/${VIDEO}/runs/${RUN}.mp4`;
const finalOf = (run: string) => `final/${BRAND}/${VIDEO}/runs/${run}.mp4`;
const RAW_BYTES = new Uint8Array([1, 2, 3, 4]);
const FINAL_BYTES = Buffer.from("finished mp4 bytes");

function memory(overrides: Partial<EditVideoRow> = {}) {
  const row: EditVideoRow & { edit_run_id: string | null; edit_started_at: number | null } = {
    id: VIDEO, brand_id: BRAND, kind: "post", status: "rendered", raw_path: RAW, final_path: null, transcript: null, error: null,
    ai_label: true, watermark: false, // the videos table defaults
    edit_run_id: null, edit_started_at: null,
    ...overrides,
  };
  const postStatuses: { status: string; reason: string | null }[] = [];
  // Mirrors start_edit (migration 20261122160000) and the owner-only finish in lib/edit-store.ts.
  const store: EditStore = {
    async getVideo(id) {
      return id === row.id ? { ...row } : null;
    },
    async startEdit(id, run) {
      if (id !== row.id || row.kind !== "post" || !row.raw_path) return false;
      const stale = row.edit_started_at === null || Date.now() - row.edit_started_at > EDIT.claim_stale_s * 1000;
      const free = ["rendered", "audio_qa"].includes(row.status) || (row.status === "editing" && (row.edit_run_id === run || stale));
      if (!free) return false;
      Object.assign(row, { status: "editing", error: null, edit_run_id: run, edit_started_at: Date.now() });
      return true;
    },
    async saveTranscript(_id, run, transcript) {
      // p5-a: like finishEdit, only while still 'editing' AND claimed by this run.
      if (row.status !== "editing" || row.edit_run_id !== run) return false;
      row.transcript = transcript;
      return true;
    },
    async finishEdit(_id, run, patch) {
      if (row.status !== "editing" || row.edit_run_id !== run) return false;
      Object.assign(row, patch);
      return true;
    },
    async setPostStatusForVideo(_id, status, reason) {
      postStatuses.push({ status, reason });
    },
  };
  const stored = new Map<string, { bytes: Uint8Array; type: string }>([[RAW, { bytes: RAW_BYTES, type: "video/mp4" }]]);
  const removed: string[] = [];
  const files: EditFiles = {
    async download(p) {
      const f = stored.get(p);
      if (!f) throw new Error(`no such object ${p}`);
      return f.bytes;
    },
    async upload(p, bytes, type) {
      stored.set(p, { bytes, type });
    },
    async remove(p) {
      removed.push(p);
      stored.delete(p);
    },
  };
  // p4-b2: the raw bytes here are not a real video, so the length comes from a fake ffprobe.
  const probeDurationS = async () => 6;
  return { row, store, files, stored, removed, postStatuses, probeDurationS, runToken: RUN };
}

/** What ffmpeg prints for loudness pass 1 (loudnorm print_format=json). */
const PASS1 = `[Parsed_loudnorm_5 @ 0x1] \n{\n\t"input_i" : "-19.43",\n\t"input_tp" : "-6.02",\n\t"input_lra" : "3.10",\n\t"input_thresh" : "-29.61",\n\t"target_offset" : "0.05"\n}\n`;
const isMeasurePass = (args: string[]) => args.at(-1) === "-" && args.includes("null");

let tmpRoot: string;
let seenAss: string;
let seenArgs: string[];
let calls: string[][];
const okFfmpeg: FfmpegRunner = async (args) => {
  calls.push(args);
  if (isMeasurePass(args)) return { stderr: PASS1 };
  seenArgs = args;
  const output = args.at(-1)!;
  seenAss = await readFile(path.join(path.dirname(output), "captions.ass"), "utf8");
  await writeFile(output, FINAL_BYTES);
  return { stderr: "" };
};
const job = {
  videoId: VIDEO,
  rawPath: RAW,
  displayText: script.display_text,
  editPlan: script.edit_plan,
  hook: "Stop scrolling!",
  cta: "Book a free call today.",
  brandColour: "#FF5A1F",
  captionStyle: "big_words" as const,
  aiLabel: false,
  watermark: false,
};

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "edit-flow-test-"));
  seenAss = "";
  seenArgs = [];
  calls = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("captionFontsDir (the ffmpeg fontsdir)", () => {
  it("p4-b1: holds only .ttf files (licences and README live in assets/fonts/licenses/, a sub-folder libass skips)", async () => {
    const entries = await readdir(captionFontsDir(), { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    expect(files.filter((name) => !name.endsWith(".ttf"))).toEqual([]);
    const licences = await readdir(path.join(captionFontsDir(), "licenses"), { recursive: true });
    expect(licences.map(String).sort()).toEqual(["README.md", "anton", "anton/OFL.txt", "poppins", "poppins/OFL.txt"]);
  });
});

describe("editJobSchema (the task payload)", () => {
  it("accepts a raw path in the videos bucket only, and fills defaults", () => {
    const parsed = editJobSchema.parse({ videoId: VIDEO, rawPath: RAW, displayText: "Hi", editPlan: script.edit_plan, hook: "Hi", cta: "Bye" });
    expect(parsed).toMatchObject({ captionStyle: "big_words", aiLabel: true, watermark: false, format: "talking", brollKeywords: [] });
    expect(editJobSchema.safeParse({ ...job, format: "dance" }).success).toBe(false);
    expect(editJobSchema.safeParse({ ...job, hook: "" }).success).toBe(false);
    for (const rawPath of ["../secret.mp4", `final/${BRAND}/${VIDEO}.mp4`, `raw/${BRAND}/${VIDEO}.mov`, "/etc/passwd"]) {
      expect(editJobSchema.safeParse({ ...job, rawPath }).success).toBe(false);
    }
    expect(editJobSchema.safeParse({ ...job, captionStyle: "huge" }).success).toBe(false);
    expect(editJobSchema.safeParse({ ...job, brandColour: "red" }).success).toBe(false);
  });
});

describe("runEditJob", () => {
  it("happy path: uploads the final video and saves final_path with status final_qa", async () => {
    const m = memory();
    const outcome = await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(outcome).toEqual({ status: "edited", finalPath: FINAL, notApplied: [] });
    expect(finalPathFor(BRAND, VIDEO, RUN)).toBe(FINAL);
    expect(() => finalPathFor(BRAND, VIDEO, "../x")).toThrow(/run id/);
    expect(m.row).toMatchObject({ status: "final_qa", final_path: FINAL, error: null });
    expect(Buffer.from(m.stored.get(FINAL)!.bytes).toString()).toBe("finished mp4 bytes");
    expect(m.stored.get(FINAL)!.type).toBe("video/mp4");
    expect(m.postStatuses).toEqual([
      { status: "editing", reason: null },
      { status: "final_qa", reason: null },
    ]);
    expect(seenArgs).toContain("-filter_complex");
    expect(seenArgs.join(" ")).toContain(`fontsdir=${captionFontsDir()}`);
    expect(await readdir(tmpRoot)).toEqual([]); // temp files cleaned up
  });

  it("p5-a2: the finished edit saves what it built (videos.edit_manifest) for Gate 4", async () => {
    const m = memory();
    await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir(), music: fixtureMusicLibrary() });
    const manifest = editManifestSchema.parse((m.row as Record<string, unknown>).edit_manifest);
    expect(manifest).toMatchObject({
      version: 1, raw_duration_s: 6, format: "talking", caption_style: "big_words",
      music: { bed_id: expect.stringMatching(/^bed-/), gain_db: MUSIC.bed_gain_db },
      ai_label: true, // the row's ai_label (on by default) wins over the payload's false
      watermark: false, not_applied: [],
    });
    expect(manifest.captions.length).toBeGreaterThan(1);
    expect(manifest.captions.every((page) => page.lines.length <= 2)).toBe(true);
    const words = manifest.captions.flatMap((page) => page.lines.flat());
    expect(words.map((w) => w.text).join(" ")).toBe(script.display_text);
    expect(words[0]).toMatchObject({ text: "Stop", source: "matched", stt_indexes: [0], start_s: fixture.words[0].start_s });
    expect(manifest.broll).toEqual([expect.objectContaining({ duration_s: expect.any(Number), clip: expect.any(String) })]);
    expect(manifest.protected).toEqual({ hook_end_s: expect.any(Number), cta_start_s: expect.any(Number) });
  });

  it("uses the mock speech-to-text when no transcript is given, and saves it on the row", async () => {
    const m = memory();
    await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(m.row.transcript).toEqual(fixture);
    expect(seenAss).toContain("{\\c&H1F5AFF&}STOP{\\c&HFFFFFF&}\\NSCROLLING!"); // p4-b1: 104 px, so one word per line here
    expect(seenAss).toContain("{\\c&H1F5AFF&}3{\\c&HFFFFFF&}"); // the edit plan's emphasis word
  });

  it("uses the transcript from the payload, or the one already on the row, without calling speech-to-text", async () => {
    const stt: SttProvider = { transcribe: vi.fn(async () => { throw new Error("must not be called"); }) };
    const short = { language: "en", duration_s: 1, words: [{ text: "stop", start_s: 0, end_s: 0.5 }] };
    const m1 = memory();
    await runEditJob({ ...job, displayText: "Stop", transcript: short }, { ...m1, stt, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(seenAss).toContain("STOP");
    const m2 = memory({ transcript: short });
    // One word: no room for b-roll, so none is asked for (p4-b3: asked-for b-roll that can't be placed → team).
    const faceOnly = { ...job.editPlan, broll_moments: [] };
    const out = await runEditJob({ ...job, displayText: "Stop", editPlan: faceOnly }, { ...m2, stt, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out.status).toBe("edited");
    expect(stt.transcribe).not.toHaveBeenCalled();
  });

  // p4-b1 (QA SF3), a PERMANENT guard: a video that asked for the AI label never reaches
  // final_qa without it. p4-b2 draws it, and the guard checks the REAL ffmpeg argv
  // (lib/edit.ts notYetApplied), so final_qa is allowed only because the label is in it.
  it("AI label on → drawn in the real argv → final_qa (and the guard would have caught it missing)", async () => {
    const m = memory();
    const out = await runEditJob({ ...job, aiLabel: true }, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out).toEqual({ status: "edited", finalPath: FINAL, notApplied: [] });
    expect(m.row).toMatchObject({ status: "final_qa", error: null });
    expect(seenArgs.join(" ")).toContain(":text=AI-generated:");
    expect(m.postStatuses.at(-1)).toEqual({ status: "final_qa", reason: null });
    // The guard input: the same extras with the label taken OUT of the argv → named, so team_review.
    const withoutLabel = seenArgs.map((a) => a.replace(/,drawtext=[^,;]*text=AI-generated[^,;]*/, ""));
    expect(notYetApplied({ ai_label: true }, withoutLabel)).toEqual(["ai_label"]);
    expect(missingExtrasMessage(["ai_label"])).toBe("AI label not added yet.");
    expect(EXTRAS_TEAM_REASON).toMatch(/AI label/);
  });

  it("trial watermark: drawn when the payload or the video row says trial (videos.watermark); never otherwise", async () => {
    const fromPayload = memory();
    await runEditJob({ ...job, watermark: true }, { ...fromPayload, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(seenArgs.join(" ")).toContain(":text=TRIAL PREVIEW:");
    expect(fromPayload.row.status).toBe("final_qa");
    const fromRow = memory({ watermark: true });
    await runEditJob({ ...job, watermark: false }, { ...fromRow, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(seenArgs.join(" ")).toContain(":text=TRIAL PREVIEW:");
    const paid = memory();
    await runEditJob(job, { ...paid, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(seenArgs.join(" ")).not.toContain("TRIAL PREVIEW");
  });

  it("AI label off on BOTH the payload and the row → no label (the customer turned it off)", async () => {
    const m = memory({ ai_label: false });
    const out = await runEditJob({ ...job, aiLabel: false }, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out.status).toBe("edited");
    expect(seenArgs.join(" ")).not.toContain("AI-generated");
    // The row default (ai_label true) wins over a payload that forgot it.
    const n = memory();
    await runEditJob({ ...job, aiLabel: false }, { ...n, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(seenArgs.join(" ")).toContain(":text=AI-generated:");
  });

  it("p4-b2: two ffmpeg runs: loudness pass 1 (measure, -f null), then the final edit with pass 2 numbers", async () => {
    const m = memory();
    await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(calls).toHaveLength(2);
    expect(calls[0].join(" ")).toContain("loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[aout]");
    expect(calls[1].join(" ")).toContain(
      "measured_I=-19.43:measured_TP=-6.02:measured_LRA=3.1:measured_thresh=-29.61:offset=0.05:linear=true",
    );
    expect(calls[1].slice(-3)).toEqual(["-movflags", "+faststart", calls[1].at(-1)]);
  });

  it("p4-b2: B-roll from the mock provider at the planned moment, after the hook and before the CTA", async () => {
    const m = memory();
    await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    const inputs = seenArgs.flatMap((a, i) => (a === "-i" ? [seenArgs[i + 1]] : []));
    // raw, one b-roll clip for "grow your café" (keyword "coffee shop"), the music bed.
    expect(inputs).toHaveLength(3);
    expect(inputs[1]).toBe(path.join(process.cwd(), "tests", "fixtures", "broll", "cafe-green.mp4"));
    const graph = seenArgs[seenArgs.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[base][b1]overlay=enable='between(t,2.72,4.22)':eof_action=pass[v1]");
    expect(graph).toContain("[v1]subtitles="); // captions on top of the b-roll
  });

  it("p5-b2 (Gate 5 re-edit): avoidBrollClips swaps the clip Gate 5 rejected; the manifest records the avoid list and the caption style", async () => {
    const m = memory();
    await runEditJob({ ...job, avoidBrollClips: ["cafe-green"], captionStyle: "small_box" }, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    const inputs = seenArgs.flatMap((a, i) => (a === "-i" ? [seenArgs[i + 1]] : []));
    expect(inputs.some((f) => f.endsWith("cafe-green.mp4"))).toBe(false);
    const manifest = editManifestSchema.parse((m.row as Record<string, unknown>).edit_manifest);
    expect(manifest).toMatchObject({ caption_style: "small_box", avoid_clips: ["cafe-green"] });
    expect(manifest.broll.every((c) => c.clip !== "cafe-green")).toBe(true);
  });

  it("p5-b2: a cut whose only clips are all avoided is dropped (never the rejected clip again)", async () => {
    const m = memory();
    const broll = { search: vi.fn(async (keyword: string) => [{ id: "only", keyword, file: "/tmp/only.mp4", width: 540, height: 960, duration_s: 4, source: "mock" as const }]) };
    await runEditJob({ ...job, avoidBrollClips: ["only"] }, { ...m, broll, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(seenArgs).not.toContain("/tmp/only.mp4");
  });

  it("p4-b2: the music bed (mock set) is looped under the voice and ducked by it", async () => {
    const m = memory();
    await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    const at = seenArgs.indexOf("-stream_loop");
    expect(seenArgs.slice(at, at + 3)).toEqual(["-stream_loop", "-1", "-i"]);
    expect(seenArgs[at + 3]).toMatch(/tests\/fixtures\/music\/bed-(calm|bright|soft)\.m4a$/);
    expect(seenArgs.join(" ")).toContain("[bed][sc]sidechaincompress=");
    expect(seenArgs.join(" ")).toContain("afade=t=out:st=4.5:d=1.5"); // the 6 s video's end
  });

  it("p4-b2: MOCK_PEXELS=false → the plain 'B-roll search is not set up yet' error is saved (no network)", async () => {
    vi.stubEnv("MOCK_PEXELS", "false");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const m = memory();
    const out = await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out).toEqual({ status: "failed", error: BROLL_NOT_SET_UP });
    expect(m.row).toMatchObject({ status: "team_review", error: BROLL_NOT_SET_UP });
    expect(calls).toEqual([]);
  });

  it("p4-b2: no music beds → plain error; a silent voice (loudness -inf) → plain error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const noMusic = memory();
    const empty = await mkdtemp(path.join(os.tmpdir(), "no-music-"));
    const out1 = await runEditJob(job, { ...noMusic, music: fixtureMusicLibrary(empty), ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out1).toEqual({ status: "failed", error: MUSIC_NOT_SET_UP });
    const silent = memory();
    const silentFfmpeg: FfmpegRunner = async (args) =>
      isMeasurePass(args) ? { stderr: PASS1.replace('"-19.43"', '"-inf"') } : okFfmpeg(args);
    const out2 = await runEditJob(job, { ...silent, ffmpeg: silentFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out2).toEqual({ status: "failed", error: LOUDNORM_SILENT });
    expect(silent.row.error).toBe(LOUDNORM_SILENT);
  });

  it("p4-b3 (QA SF2): the hook/CTA not found in the words → no b-roll (face stays), file kept, video + post → team_review with a plain reason", async () => {
    const m = memory();
    const out = await runEditJob({ ...job, hook: "Something else entirely." }, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(seenArgs.join(" ")).not.toContain("overlay=");
    expect(out).toEqual({ status: "needs_team", finalPath: FINAL, notApplied: [], reason: BROLL_TEAM_REASONS.hook_cta_not_found });
    expect(BROLL_TEAM_REASONS.hook_cta_not_found).toBe("B-roll couldn't be placed: hook/CTA not found in the transcript.");
    expect(m.row).toMatchObject({ status: "team_review", final_path: FINAL, error: BROLL_TEAM_REASONS.hook_cta_not_found });
    expect(m.stored.has(FINAL)).toBe(true); // the team can watch it
    expect(m.postStatuses.at(-1)).toEqual({ status: "team_review", reason: BROLL_TEAM_REASONS.hook_cta_not_found });
  });

  it("p4-b3 (QA SF2): cuts planned but the provider found no clips → team_review 'No B-roll clips found.'", async () => {
    const m = memory();
    const broll = { search: vi.fn(async () => []) };
    const out = await runEditJob(job, { ...m, broll, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(broll.search).toHaveBeenCalled();
    expect(out).toMatchObject({ status: "needs_team", reason: "No B-roll clips found." });
    expect(m.row).toMatchObject({ status: "team_review", error: "No B-roll clips found." });
    expect(m.postStatuses.at(-1)).toEqual({ status: "team_review", reason: "No B-roll clips found." });
  });

  it("p4-b3 (QA SF2): moments asked for but none fit between the hook and the CTA → team_review", async () => {
    const m = memory();
    const editPlan = { ...job.editPlan, broll_moments: [{ at_words: "words nobody said", keyword: "coffee" }] };
    const out = await runEditJob({ ...job, editPlan }, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out).toMatchObject({ status: "needs_team", reason: BROLL_TEAM_REASONS.none_fit });
    expect(m.row.status).toBe("team_review");
  });

  it("p4-b3: no b-roll moments and no keywords asked for at all → a face-only edit still goes to final_qa", async () => {
    const m = memory();
    const editPlan = { ...job.editPlan, broll_moments: [] };
    const out = await runEditJob({ ...job, editPlan, brollKeywords: [] }, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out).toEqual({ status: "edited", finalPath: FINAL, notApplied: [] });
    expect(seenArgs.join(" ")).not.toContain("overlay=");
  });

  it("ffmpeg failure: plain error on the row, no final file anywhere, post to the team", async () => {
    const m = memory();
    const failing: FfmpegRunner = async (args) => {
      if (isMeasurePass(args)) return { stderr: PASS1 };
      await writeFile(args.at(-1)!, "half a video"); // a partial output, as a killed ffmpeg leaves
      throw new Error("ffmpeg failed: [Parsed_subtitles_0] /tmp/secret/path Invalid data");
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await runEditJob(job, { ...m, ffmpeg: failing, tmpRoot, fontsDir: captionFontsDir() });
    expect(outcome).toEqual({ status: "failed", error: EDIT_ERRORS.ffmpeg });
    expect(m.row).toMatchObject({ status: "team_review", final_path: null, error: EDIT_ERRORS.ffmpeg });
    expect(m.stored.has(FINAL)).toBe(false);
    expect(await readdir(tmpRoot)).toEqual([]); // the half-written file is gone too
    expect(m.postStatuses.at(-1)).toEqual({ status: "team_review", reason: TEAM_EDIT_REASON });
    expect(logged).toHaveBeenCalled();
  });

  it("upload failure: removes any partly stored final and saves a plain error", async () => {
    const m = memory();
    m.files.upload = async (p) => {
      m.stored.set(p, { bytes: new Uint8Array([9]), type: "video/mp4" }); // pretend half of it landed
      throw new Error("storage 500");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(outcome).toEqual({ status: "failed", error: EDIT_ERRORS.upload });
    expect(m.removed).toEqual([FINAL]);
    expect(m.stored.has(FINAL)).toBe(false);
    expect(m.row).toMatchObject({ status: "team_review", final_path: null, error: EDIT_ERRORS.upload });
  });

  it("raw video missing from storage: plain download error", async () => {
    const m = memory();
    m.stored.delete(RAW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(outcome).toEqual({ status: "failed", error: EDIT_ERRORS.download });
  });

  it("missing caption fonts: plain error before ffmpeg runs", async () => {
    const m = memory();
    const ffmpeg = vi.fn(okFfmpeg);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const emptyFonts = await mkdtemp(path.join(os.tmpdir(), "no-fonts-"));
    const outcome = await runEditJob(job, { ...m, ffmpeg, tmpRoot, fontsDir: emptyFonts });
    expect(outcome).toEqual({ status: "failed", error: EDIT_ERRORS.fonts });
    expect(ffmpeg).not.toHaveBeenCalled();
  });

  it("speech-to-text switched off with no provider: its plain error is saved", async () => {
    vi.stubEnv("MOCK_STT", "false");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const m = memory();
    const outcome = await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(outcome).toEqual({ status: "failed", error: NO_STT_PROVIDER });
    expect(m.row.error).toBe(NO_STT_PROVIDER);
  });

  it("refuses (and changes nothing) for a wrong raw path, a likeness test, or a video not ready to edit", async () => {
    for (const [overrides, jobPatch] of [
      [{}, { rawPath: `raw/${BRAND}/${"9".repeat(8)}-0000-4000-8000-000000000002.mp4` }],
      [{ kind: "likeness_test" as const }, {}],
      [{ status: "queued" }, {}],
      [{ raw_path: null }, {}],
    ] as const) {
      const m = memory(overrides);
      const before = { ...m.row };
      const ffmpeg = vi.fn(okFfmpeg);
      await expect(runEditJob({ ...job, ...jobPatch }, { ...m, ffmpeg, tmpRoot, fontsDir: captionFontsDir() })).rejects.toThrow(
        /can't be edited/,
      );
      expect(m.row).toEqual(before);
      expect(ffmpeg).not.toHaveBeenCalled();
    }
  });

  it("p4-b1 SF2: a second run is refused while the first is editing; the first still finishes", async () => {
    const m = memory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let ffmpegStarted!: () => void;
    const started = new Promise<void>((resolve) => (ffmpegStarted = resolve));
    const slowFfmpeg: FfmpegRunner = async (args) => {
      ffmpegStarted();
      await gate;
      return okFfmpeg(args);
    };
    const runA = runEditJob(job, { ...m, ffmpeg: slowFfmpeg, tmpRoot, fontsDir: captionFontsDir(), runToken: "run_a" });
    await started;
    const ffmpegB = vi.fn(okFfmpeg);
    await expect(
      runEditJob(job, { ...m, ffmpeg: ffmpegB, tmpRoot, fontsDir: captionFontsDir(), runToken: "run_b" }),
    ).rejects.toThrow(/can't be edited/);
    expect(ffmpegB).not.toHaveBeenCalled();
    release();
    expect((await runA).status).toBe("edited");
    expect(m.row).toMatchObject({ status: "final_qa", final_path: finalOf("run_a"), edit_run_id: "run_a" });
  });

  it("p4-b1 SF2: run B took over a stale claim and finished; run A then fails after its upload → B's final file stays", async () => {
    const m = memory();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Run A: gets stuck in its upload (a hung storage call), then fails.
    let failUpload!: () => void;
    const uploadFails = new Promise<void>((resolve) => (failUpload = resolve));
    let uploadStarted!: () => void;
    const inUpload = new Promise<void>((resolve) => (uploadStarted = resolve));
    const filesA: EditFiles = {
      ...m.files,
      async upload() {
        uploadStarted();
        await uploadFails;
        throw new Error("storage timeout");
      },
    };
    const runA = runEditJob(job, { ...m, files: filesA, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir(), runToken: "run_a" });
    await inUpload;
    // A's claim goes stale (older than the task's maxDuration), so run B may take over and finishes first.
    m.row.edit_started_at = Date.now() - (EDIT.claim_stale_s + 60) * 1000;
    const finishedB = await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir(), runToken: "run_b" });
    expect(finishedB.status).toBe("edited");
    // Now A fails after its upload started.
    failUpload();
    const outcomeA = await runA;
    expect(outcomeA.status).toBe("superseded");
    // A never deletes a file it does not own (p4-b3: it removes only its own run-scoped object).
    expect(m.removed).toEqual([finalOf("run_a")]);
    expect(Buffer.from(m.stored.get(finalOf("run_b"))!.bytes).toString()).toBe("finished mp4 bytes");
    expect(m.row).toMatchObject({ status: "final_qa", final_path: finalOf("run_b"), error: null, edit_run_id: "run_b" });
    expect(m.postStatuses.at(-1)).toEqual({ status: "final_qa", reason: null }); // A did not touch the post either
  });

  it("p4-b3 (QA SF1): run A goes stale, run B finishes, THEN A's slow upload succeeds → the row still points at B's bytes", async () => {
    const m = memory();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Run A's ffmpeg writes different bytes, and its upload hangs until we let it land.
    const ffmpegA: FfmpegRunner = async (args) => {
      if (isMeasurePass(args)) return { stderr: PASS1 };
      await writeFile(args.at(-1)!, "run A bytes");
      return { stderr: "" };
    };
    let landA!: () => void;
    const aMayLand = new Promise<void>((resolve) => (landA = resolve));
    let aUploading!: () => void;
    const inUploadA = new Promise<void>((resolve) => (aUploading = resolve));
    let pathA = "";
    const filesA: EditFiles = {
      ...m.files,
      async upload(p, bytes, type) {
        pathA = p;
        aUploading();
        await aMayLand;
        await m.files.upload(p, bytes, type); // the slow upload SUCCEEDS
      },
    };
    const runA = runEditJob(job, { ...m, files: filesA, ffmpeg: ffmpegA, tmpRoot, fontsDir: captionFontsDir(), runToken: "run_a" });
    await inUploadA;
    m.row.edit_started_at = Date.now() - (EDIT.claim_stale_s + 60) * 1000; // A's claim is stale
    const outB = await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir(), runToken: "run_b" });
    expect(outB.status).toBe("edited");
    const pathB = m.row.final_path!;
    landA();
    expect(await runA).toEqual({ status: "superseded" });
    // The row points at B's file, and that file still holds B's bytes.
    expect(m.row).toMatchObject({ status: "final_qa", edit_run_id: "run_b", final_path: pathB, error: null });
    expect(Buffer.from(m.stored.get(pathB)!.bytes).toString()).toBe("finished mp4 bytes");
    // A never wrote to B's path, and cleaned up only its own object.
    expect(pathA).not.toBe(pathB);
    expect(m.removed).toEqual([pathA]);
    expect(m.stored.has(pathA)).toBe(false);
  });

  it("p5-a (QA SF1): the post update throws AFTER finishEdit promoted the run → the file stays and final_path still points at it", async () => {
    const m = memory();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const setPost = m.store.setPostStatusForVideo.bind(m.store);
    m.store.setPostStatusForVideo = async (id, status, reason) => {
      if (status !== "editing") throw new Error("posts update failed: network");
      return setPost(id, status, reason);
    };
    const out = await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out).toEqual({ status: "edited", finalPath: FINAL, notApplied: [] });
    expect(m.removed).toEqual([]);
    expect(m.stored.has(FINAL)).toBe(true);
    expect(m.row).toMatchObject({ status: "final_qa", final_path: FINAL, error: null });
    expect(logged).toHaveBeenCalled();
  });

  it("p5-a (QA SF1): same for the team_review promotion (b-roll problem) → the file the row points at is never removed", async () => {
    const m = memory();
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.store.setPostStatusForVideo = async (_id, status) => {
      if (status !== "editing") throw new Error("posts update failed");
    };
    const out = await runEditJob({ ...job, hook: "Something else entirely." }, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out).toMatchObject({ status: "needs_team", finalPath: FINAL });
    expect(m.removed).toEqual([]);
    expect(m.stored.has(FINAL)).toBe(true);
    expect(m.row).toMatchObject({ status: "team_review", final_path: FINAL });
  });

  it("p5-a: a run that lost the claim during speech-to-text does not save the transcript (and stops)", async () => {
    const m = memory();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ffmpeg = vi.fn(okFfmpeg);
    const stt: SttProvider = {
      async transcribe() {
        // While A transcribes, its claim goes stale and run B takes the video over.
        m.row.edit_run_id = "run_b";
        return fixture as never;
      },
    };
    const out = await runEditJob(job, { ...m, stt, ffmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out).toEqual({ status: "superseded" });
    expect(m.row.transcript).toBeNull();
    expect(ffmpeg).not.toHaveBeenCalled();
    expect(m.removed).toEqual([]);
  });

  it("an unknown video id is refused", async () => {
    const m = memory();
    await expect(
      runEditJob({ ...job, videoId: "90000000-0000-4000-8000-00000000ffff" }, { ...m, ffmpeg: okFfmpeg, tmpRoot }),
    ).rejects.toThrow(/can't be edited/);
  });
});
