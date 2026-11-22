import { readFile, writeFile } from "node:fs/promises";
import { captionFontsDir, runEditJob, runFfmpeg, type EditFiles, type EditJob, type EditStore, type EditVideoRow, type FfmpegRunner } from "@/lib/edit-flow";
import type { BrollProvider } from "@/lib/broll";
import type { Transcript } from "@/lib/stt";

// The whole edit job (lib/edit-flow.ts runEditJob) with the REAL local
// ffmpeg/ffprobe, the mock b-roll provider (MOCK_PEXELS) and the fixture music
// set. "Storage" is a local raw file and a captured upload; the store keeps
// one row in memory. Used by tests/integration/edit-extras-ffmpeg.test.ts and
// scripts/p4-artifacts.ts. Local programs only: no network, nothing paid.

export const REAL_BRAND = "10000000-0000-4000-8000-000000000001";
export const REAL_VIDEO = "90000000-0000-4000-8000-0000000000b2";
export const REAL_RAW = `raw/${REAL_BRAND}/${REAL_VIDEO}.mp4`;
/** p4-b3: a fixed run id, so the run-scoped final path is known. */
export const REAL_RUN = "run_real";

/** Words of `text`, one every `step` seconds from 0.2 s, each 0.36 s long: STT-style (lowercase, no punctuation). */
export function transcriptFor(text: string, durationS: number, step = 0.42): Transcript {
  const words = text.split(" ").map((w, i) => ({
    text: w.toLowerCase().replace(/[^a-z]/g, ""),
    start_s: Math.round((0.2 + i * step) * 1000) / 1000,
    end_s: Math.round((0.2 + i * step + 0.36) * 1000) / 1000,
  }));
  return { language: "en", duration_s: durationS, words };
}

export type RealEditInput = {
  rawFile: string;
  /** Where the uploaded final MP4 is written. */
  outFile: string;
  /** Temp root for the job's own work folder. */
  tmpRoot: string;
  job: Omit<EditJob, "videoId" | "rawPath">;
  row?: Partial<EditVideoRow>;
  /** p5-a2: another b-roll provider (default: the MOCK_PEXELS fixtures). */
  broll?: BrollProvider;
};

export async function editForReal(input: RealEditInput) {
  const row: EditVideoRow = {
    id: REAL_VIDEO, brand_id: REAL_BRAND, kind: "post", status: "rendered", raw_path: REAL_RAW, final_path: null,
    transcript: null, error: null, ai_label: true, watermark: false,
    ...input.row,
  };
  const store: EditStore = {
    getVideo: async () => ({ ...row }),
    startEdit: async () => ((row.status = "editing"), true),
    saveTranscript: async () => true,
    finishEdit: async (_id, _run, patch) => (Object.assign(row, patch), true),
    setPostStatusForVideo: async () => {},
  };
  const files: EditFiles = {
    download: async () => new Uint8Array(await readFile(input.rawFile)),
    upload: async (_p, bytes) => writeFile(input.outFile, bytes),
    remove: async () => {},
  };
  const calls: { args: string[]; stderr: string }[] = [];
  const ffmpeg: FfmpegRunner = async (args, options) => {
    const result = await runFfmpeg(args, options);
    calls.push({ args, stderr: result.stderr });
    return result;
  };
  const outcome = await runEditJob(
    { videoId: REAL_VIDEO, rawPath: REAL_RAW, ...input.job },
    { store, files, ffmpeg, tmpRoot: input.tmpRoot, fontsDir: captionFontsDir(), runToken: REAL_RUN, broll: input.broll },
  );
  return { outcome, row, output: input.outFile, calls };
}
