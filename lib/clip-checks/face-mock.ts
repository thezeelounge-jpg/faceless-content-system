import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { clipFaceOutput, type ClipFaceOutput } from "@/lib/ai-schemas";

// Mock answer for the clip_face_check Claude task (MOCK_CLAUDE=true).
// Deterministic and driven by the fixture: tests/fixtures/<clip>.vision.json
// holds the answer for that fixture clip. Any other clip (for example a real
// upload while Claude is mocked) gets "one clear face" in every frame.

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");

export function mockClipFaceCheck(input: { clip_name: string; frame_count: number }): ClipFaceOutput {
  const base = path.basename(input.clip_name).replace(/\.[a-z0-9]+$/i, "");
  const sidecar = /^[a-z0-9._-]+$/i.test(base) ? path.join(FIXTURES, `${base}.vision.json`) : null;
  if (sidecar && existsSync(sidecar)) {
    return clipFaceOutput.parse(JSON.parse(readFileSync(sidecar, "utf8")));
  }
  return { frames: Array.from({ length: input.frame_count }, () => ({ faces: 1, face_clear: true })) };
}
