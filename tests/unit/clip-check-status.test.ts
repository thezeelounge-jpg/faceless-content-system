import { describe, expect, it } from "vitest";
import { clipCheckStatusLine } from "@/lib/clip-check-status";

// Decision 2: the consent page says where the background clip check is.

describe("clip check status line", () => {
  it.each([
    [{ clip_check_status: null, clip_check_error: null }, "Not run yet."],
    [{ clip_check_status: "pending" as const, clip_check_error: null }, "Waiting to start. Refresh in a minute."],
    [{ clip_check_status: "running" as const, clip_check_error: null }, "Running now (about a minute). Refresh to see the results."],
    [{ clip_check_status: "done" as const, clip_check_error: null }, "Done."],
    [{ clip_check_status: "failed" as const, clip_check_error: "Bad .mov." }, "Could not finish: Bad .mov."],
    [{ clip_check_status: "failed" as const, clip_check_error: null }, "Could not finish. Press “Run checks” to try again."],
  ])("%o → %s", (consent, line) => {
    expect(clipCheckStatusLine(consent)).toBe(line);
  });
});
