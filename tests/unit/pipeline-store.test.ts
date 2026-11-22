import { describe, expect, it } from "vitest";
import { deliverResult, distinctPosts, rerenderResult } from "@/lib/qa/pipeline-store";

// lib/qa/pipeline-store.ts is the Supabase glue for the video gates. Its rpc answer parsers are pure.

describe("rerenderResult (rpc create_qa_rerender / create_visual_rerender answer)", () => {
  it("maps each outcome; anything else is an error", () => {
    expect(rerenderResult({ outcome: "created", video_id: "v2" })).toEqual({ outcome: "created", videoId: "v2" });
    for (const outcome of ["limit", "not_allowed", "not_found"]) {
      expect(rerenderResult({ outcome, video_id: null })).toEqual({ outcome, videoId: null });
    }
    expect(() => rerenderResult({ outcome: "maybe" })).toThrow(/unexpected answer/);
    expect(() => rerenderResult({ outcome: "created", video_id: null })).toThrow(/unexpected answer/);
  });
});

describe("p5-b2: deliverResult (rpc deliver_post_video answer)", () => {
  it("maps each outcome; anything else is an error", () => {
    for (const outcome of ["delivered", "not_allowed", "not_found"]) expect(deliverResult({ outcome })).toBe(outcome);
    expect(() => deliverResult({ outcome: "ready" })).toThrow(/unexpected answer/);
    expect(() => deliverResult(null)).toThrow(/unexpected answer/);
  });
});

describe("p5-b2: distinctPosts (first-5 rule: how many OTHER posts of the brand already passed Gate 5)", () => {
  it("counts each post once and never the current post; rows without a post are ignored", () => {
    const rows = [
      { videos: { post_id: "p1" } },
      { videos: { post_id: "p1" } },
      { videos: { post_id: "p2" } },
      { videos: { post_id: "me" } },
      { videos: null },
    ];
    expect(distinctPosts(rows, "me")).toBe(2);
    expect(distinctPosts([], "me")).toBe(0);
  });
});
