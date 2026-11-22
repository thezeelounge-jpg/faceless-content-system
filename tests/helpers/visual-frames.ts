import { EDIT_OVERLAYS } from "@/lib/edit";
import type { EditManifest } from "@/lib/qa/edit-manifest";
import { BAND, framePlan, type FrameKind, type GrayBand } from "@/lib/qa/visual-checks";

/** What Gate 5's frame sampler returns (lib/qa/visual-gate.ts ExtractedFrame). */
export type FakeFrame = { at_seconds: number; kind: FrameKind; jpeg: Uint8Array; band: GrayBand };

/**
 * The frames the real sampler would give for this edit, drawn the way the editor draws them: the label
 * when `aiLabel`, the trial tag when `watermark` (override `draw` to fake an editor bug).
 */
export function fakeFrames(manifest: EditManifest, draw: { aiLabel: boolean; watermark: boolean }): FakeFrame[] {
  const plan = framePlan({ durationS: manifest.raw_duration_s, frameCount: Math.round(manifest.raw_duration_s * 30), fps: 30, broll: manifest.broll });
  const band = drawBand({ background: 140, label: draw.aiLabel, tag: draw.watermark });
  return plan.map((f) => ({ at_seconds: f.at_seconds, kind: f.kind, jpeg: new Uint8Array([0xff, 0xd8, 0xff, f.n % 256]), band }));
}

// p5-b2: synthetic gray top bands (the strip Gate 5 extracts, y BAND.y..BAND.y+BAND.height) for the
// pixel checks in unit tests. Drawn like ffmpeg drawtext with box=1: a dark box (black@0.55 over the
// background, limited-range luma) with white text strokes inside it. The real ffmpeg version is
// tests/integration/visual-gate-ffmpeg.test.ts.

const WHITE = 235;
const BLACK = 16;

export function drawBand(opts: { background?: number; label?: boolean; tag?: boolean; brightBits?: boolean }): GrayBand {
  const width = 1080;
  const data = new Uint8Array(width * BAND.height).fill(opts.background ?? 128);
  const put = (x: number, y: number, v: number) => {
    const row = y - BAND.y;
    if (row >= 0 && row < BAND.height && x >= 0 && x < width) data[row * width + x] = v;
  };
  const draw = (left: number, textWidth: number, o: { y: number; pad: number; size: number }, alpha: number) => {
    for (let y = o.y - o.pad; y < o.y + o.size + o.pad; y++) {
      for (let x = left - o.pad; x < left + textWidth + o.pad; x++) {
        const bg = data[(y - BAND.y) * width + x] ?? opts.background ?? 128;
        put(x, y, Math.round(bg * (1 - alpha) + BLACK * alpha));
      }
    }
    // Letter strokes: 3 px wide every 9 px, over the cap height.
    for (let y = o.y + 4; y < o.y + 28; y++) for (let x = left; x < left + textWidth; x++) if (x % 9 < 3) put(x, y, WHITE);
  };
  // A stock clip's bright shapes in the text rows (no box): white squares across the band's lower half.
  if (opts.brightBits) for (let y = 270; y < 300; y++) for (let x = 0; x < width; x++) if (x % 40 < 20) put(x, y, WHITE);
  if (opts.label) {
    const l = EDIT_OVERLAYS.label;
    draw(l.x, 230, l, 0.55);
  }
  if (opts.tag) {
    const w = EDIT_OVERLAYS.watermark;
    draw(width - w.x - 290, 290, w, 0.5);
  }
  return { width, height: BAND.height, y0: BAND.y, data };
}
