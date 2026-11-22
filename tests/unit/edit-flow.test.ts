import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import script from "@/tests/fixtures/stt/sample-script.json";
import fixture from "@/tests/fixtures/stt/sample-transcript.json";
import {
  EDIT_ERRORS,
  TEAM_EDIT_REASON,
  captionFontsDir,
  editJobSchema,
  finalPathFor,
  runEditJob,
  type EditFiles,
  type EditStore,
  type EditVideoRow,
  type FfmpegRunner,
} from "@/lib/edit-flow";
import { NO_STT_PROVIDER, type SttProvider } from "@/lib/stt";

// lib/edit-flow.ts with fakes: no Supabase, no real ffmpeg (that is in
// tests/integration/edit-ffmpeg.test.ts), mock speech-to-text.

const BRAND = "10000000-0000-4000-8000-000000000001";
const VIDEO = "90000000-0000-4000-8000-000000000001";
const RAW = `raw/${BRAND}/${VIDEO}.mp4`;
const FINAL = `final/${BRAND}/${VIDEO}.mp4`;
const RAW_BYTES = new Uint8Array([1, 2, 3, 4]);
const FINAL_BYTES = Buffer.from("finished mp4 bytes");

function memory(overrides: Partial<EditVideoRow> = {}) {
  const row: EditVideoRow = {
    id: VIDEO, brand_id: BRAND, kind: "post", status: "rendered", raw_path: RAW, final_path: null, transcript: null, error: null,
    ...overrides,
  };
  const postStatuses: { status: string; reason: string | null }[] = [];
  const store: EditStore = {
    async getVideo(id) {
      return id === row.id ? { ...row } : null;
    },
    async startEdit(id) {
      if (id !== row.id || row.kind !== "post" || !["rendered", "audio_qa", "editing"].includes(row.status)) return false;
      row.status = "editing";
      return true;
    },
    async saveTranscript(_id, transcript) {
      row.transcript = transcript;
    },
    async finishEdit(_id, patch) {
      Object.assign(row, patch);
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
  return { row, store, files, stored, removed, postStatuses };
}

let tmpRoot: string;
let seenAss: string;
let seenArgs: string[];
const okFfmpeg: FfmpegRunner = async (args) => {
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
  brandColour: "#FF5A1F",
  captionStyle: "big_words" as const,
  aiLabel: false,
  watermark: false,
};

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "edit-flow-test-"));
  seenAss = "";
  seenArgs = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("editJobSchema (the task payload)", () => {
  it("accepts a raw path in the videos bucket only, and fills defaults", () => {
    const parsed = editJobSchema.parse({ videoId: VIDEO, rawPath: RAW, displayText: "Hi", editPlan: script.edit_plan });
    expect(parsed).toMatchObject({ captionStyle: "big_words", aiLabel: true, watermark: false });
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
    expect(finalPathFor(BRAND, VIDEO)).toBe(FINAL);
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

  it("uses the mock speech-to-text when no transcript is given, and saves it on the row", async () => {
    const m = memory();
    await runEditJob(job, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(m.row.transcript).toEqual(fixture);
    expect(seenAss).toContain("{\\c&H1F5AFF&}STOP{\\c&HFFFFFF&} SCROLLING!");
  });

  it("uses the transcript from the payload, or the one already on the row, without calling speech-to-text", async () => {
    const stt: SttProvider = { transcribe: vi.fn(async () => { throw new Error("must not be called"); }) };
    const short = { language: "en", duration_s: 1, words: [{ text: "stop", start_s: 0, end_s: 0.5 }] };
    const m1 = memory();
    await runEditJob({ ...job, displayText: "Stop", transcript: short }, { ...m1, stt, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(seenAss).toContain("STOP");
    const m2 = memory({ transcript: short });
    const out = await runEditJob({ ...job, displayText: "Stop" }, { ...m2, stt, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out.status).toBe("edited");
    expect(stt.transcribe).not.toHaveBeenCalled();
  });

  it("lists the part B extras it could not apply yet (AI label)", async () => {
    const m = memory();
    const out = await runEditJob({ ...job, aiLabel: true }, { ...m, ffmpeg: okFfmpeg, tmpRoot, fontsDir: captionFontsDir() });
    expect(out).toEqual({ status: "edited", finalPath: FINAL, notApplied: ["ai_label"] });
  });

  it("ffmpeg failure: plain error on the row, no final file anywhere, post to the team", async () => {
    const m = memory();
    const failing: FfmpegRunner = async (args) => {
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

  it("an unknown video id is refused", async () => {
    const m = memory();
    await expect(
      runEditJob({ ...job, videoId: "90000000-0000-4000-8000-00000000ffff" }, { ...m, ffmpeg: okFfmpeg, tmpRoot }),
    ).rejects.toThrow(/can't be edited/);
  });
});
