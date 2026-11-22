import { execFileSync, spawnSync } from "node:child_process";

// Local ffmpeg/ffprobe helpers for the editor's integration test and for
// scripts/p4-artifacts.ts. Local programs only: no network, no paid service.

export const hasFfmpeg = (): boolean =>
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

/**
 * A LANDSCAPE test clip (1280x720, 25 fps, testsrc2 pattern + a 44.1 kHz sine
 * tone), so the editor really has to scale, crop, change fps and resample.
 */
export function makeLandscapeInput(file: string, seconds = 6): void {
  execFileSync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=25:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      file,
    ],
    { stdio: "pipe" },
  );
}

export type ProbeSummary = {
  width: number;
  height: number;
  r_frame_rate: string;
  avg_frame_rate: string;
  video_codec: string;
  pix_fmt: string;
  sar: string | null;
  audio_codec: string | null;
  sample_rate: string | null;
  channels: number | null;
  duration_s: number;
};

export function probe(file: string): ProbeSummary {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { encoding: "utf8" },
  );
  type Stream = Record<string, string | number | undefined>;
  const data = JSON.parse(out) as { streams: Stream[]; format: { duration: string } };
  const v = data.streams.find((s) => s.codec_type === "video")!;
  const a = data.streams.find((s) => s.codec_type === "audio");
  return {
    width: Number(v.width),
    height: Number(v.height),
    r_frame_rate: String(v.r_frame_rate),
    avg_frame_rate: String(v.avg_frame_rate),
    video_codec: String(v.codec_name),
    pix_fmt: String(v.pix_fmt),
    sar: v.sample_aspect_ratio === undefined ? null : String(v.sample_aspect_ratio),
    audio_codec: a ? String(a.codec_name) : null,
    sample_rate: a ? String(a.sample_rate) : null,
    channels: a ? Number(a.channels) : null,
    duration_s: Number(data.format.duration),
  };
}

/** The flat "face" colour of the talking-head test input (same as tests/fixtures/consent-good.mp4). */
export const FACE_RGB: [number, number, number] = [0xd8, 0xb4, 0x9a];

/**
 * A small TALKING-HEAD stand-in (p4-b2): 540x960 at 25 fps (so the editor must
 * scale, crop and change fps) in the flat face colour, with a 44.1 kHz voice.
 * "speech": a 180 Hz tone with a syllable wobble and a 0.4 s pause every 2 s
 * (so ducking has gaps to release in). "peaky": a quiet tone with short
 * near-full-scale clicks every second: low loudness, high peaks, so loudnorm
 * must raise it a lot while keeping the true peak down.
 */
export function makeTalkingInput(file: string, seconds: number, voice: "speech" | "peaky" = "speech"): void {
  const audio =
    voice === "speech"
      ? "0.4*sin(2*PI*180*t)*(0.6+0.4*sin(2*PI*5*t))*lt(mod(t\\,2)\\,1.6)"
      : "0.03*sin(2*PI*180*t)+0.97*lt(mod(t\\,1)\\,0.004)*sin(2*PI*1000*t)";
  execFileSync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=0xD8B49A:s=540x960:r=25:d=${seconds}`,
      "-f", "lavfi", "-i", `aevalsrc=${audio}:s=44100:d=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest",
      file,
    ],
    { stdio: "pipe" },
  );
}

/**
 * p5-a2: a MOVING talking-head stand-in for Gate 4 (freezedetect needs motion: the flat-colour
 * inputs above are frozen by design). testsrc2 (a moving pattern) at 540x960, 25 fps, with the
 * same "speech" voice as makeTalkingInput.
 */
export function makeMovingTalkingInput(file: string, seconds: number): void {
  execFileSync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=540x960:rate=25:duration=${seconds}`,
      "-f", "lavfi", "-i", `aevalsrc=0.4*sin(2*PI*180*t)*(0.6+0.4*sin(2*PI*5*t))*lt(mod(t\\,2)\\,1.6):s=44100:d=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest",
      file,
    ],
    { stdio: "pipe" },
  );
}

/**
 * p5-a2: a deliberately BAD "final" reel for Gate 4: 1080x1920 at 25 fps, 1 s of black, then
 * 2.2 s of one still colour (frozen), then 1 s of moving pattern; a quiet tone (about -30 LUFS);
 * no +faststart (moov after mdat).
 */
export function makeBadFinal(file: string): void {
  execFileSync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=25:d=1",
      "-f", "lavfi", "-i", "color=c=0xD8B49A:s=1080x1920:r=25:d=2.2",
      "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=4.2",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a]volume=-24dB[a]",
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000",
      file,
    ],
    { stdio: "pipe" },
  );
}

/** EBU R128 integrated loudness (LUFS) and true peak (dBTP) of a file's audio, or of a filtergraph run. */
export function measureLoudness(args: string[]): { i: number; tp: number } {
  const r = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-600)}`);
  const summary = r.stderr.split("Summary:").at(-1) ?? "";
  const i = summary.match(/I:\s+(-?[\d.]+|-inf)\s+LUFS/)?.[1];
  const tp = summary.match(/True peak:\s+Peak:\s+(-?[\d.]+|-inf)\s+dBFS/)?.[1];
  const num = (v: string | undefined) => (v === undefined ? NaN : v === "-inf" ? -Infinity : Number(v));
  return { i: num(i), tp: num(tp) };
}

export const loudnessOfFile = (file: string) =>
  measureLoudness(["-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);

/** Raw RGB bytes of a w x h region of the frame at `atS` seconds. */
export function regionAt(file: string, atS: number, x: number, y: number, w = 1, h = 1): Buffer {
  return execFileSync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-ss", String(atS), "-i", file, "-frames:v", "1",
      "-vf", `crop=${w}:${h}:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

/** The colour at (x, y): a 2x2 crop at even coordinates (a 1x1 crop of 4:2:0 video fails). */
export const pixelAt = (file: string, atS: number, x: number, y: number): [number, number, number] => {
  const b = regionAt(file, atS, x - (x % 2), y - (y % 2), 2, 2);
  return [b[0], b[1], b[2]];
};

/** Mean absolute difference (0-255) between the same region of two frames. */
export function meanDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - (b[i] ?? 0));
  return sum / a.length;
}

/** Top-level MP4 box types in file order (ftyp, moov, mdat, ...), read from the bytes. */
export function topLevelBoxes(bytes: Buffer): string[] {
  const types: string[] = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (size === 1) size = Number(bytes.readBigUInt64BE(at + 8)); // 64-bit "largesize"
    else if (size === 0) size = bytes.length - at; // runs to the end of the file
    if (size < 8) throw new Error(`bad MP4 box size at ${at}`);
    types.push(type);
    at += size;
  }
  return types;
}

/** One frame (PNG) at `atS` seconds, for before/after pictures. */
export function grabFrame(file: string, atS: number, png: string): void {
  execFileSync(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", String(atS), "-i", file, "-frames:v", "1", png],
    { stdio: "pipe" },
  );
}
