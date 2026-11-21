import { describe, expect, it, vi } from "vitest";
import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { ClaudeError } from "@/lib/claude";

describe("admin error messages", () => {
  it("shows our own plain Claude sentences, but never raw database text", () => {
    expect(plainAdminMessage(new ClaudeError("busy", "Claude is busy right now."), "Fallback.")).toBe("Claude is busy right now.");
    expect(plainAdminMessage(new Error('relation "public.x" does not exist'), "Fallback.")).toBe("Fallback.");
    expect(plainAdminMessage("weird", "Fallback.")).toBe("Fallback.");
  });

  it("logs the details with context on the server", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logAdminError("[admin] x failed", { brandId: "b1" }, new ClaudeError("refusal", "Declined."));
    expect(log).toHaveBeenCalledWith("[admin] x failed", expect.objectContaining({ brandId: "b1", error: "Declined.", code: "refusal" }));
    log.mockRestore();
  });

  // Built at run time so no key-like string sits in the source.
  const FAKE_KEY = ["sk", "ant", "api03", "FAKE".repeat(10)].join("-");

  /** An Anthropic SDK APIError, roughly: status, headers, parsed error body. */
  function apiError() {
    return Object.assign(new Error(`400 {"type":"error","error":{"type":"invalid_request_error","message":"bad key ${FAKE_KEY}"}}`), {
      name: "BadRequestError",
      status: 400,
      headers: new Headers({ "x-api-key": FAKE_KEY, "request-id": "req_1" }),
      error: { type: "error", error: { type: "invalid_request_error", message: `bad key ${FAKE_KEY}` } },
      requestBody: { system: FAKE_KEY },
    });
  }

  function logged(fn: () => void): string {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fn();
    const text = JSON.stringify(log.mock.calls);
    log.mockRestore();
    return text;
  }

  it("logs the cause chain: API status, error name and type", () => {
    const wrapped = new ClaudeError("failed", "Claude call failed (400). See server logs.", { cause: apiError() });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logAdminError("[admin] x failed", { postId: "p1" }, wrapped);
    const [, details] = log.mock.calls[0] as [string, { causes: unknown[] }];
    log.mockRestore();
    expect(details.causes).toEqual([
      expect.objectContaining({ name: "BadRequestError", status: 400, type: "invalid_request_error" }),
    ]);
  });

  it("never logs a key-like string, headers or request bodies from a cause", () => {
    const text = logged(() =>
      logAdminError("[admin] x failed", {}, new ClaudeError("failed", "Claude call failed.", { cause: apiError() })),
    );
    // The status can only come from the cause here.
    expect(text).toMatch(/"status":400/);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain("FAKEFAKE");
    expect(text).not.toMatch(/x-api-key|requestBody/i);
  });

  it("redacts a key-like string placed in a cause's name, type or code", () => {
    const sneaky = Object.assign(new Error("plain message"), {
      name: `Err ${FAKE_KEY}`,
      status: 500,
      code: `code ${FAKE_KEY}`,
      error: { type: "error", error: { type: `type ${FAKE_KEY}` } },
    });
    const text = logged(() => logAdminError("[admin] x failed", {}, new Error("outer", { cause: sneaky })));
    expect(text).toMatch(/"status":500/);
    expect(text).not.toContain("FAKEFAKE");
    expect(text).toContain("Err [redacted]");
    expect(text).toContain("code [redacted]");
    expect(text).toContain("type [redacted]");
  });

  it("follows nested causes, but stops after a few (no endless loops)", () => {
    const inner = Object.assign(new Error("socket hang up"), { name: "APIConnectionError" });
    const middle = new Error("retry failed", { cause: inner });
    const loop = new Error("outer", { cause: middle }) as Error & { cause: unknown };
    (inner as Error & { cause?: unknown }).cause = loop; // a cycle
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logAdminError("[admin] x failed", {}, loop);
    const [, details] = log.mock.calls[0] as [string, { causes: { name: string }[] }];
    log.mockRestore();
    expect(details.causes.map((c) => c.name).slice(0, 2)).toEqual(["Error", "APIConnectionError"]);
    expect(details.causes.length).toBeLessThanOrEqual(5);
  });
});
