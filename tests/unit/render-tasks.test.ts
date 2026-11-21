import { describe, expect, it, vi } from "vitest";
import { RENDER } from "@/lib/qa/config";

// The render Trigger.dev tasks stay thin: a zod payload, limits, a queue, and
// calls into lib/render.ts. Never run against Trigger.dev in tests.

vi.mock("@/lib/video-store", () => ({ createVideoStore: vi.fn(), createVideoFiles: vi.fn() }));
vi.mock("@/lib/heygen-spend-store", () => ({ createSpendStore: vi.fn() }));

const { renderVideoTask, renderPayload, renderQueue } = await import("@/trigger/render-video");
const { pollRenderTask, pollRenderPayload } = await import("@/trigger/poll-render");

vi.mock("@/lib/consent-store", () => ({ createConsentStore: vi.fn() }));
const { likenessTestTask, likenessPayload } = await import("@/trigger/likeness-test");

const ID = "90000000-0000-4000-8000-000000000001";

describe("likeness-test task", () => {
  it("has a stable id; payload = twin UUID + optional boolean confirmSpend", () => {
    expect(likenessTestTask.id).toBe("likeness-test");
    expect(likenessPayload.parse({ avatarId: ID, confirmSpend: true })).toEqual({ avatarId: ID, confirmSpend: true });
    expect(() => likenessPayload.parse({ avatarId: ID, confirmSpend: "yes" })).toThrow();
    expect(() => likenessPayload.parse({ avatarId: "x" })).toThrow();
  });
});

describe("render tasks", () => {
  it("have stable ids", () => {
    expect(renderVideoTask.id).toBe("render-video");
    expect(pollRenderTask.id).toBe("poll-render");
  });

  it("render-video runs on a queue of at most 10 at once (HeyGen's limit)", () => {
    expect(RENDER.max_concurrent).toBe(10);
    expect(renderQueue).toMatchObject({ name: "heygen-renders", concurrencyLimit: RENDER.max_concurrent });
  });

  it("payloads: a video UUID; confirmSpend only as a real boolean", () => {
    expect(renderPayload.parse({ videoId: ID })).toEqual({ videoId: ID });
    expect(renderPayload.parse({ videoId: ID, confirmSpend: true })).toEqual({ videoId: ID, confirmSpend: true });
    expect(() => renderPayload.parse({ videoId: ID, confirmSpend: "yes" })).toThrow();
    expect(() => renderPayload.parse({ videoId: "1; drop table" })).toThrow();
    expect(pollRenderPayload.parse({ videoId: ID })).toEqual({ videoId: ID });
    expect(() => pollRenderPayload.parse({})).toThrow();
  });
});
