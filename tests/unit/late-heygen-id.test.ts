import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LATE_HEYGEN_ID_LABEL, LateHeygenIdLine } from "@/components/admin/late-heygen-id";

// p4-b1 (Rowan 5b): the admin video page shows, read only, a HeyGen id that a
// late webhook recorded (videos.late_heygen_video_id), and nothing otherwise.
// The page itself is admin only (AdminPage + requireAdmin in the loader).

const html = (id: string | null | undefined) => renderToStaticMarkup(createElement(LateHeygenIdLine, { lateHeygenVideoId: id }));

describe("LateHeygenIdLine", () => {
  it("shows the late HeyGen id in plain words when one was recorded", () => {
    const out = html("hg_late_1234");
    expect(out).toContain(LATE_HEYGEN_ID_LABEL);
    expect(out).toContain("hg_late_1234");
    expect(out).toMatch(/newer render was kept/i);
  });

  it("shows nothing when there is no late id (null, undefined or blank)", () => {
    expect(html(null)).toBe("");
    expect(html(undefined)).toBe("");
    expect(html("  ")).toBe("");
  });

  it("escapes the id (it comes from a webhook payload)", () => {
    const out = html("<script>x</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});
