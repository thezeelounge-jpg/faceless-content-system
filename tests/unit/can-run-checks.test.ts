import { describe, expect, it } from "vitest";
import { canRunChecks, latestScript } from "@/lib/qa/can-run-checks";

// One rule, used by the client page (show "Run checks"?) and by the
// checkScript action (allow it?), so the two can never disagree.

const v = (version: number, qa_status: string, spoken_text: string | null = null) => ({
  id: `s${version}`,
  version,
  qa_status,
  spoken_text,
});

describe("latestScript", () => {
  it("picks the highest version, whatever the order", () => {
    expect(latestScript([v(2, "pending"), v(1, "failed")])?.id).toBe("s2");
    expect(latestScript([])).toBeUndefined();
  });
});

describe("canRunChecks (shared by the page and the Run checks action)", () => {
  const scripting = { status: "scripting" };

  it("yes for a pending latest version (first draft, or a rewrite whose check didn't finish)", () => {
    expect(canRunChecks([v(1, "pending")], scripting)).toBe(true);
    expect(canRunChecks([v(1, "failed"), v(2, "pending")], scripting)).toBe(true);
  });

  it("yes for a passed script that has no spoken text yet (Gate 2 didn't finish)", () => {
    expect(canRunChecks([v(1, "passed")], scripting)).toBe(true);
    expect(canRunChecks([v(1, "passed", "spoken")], scripting)).toBe(false);
  });

  it("yes when the post is still planned (the post update after saving failed)", () => {
    expect(canRunChecks([v(1, "pending")], { status: "planned" })).toBe(true);
  });

  it("no once the checks have routed the post on", () => {
    expect(canRunChecks([v(1, "failed"), v(2, "team_review")], { status: "team_review" })).toBe(false);
    expect(canRunChecks([v(1, "failed"), v(2, "failed")], { status: "needs_you" })).toBe(false);
    expect(canRunChecks([v(1, "passed", "spoken")], { status: "script_review" })).toBe(false);
    // Even a pending script is left alone once the post has moved on.
    expect(canRunChecks([v(1, "pending")], { status: "approved" })).toBe(false);
  });

  it("no when there is no script, or only an old failed version", () => {
    expect(canRunChecks([], scripting)).toBe(false);
    expect(canRunChecks([v(1, "failed")], scripting)).toBe(false);
  });
});
