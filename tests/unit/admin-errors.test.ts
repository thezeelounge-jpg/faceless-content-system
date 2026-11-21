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
    expect(log).toHaveBeenCalledWith("[admin] x failed", { brandId: "b1", error: "Declined.", code: "refusal" });
    log.mockRestore();
  });
});
