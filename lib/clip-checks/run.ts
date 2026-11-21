import "server-only";
import { runClaudeTask, type ClaudeBrand, type ClaudeDeps } from "@/lib/claude";
import { evaluateClip, type ClipChecksResult } from "@/lib/clip-checks/evaluate";
import { measureClip, sampleFrames } from "@/lib/clip-checks/media";
import { CLIP_CHECKS } from "@/lib/qa/config";

// All automatic consent clip checks for one local file:
// ffprobe/ffmpeg measurements, then 6 frames to Claude (MAIN) for the face
// check, then pass/fail with reshoot tips. In mock mode (MOCK_CLAUDE) the face
// answer comes from the fixture sidecar and nothing is sent anywhere.

export async function runClipChecks(
  file: string,
  opts: { brand: ClaudeBrand; clipName: string; claude?: Partial<ClaudeDeps>; now?: Date },
): Promise<ClipChecksResult> {
  const measurements = await measureClip(file);
  const frames = await sampleFrames(file, measurements.durationS, CLIP_CHECKS.face_frames);
  const face = await runClaudeTask(
    "clip_face_check",
    {
      brand: opts.brand,
      input: { clip_name: opts.clipName, frame_count: frames.length },
      images: frames.map((frame) => ({ mediaType: "image/jpeg", data: frame.toString("base64") })),
    },
    opts.claude,
  );
  return evaluateClip(measurements, face.frames, opts.now);
}
