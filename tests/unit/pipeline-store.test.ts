import { describe, expect, it } from "vitest";
import { rerenderResult } from "@/lib/qa/pipeline-store";

// lib/qa/pipeline-store.ts is the Supabase glue for the video gates. Its rpc answer parser is pure.

describe("rerenderResult (rpc create_qa_rerender answer)", () => {
  it("maps each outcome; anything else is an error", () => {
    expect(rerenderResult({ outcome: "created", video_id: "v2" })).toEqual({ outcome: "created", videoId: "v2" });
    for (const outcome of ["limit", "not_allowed", "not_found"]) {
      expect(rerenderResult({ outcome, video_id: null })).toEqual({ outcome, videoId: null });
    }
    expect(() => rerenderResult({ outcome: "maybe" })).toThrow(/unexpected answer/);
    expect(() => rerenderResult({ outcome: "created", video_id: null })).toThrow(/unexpected answer/);
  });
});
