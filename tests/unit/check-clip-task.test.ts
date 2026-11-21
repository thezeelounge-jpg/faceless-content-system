import { describe, expect, it, vi } from "vitest";

// Decision 2: the clip checks run in a thin Trigger.dev task. The logic stays
// in lib/consent-flow.ts (runClipCheckJob). Never run against Trigger.dev here.

vi.mock("@/lib/consent-store", () => ({ createConsentStore: vi.fn(), createClipStorage: vi.fn() }));

const { checkClipTask, checkClipPayload } = await import("@/trigger/check-clip");

describe("check-clip task", () => {
  it("has a stable id, a time limit, retries and a 2 GB machine (ffmpeg converts .mov)", () => {
    expect(checkClipTask.id).toBe("check-clip");
  });

  it("accepts only a consent UUID and a clip path inside that consent's folder", () => {
    const consentId = "c0000000-0000-4000-8000-000000000001";
    const clipPath = `10000000-0000-0000-0000-000000000001/${consentId}/11111111-1111-4111-8111-111111111111.mov`;
    expect(checkClipPayload.parse({ consentId, clipPath })).toEqual({ consentId, clipPath });
    expect(() => checkClipPayload.parse({ consentId: "x", clipPath })).toThrow();
    expect(() => checkClipPayload.parse({ consentId, clipPath: "../../etc/passwd" })).toThrow();
    expect(() => checkClipPayload.parse({ consentId, clipPath: "a".repeat(400) })).toThrow();
  });
});
