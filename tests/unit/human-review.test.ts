import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewHistory } from "@/components/admin/review-history";
import {
  HUMAN_CHECKLIST,
  humanReviewFromForm,
  lastReject,
  reviewQueuedVideo,
  REVIEW_MESSAGES,
  type HumanReviewStore,
} from "@/lib/qa/human-review";

describe("p5-b4: past Gate 6 decisions are shown to ADMINS (client page, QA queue)", () => {
  const reject = { decision: "reject" as const, reason: "lip_sync", note: "Mouth drifts at 0:07.", admin: "ops@x.com", created_at: "2026-11-22T10:00:00Z" };
  const approve = { decision: "approve" as const, reason: null, note: null, admin: "ops@x.com", created_at: "2026-11-21T10:00:00Z" };

  it("the reject message says the post is back to approved and nothing is rendered automatically", () => {
    expect(REVIEW_MESSAGES.rejected).toMatch(/back to approved/i);
    expect(REVIEW_MESSAGES.rejected).toMatch(/Make video/);
    expect(REVIEW_MESSAGES.rejected).toMatch(/nothing is rendered automatically/i);
  });

  it("lastReject: the newest decision when it is a reject, else null", () => {
    expect(lastReject([approve, reject])).toEqual(reject);
    expect(lastReject([reject, { ...approve, created_at: "2026-11-23T00:00:00Z" }])).toBeNull();
    expect(lastReject([])).toBeNull();
    expect(lastReject(undefined)).toBeNull();
  });

  it("ReviewHistory shows the reason (plain label), the note, who and when, newest first", () => {
    const html = renderToStaticMarkup(createElement(ReviewHistory, { reviews: [approve, reject] }));
    expect(html).toContain("Rejected: Lip-sync off");
    expect(html).toContain("Mouth drifts at 0:07.");
    expect(html).toContain("ops@x.com");
    expect(html).toContain("2026-11-22 10:00 UTC");
    expect(html.indexOf("Rejected")).toBeLessThan(html.indexOf("Approved"));
    expect(renderToStaticMarkup(createElement(ReviewHistory, { reviews: [] }))).toBe("");
  });
});

// p5-b3: Gate 6, Admin → QA queue. Approve needs every checklist box; Reject needs a reason.
// The Server Action: requireAdmin FIRST, then zod, then the rpc (review_queued_video).

const VIDEO = "90000000-0000-4000-8000-000000000001";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}
const ticked = (except?: string) =>
  Object.fromEntries(HUMAN_CHECKLIST.filter((item) => item !== except).map((item) => [`check_${item}`, "yes"]));

describe("humanReviewFromForm", () => {
  it("approve parses only when every box is ticked", () => {
    expect(humanReviewFromForm(form({ decision: "approve", video_id: VIDEO, ...ticked() })).success).toBe(true);
    for (const item of HUMAN_CHECKLIST) {
      const parsed = humanReviewFromForm(form({ decision: "approve", video_id: VIDEO, ...ticked(item) }));
      expect(parsed.success, item).toBe(false);
    }
  });

  it("reject needs a known reason; the note is optional and trimmed", () => {
    expect(humanReviewFromForm(form({ decision: "reject", video_id: VIDEO })).success).toBe(false);
    expect(humanReviewFromForm(form({ decision: "reject", video_id: VIDEO, reason: "boring" })).success).toBe(false);
    const parsed = humanReviewFromForm(form({ decision: "reject", video_id: VIDEO, reason: "lip_sync", note: "  drifts at 0:07 " }));
    expect(parsed.success && parsed.data).toEqual({ decision: "reject", videoId: VIDEO, reason: "lip_sync", note: "drifts at 0:07" });
  });

  it("refuses a bad video id or decision", () => {
    expect(humanReviewFromForm(form({ decision: "approve", video_id: "nope", ...ticked() })).success).toBe(false);
    expect(humanReviewFromForm(form({ decision: "publish", video_id: VIDEO, ...ticked() })).success).toBe(false);
  });
});

describe("reviewQueuedVideo", () => {
  const store = (outcome: Awaited<ReturnType<HumanReviewStore["review"]>>["outcome"]) => ({ review: vi.fn().mockResolvedValue({ outcome, brandId: outcome === "approved" ? "brand-1" : null }) });
  const allTrue = Object.fromEntries(HUMAN_CHECKLIST.map((i) => [i, true as const])) as Record<(typeof HUMAN_CHECKLIST)[number], true>;

  it("approve: passes the checklist and the admin's email, confirms the plan slot, plain message", async () => {
    const s = store("approved");
    const confirmPlanSlot = vi.fn().mockResolvedValue(undefined);
    const msg = await reviewQueuedVideo({ decision: "approve", videoId: VIDEO, checklist: allTrue }, { store: s, adminEmail: "ops@x.com", confirmPlanSlot });
    expect(msg).toBe(REVIEW_MESSAGES.approved);
    expect(s.review).toHaveBeenCalledWith({ videoId: VIDEO, decision: "approve", checklist: allTrue, reason: null, note: null, adminEmail: "ops@x.com" });
    expect(confirmPlanSlot).toHaveBeenCalledWith({ id: VIDEO, brand_id: "brand-1" });
  });

  it("reject: reason + note, no plan slot", async () => {
    const s = store("rejected");
    const confirmPlanSlot = vi.fn();
    const msg = await reviewQueuedVideo({ decision: "reject", videoId: VIDEO, reason: "music", note: "too loud" }, { store: s, adminEmail: "ops@x.com", confirmPlanSlot });
    expect(msg).toBe(REVIEW_MESSAGES.rejected);
    expect(s.review).toHaveBeenCalledWith({ videoId: VIDEO, decision: "reject", checklist: {}, reason: "music", note: "too loud", adminEmail: "ops@x.com" });
    expect(confirmPlanSlot).not.toHaveBeenCalled();
  });

  it("a double submit (not_in_queue) and other refusals are plain errors; no plan slot", async () => {
    for (const outcome of ["not_in_queue", "not_found", "checklist_incomplete", "no_final_file", "bad_input"] as const) {
      const confirmPlanSlot = vi.fn();
      await expect(
        reviewQueuedVideo({ decision: "approve", videoId: VIDEO, checklist: allTrue }, { store: store(outcome), adminEmail: "a", confirmPlanSlot }),
      ).rejects.toThrow(REVIEW_MESSAGES[outcome]);
      expect(confirmPlanSlot).not.toHaveBeenCalled();
    }
  });
});

const requireAdmin = vi.fn();
const rpcReview = vi.fn();
const confirmPlanSlot = vi.fn();
vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/plan-slots", () => ({ confirmPlanSlot: (v: unknown) => confirmPlanSlot(v) }));
vi.mock("@/lib/qa/queue-store", () => ({ createHumanReviewStore: () => ({ review: (a: unknown) => rpcReview(a) }) }));

const { reviewVideoAction } = await import("@/app/admin/qa/actions");
const idle = { status: "idle" as const, message: "" };

describe("reviewVideoAction", () => {
  beforeEach(() => {
    requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: "ops@x.com", isAdmin: true });
    rpcReview.mockReset().mockResolvedValue({ outcome: "approved", brandId: "brand-1" });
    confirmPlanSlot.mockReset().mockResolvedValue(undefined);
  });

  it("checks admin before anything else (even before reading the form)", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(reviewVideoAction(idle, form({ decision: "approve", video_id: VIDEO, ...ticked() }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(rpcReview).not.toHaveBeenCalled();
  });

  it("approve with a missing box never reaches the database", async () => {
    expect(await reviewVideoAction(idle, form({ decision: "approve", video_id: VIDEO, ...ticked("label") }))).toEqual({
      status: "error",
      message: "Tick every box before approving.",
    });
    expect(rpcReview).not.toHaveBeenCalled();
  });

  it("approve: the rpc gets the admin's email; ok message", async () => {
    expect(await reviewVideoAction(idle, form({ decision: "approve", video_id: VIDEO, ...ticked() }))).toEqual({ status: "ok", message: REVIEW_MESSAGES.approved });
    expect(rpcReview).toHaveBeenCalledWith(expect.objectContaining({ videoId: VIDEO, decision: "approve", adminEmail: "ops@x.com" }));
    expect(confirmPlanSlot).toHaveBeenCalledWith({ id: VIDEO, brand_id: "brand-1" });
  });

  it("reject without a reason is refused; with one it goes through", async () => {
    expect(await reviewVideoAction(idle, form({ decision: "reject", video_id: VIDEO }))).toEqual({ status: "error", message: "Pick a reason." });
    expect(rpcReview).not.toHaveBeenCalled();
    rpcReview.mockResolvedValue({ outcome: "rejected" });
    expect(await reviewVideoAction(idle, form({ decision: "reject", video_id: VIDEO, reason: "captions" }))).toEqual({ status: "ok", message: REVIEW_MESSAGES.rejected });
  });

  it("double submit: a plain 'already decided' error; a database failure is a plain sentence", async () => {
    rpcReview.mockResolvedValue({ outcome: "not_in_queue" });
    expect(await reviewVideoAction(idle, form({ decision: "approve", video_id: VIDEO, ...ticked() }))).toEqual({ status: "error", message: REVIEW_MESSAGES.not_in_queue });
    vi.spyOn(console, "error").mockImplementation(() => {});
    rpcReview.mockRejectedValue(new Error("[qa-queue] review video: connection reset"));
    expect(await reviewVideoAction(idle, form({ decision: "approve", video_id: VIDEO, ...ticked() }))).toEqual({
      status: "error",
      message: "Something went wrong. Please try again in a minute.",
    });
  });
});
