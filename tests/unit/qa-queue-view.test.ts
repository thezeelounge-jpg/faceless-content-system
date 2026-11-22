import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueueItemView } from "@/components/admin/qa-queue-item";
import { CHECKLIST_LABELS, HUMAN_CHECKLIST, HUMAN_REJECT_REASONS } from "@/lib/qa/human-review";
import type { QueueItem } from "@/lib/qa/queue-store";

// p5-b3: one video in Admin → QA queue: player (server-made signed link), why it is there,
// every gate report, the one-tap checklist, Approve, and Reject with a reason.

const item: QueueItem = {
  id: "90000000-0000-4000-8000-000000000001",
  brand_id: "b1",
  post_id: "p1",
  script_id: "s1",
  attempt: 2,
  error: null,
  final_path: "final/b1/v1/runs/r1.mp4",
  raw_path: "raw/b1/v1.mp4",
  watermark: false,
  ai_label: true,
  created_at: "2026-11-22T08:00:00Z",
  post: { title: "Three pricing mistakes", status: "team_review", status_reason: "One of this brand's first 5 videos: the team watches it." },
  brand: { name: "Ayesha Bakes" },
  reports: [
    { id: "r1", gate: "script", passed: true, score: 8, issues: [], auto_fix: null, created_at: "2026-11-22T07:00:00Z" },
    {
      id: "r2",
      gate: "audio",
      passed: false,
      score: 0.12,
      issues: [{ code: "key_term", detail: "“Ayesha” heard as “Asia”", at_seconds: 3.2, severity: "hard" }],
      auto_fix: null,
      created_at: "2026-11-22T07:10:00Z",
    },
    { id: "r3", gate: "visual", passed: true, score: 8, issues: [], auto_fix: "respelled Ayesha", created_at: "2026-11-22T07:30:00Z" },
  ],
  playUrl: "https://storage.example/signed/v1.mp4?token=abc",
  playsRaw: false,
};

const noop = async () => ({ status: "idle" as const, message: "" });
const html = (value: QueueItem) => renderToStaticMarkup(createElement(QueueItemView, { item: value, action: noop }));

describe("QueueItemView", () => {
  it("plays the signed link and says why the video is in the queue", () => {
    const out = html(item);
    expect(out).toContain('src="https://storage.example/signed/v1.mp4?token=abc"');
    expect(out).toContain("<video");
    expect(out).toContain("One of this brand&#x27;s first 5 videos");
    expect(out).toContain("Ayesha Bakes");
    expect(out).toContain("Three pricing mistakes");
  });

  it("lists every gate report with its result, score, issues and fix", () => {
    const out = html(item);
    expect(out).toContain("Gate 1 · Script");
    expect(out).toContain("Gate 3 · Audio");
    expect(out).toContain("Gate 5 · Visual");
    expect(out).toContain("key_term");
    expect(out).toContain("at 3.2 s");
    expect(out).toContain("respelled Ayesha");
    expect(out).toMatch(/Failed/);
  });

  it("has one checkbox per checklist item, Approve, a reason picker and Reject", () => {
    const out = html(item);
    for (const key of HUMAN_CHECKLIST) {
      expect(out).toContain(`name="check_${key}"`);
      expect(out).toContain(CHECKLIST_LABELS[key]);
    }
    for (const reason of HUMAN_REJECT_REASONS) expect(out).toContain(`value="${reason}"`);
    expect(out).toContain(`value="${item.id}"`);
    expect(out).toMatch(/>Approve</);
    expect(out).toMatch(/>Reject</);
  });

  it("without a finished edit: plays the raw render, says so, and offers no Approve", () => {
    const out = html({ ...item, final_path: null, playsRaw: true });
    expect(out).toMatch(/raw render/i);
    expect(out).not.toMatch(/>Approve</);
    expect(out).toMatch(/>Reject</);
  });

  it("without a player link says so in plain words; the video error shows too", () => {
    const out = html({ ...item, playUrl: null, error: "Failed the visual check twice." });
    expect(out).not.toContain("<video");
    expect(out).toMatch(/no player link/i);
    expect(out).toContain("Failed the visual check twice.");
  });
});
