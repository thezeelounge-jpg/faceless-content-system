import { describe, expect, it } from "vitest";
import { loadRecordingGuide, parseGuide } from "@/lib/recording-guide";

describe("recording guide", () => {
  it("turns the Markdown into sections of plain lines (no ** or list markers)", () => {
    const md = "# Title\n\nIntro line.\n\n## Camera\n\n- Use the **back camera**.\n1. Say the words.\n- [ ] Self check\n";
    expect(parseGuide(md)).toEqual([
      { heading: "Title", lines: ["Intro line."] },
      { heading: "Camera", lines: ["Use the back camera.", "Say the words.", "Self check"] },
    ]);
  });

  it("loads docs/RECORDING-GUIDE.md, including the 3 words step and the light tips", () => {
    const sections = loadRecordingGuide();
    expect(sections.map((s) => s.heading)).toEqual(
      expect.arrayContaining(["How to record your clip", "Camera", "Light", "How to talk"]),
    );
    const all = sections.flatMap((s) => s.lines).join("\n");
    expect(all).toContain("Start by saying the 3 words shown in the app");
    expect(all).not.toContain("**");
  });
});
