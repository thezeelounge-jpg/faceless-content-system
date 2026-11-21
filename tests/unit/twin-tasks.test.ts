import { describe, expect, it, vi } from "vitest";

// The Trigger.dev task files stay thin: a zod payload, limits, and a call into
// lib/twin.ts. They are never run against Trigger.dev in tests.

vi.mock("@/lib/consent-store", () => ({ createConsentStore: vi.fn(), createClipStorage: vi.fn() }));

const { createTwinTask, twinPayload } = await import("@/trigger/create-twin");
const { pollTwinTask, pollPayload } = await import("@/trigger/poll-twin");

describe("twin tasks", () => {
  it("have stable ids", () => {
    expect(createTwinTask.id).toBe("create-twin");
    expect(pollTwinTask.id).toBe("poll-twin");
  });

  it("accept only a consent id / avatar id that is a UUID", () => {
    const id = "c0000000-0000-4000-8000-000000000001";
    expect(twinPayload.parse({ consentId: id })).toEqual({ consentId: id });
    expect(() => twinPayload.parse({ consentId: "1; drop table" })).toThrow();
    expect(pollPayload.parse({ avatarId: id })).toEqual({ avatarId: id });
    expect(() => pollPayload.parse({})).toThrow();
  });
});
