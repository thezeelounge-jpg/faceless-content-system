import { execFile } from "node:child_process";
import path from "node:path";
import { readEnv } from "@/lib/config";
import { CLIP_CHECKS } from "@/lib/qa/config";

// Measures a consent clip with ffprobe and ffmpeg.
// Safety: we never build a shell string. Each value is its own argument and
// the programs are started with execFile (no shell), so a strange file name
// cannot run commands. Paths must be absolute, so none can look like an option.

// The Trigger.dev ffmpeg build extension sets FFMPEG_PATH / FFPROBE_PATH.
// Also used by the editor (lib/edit-flow.ts).
export const ffmpegBin = () => readEnv("FFMPEG_PATH") ?? "ffmpeg";
export const ffprobeBin = () => readEnv("FFPROBE_PATH") ?? "ffprobe";

const TOOL_TIMEOUT_MS = 5 * 60_000;

function checkPath(file: string): string {
  if (!path.isAbsolute(file)) throw new Error("Clip path must be an absolute file path.");
  return file;
}

// ---------------------------------------------------------------------------
// Command builder (pure)
// ---------------------------------------------------------------------------

export function probeArgs(file: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", checkPath(file)];
}

const passArgs = (file: string) => ["-nostdin", "-hide_banner", "-nostats", "-i", checkPath(file)];

/**
 * Decision 5: a .mov (iPhone QuickTime, often HEVC) re-encoded to an mp4 that
 * HeyGen accepts: H.264 (yuv420p, so 10-bit HDR phones still play), AAC,
 * moov atom first (+faststart). -y only overwrites our own temp output.
 */
export function convertToMp4Args(input: string, output: string): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", checkPath(input),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
    checkPath(output),
  ];
}

/** Integrated loudness (EBU R128), printed as a summary on stderr. */
export function loudnessArgs(file: string): string[] {
  return [...passArgs(file), "-vn", "-af", "ebur128=peak=none", "-f", "null", "-"];
}

/** Silences quieter than noiseDb lasting at least minS seconds, on stderr. */
export function silenceArgs(file: string, noiseDb: number, minS: number): string[] {
  return [...passArgs(file), "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minS}`, "-f", "null", "-"];
}

/** Average brightness (YAVG, 0 to 255) of 2 frames per second, on stdout. */
export function brightnessArgs(file: string): string[] {
  return [
    ...passArgs(file),
    "-an",
    "-vf",
    "fps=2,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG",
    "-f",
    "null",
    "-",
  ];
}

/** One frame at `atS` seconds as a JPEG (768 px high) on stdout. */
export function frameArgs(file: string, atS: number): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-ss", atS.toFixed(3), "-i", checkPath(file),
    "-frames:v", "1", "-vf", "scale=-2:768", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
  ];
}

/** `count` times spread evenly, each in the middle of its slice of the clip. */
export function frameTimes(durationS: number, count: number): number[] {
  const slice = Math.max(durationS, 0) / count;
  return Array.from({ length: count }, (_, i) => Math.round((i + 0.5) * slice * 1000) / 1000);
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

export type ProbeResult = { durationS: number; width: number; height: number; fps: number; hasAudio: boolean };

type ProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
};

function rate(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split("/").map(Number);
  const fps = den ? num / den : num;
  return Number.isFinite(fps) ? Math.round(fps * 100) / 100 : 0;
}

export function parseProbe(json: string): ProbeResult {
  const data = JSON.parse(json) as { streams?: ProbeStream[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const rotation = Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  const sideways = Math.abs(rotation) % 180 === 90;
  const width = video?.width ?? 0;
  const height = video?.height ?? 0;
  return {
    durationS: Number(data.format?.duration ?? 0) || 0,
    width: sideways ? height : width,
    height: sideways ? width : height,
    fps: rate(video?.avg_frame_rate) || rate(video?.r_frame_rate),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

/** The last "I: <n> LUFS" line (the summary). -Infinity for a silent clip. */
export function parseLoudness(stderr: string): number | null {
  const matches = [...stderr.matchAll(/I:\s+(-?inf|-?\d+(?:\.\d+)?)\s+LUFS/g)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return null;
  return last.endsWith("inf") ? -Infinity : Number(last);
}

/** The longest silence in seconds; a silence still running at the end counts up to the end. */
export function parseSilences(stderr: string, durationS: number): number {
  let longest = 0;
  let openStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (start) openStart = Number(start[1]);
    const end = line.match(/silence_duration:\s*(\d+(?:\.\d+)?)/);
    if (end) {
      longest = Math.max(longest, Number(end[1]));
      openStart = null;
    }
  }
  if (openStart !== null) longest = Math.max(longest, durationS - Math.max(openStart, 0));
  return Math.round(longest * 100) / 100;
}

/** Average of every YAVG value printed by signalstats. */
export function parseBrightness(output: string): number | null {
  const values = [...output.matchAll(/lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Running the tools
// ---------------------------------------------------------------------------

function run(bin: string, args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { encoding: "buffer", timeout: TOOL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${path.basename(bin)} failed: ${stderr.toString("utf8").slice(-500)}`, { cause: error }));
        else resolve({ stdout, stderr: stderr.toString("utf8") });
      },
    );
  });
}

export type ClipMeasurements = ProbeResult & {
  loudnessLufs: number | null;
  longestSilenceS: number;
  brightness: number | null;
};

export async function measureClip(file: string): Promise<ClipMeasurements> {
  const probe = parseProbe((await run(ffprobeBin(), probeArgs(file))).stdout.toString("utf8"));
  const [loudness, silence, brightness] = await Promise.all([
    probe.hasAudio ? run(ffmpegBin(), loudnessArgs(file)) : null,
    probe.hasAudio
      ? run(ffmpegBin(), silenceArgs(file, CLIP_CHECKS.silence_noise_db, CLIP_CHECKS.silence_min_s))
      : null,
    run(ffmpegBin(), brightnessArgs(file)),
  ]);
  return {
    ...probe,
    loudnessLufs: loudness ? parseLoudness(loudness.stderr) : null,
    // No sound track at all counts as silence for the whole clip.
    longestSilenceS: silence ? parseSilences(silence.stderr, probe.durationS) : probe.durationS,
    brightness: parseBrightness(brightness.stdout.toString("utf8") + brightness.stderr),
  };
}

/** Converts a clip to mp4 (decision 5). Throws "ffmpeg failed: …" when the file can't be read. */
export async function convertToMp4(input: string, output: string): Promise<void> {
  await run(ffmpegBin(), convertToMp4Args(input, output));
}

/** `count` JPEG frames spread over the clip. */
export async function sampleFrames(file: string, durationS: number, count: number): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for (const at of frameTimes(durationS, count)) {
    frames.push((await run(ffmpegBin(), frameArgs(file, at))).stdout);
  }
  return frames;
}
