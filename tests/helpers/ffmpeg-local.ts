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

/** One frame (PNG) at `atS` seconds, for before/after pictures. */
export function grabFrame(file: string, atS: number, png: string): void {
  execFileSync(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", String(atS), "-i", file, "-frames:v", "1", png],
    { stdio: "pipe" },
  );
}
