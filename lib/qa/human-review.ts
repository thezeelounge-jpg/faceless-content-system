// p5-b3: Gate 6, the admin QA queue (QA-SPEC "Gate 6: Human review").
//
// The operator watches the whole video and ticks one box per checklist item. Approve needs every
// box; Reject needs one reason. The database does the rest in one transaction (rpc
// review_queued_video, migration 20261123010000): only a video still in team_review, the usage rule
// on approve, a qa_reports row with gate 'human' and one audit row. The lists below are repeated in
// that SQL (tests/db/rls.test.ts checks they match).
import { z } from "zod";
import { PlainError } from "@/lib/plain-error";

/** QA-SPEC Gate 6: "one tap per item: pronunciation, lip-sync, looks real, captions, b-roll, music, label". */
export const HUMAN_CHECKLIST = ["pronunciation", "lip_sync", "looks_real", "captions", "broll", "music", "label"] as const;
export type ChecklistItem = (typeof HUMAN_CHECKLIST)[number];

export const CHECKLIST_LABELS: Record<ChecklistItem, string> = {
  pronunciation: "Every word said right",
  lip_sync: "Lips match the voice",
  looks_real: "Looks real",
  captions: "Captions right and clear of the face",
  broll: "B-roll fits",
  music: "Music quiet under the voice",
  label: "AI label there (and trial tag only on trials)",
};

/** A reject reason: one checklist item that failed, or "other". */
export const HUMAN_REJECT_REASONS = [...HUMAN_CHECKLIST, "other"] as const;
export type RejectReason = (typeof HUMAN_REJECT_REASONS)[number];

export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  pronunciation: "Said something wrong",
  lip_sync: "Lip-sync off",
  looks_real: "Doesn't look real",
  captions: "Captions",
  broll: "B-roll",
  music: "Music",
  label: "Label or trial tag",
  other: "Other",
};

/**
 * p5-b4 (QA SF2): what a reject writes into posts.status_reason, which CUSTOMERS can read. Neutral,
 * never the reason or the admin's note (those live only in the server-only human_reviews table).
 * Same words as PRODUCT.md's "problem" line. Repeated in migration 20261123020000 (tested equal).
 */
export const REJECT_CUSTOMER_REASON = "Taking a little longer. We're fixing it.";

const TICK_EVERY_BOX ="Tick every box before approving.";
const uuid = z.string().uuid("Unknown video.");
const note = z.string().trim().max(300, "Keep the note under 300 characters.");

export const humanReviewInput = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    videoId: uuid,
    checklist: z.object(
      Object.fromEntries(HUMAN_CHECKLIST.map((item) => [item, z.literal(true, { error: TICK_EVERY_BOX })])) as Record<ChecklistItem, z.ZodLiteral<true>>,
      { error: TICK_EVERY_BOX },
    ),
  }),
  z.object({
    decision: z.literal("reject"),
    videoId: uuid,
    reason: z.enum(HUMAN_REJECT_REASONS, { error: "Pick a reason." }),
    note: note.optional(),
  }),
]);
export type HumanReviewInput = z.infer<typeof humanReviewInput>;

/** Read a submitted form: checkbox "check_<item>" = "yes", "decision", "video_id", "reason", "note". */
export function humanReviewFromForm(form: FormData): z.ZodSafeParseResult<HumanReviewInput> {
  const decision = form.get("decision");
  const videoId = form.get("video_id");
  if (decision === "approve") {
    const checklist = Object.fromEntries(HUMAN_CHECKLIST.map((item) => [item, form.get(`check_${item}`) === "yes"]));
    return humanReviewInput.safeParse({ decision, videoId, checklist });
  }
  const noteValue = form.get("note");
  return humanReviewInput.safeParse({
    decision,
    videoId,
    reason: form.get("reason") ?? undefined,
    note: typeof noteValue === "string" && noteValue.trim() !== "" ? noteValue : undefined,
  });
}

export type ReviewOutcome = "approved" | "rejected" | "not_in_queue" | "not_found" | "checklist_incomplete" | "no_final_file" | "bad_input";

export type HumanReviewStore = {
  /** rpc review_queued_video. `brandId` comes back with an approval (for the plan slot). */
  review(args: {
    videoId: string;
    decision: "approve" | "reject";
    checklist: Record<string, boolean>;
    reason: string | null;
    note: string | null;
    adminEmail: string;
  }): Promise<{ outcome: ReviewOutcome; brandId?: string | null }>;
};

export const REVIEW_MESSAGES: Record<ReviewOutcome, string> = {
  approved: "Approved. The video is ready for the customer.",
  rejected:
    "Rejected. The video will not reach the customer and never counts. The post is back to approved: press Make video on the client page to try again (nothing is rendered automatically).",
  not_in_queue: "This video is no longer in the QA queue (someone already decided). Nothing changed.",
  not_found: "Video not found.",
  checklist_incomplete: "Tick every box before approving.",
  no_final_file: "This video has no finished edit yet, so it can't be approved. Reject it or fix the edit first.",
  bad_input: "Pick a reason.",
};

/** p5-b4: one row of the server-only human_reviews table (admins only). */
export type HumanReviewRow = { decision: "approve" | "reject"; reason: string | null; note: string | null; admin: string; created_at: string };

const newestFirst = (reviews: HumanReviewRow[]) => [...reviews].sort((a, b) => b.created_at.localeCompare(a.created_at));

/** The post's newest Gate 6 decision when it is a reject (the client page shows it next to Make video), else null. */
export function lastReject(reviews: HumanReviewRow[] | undefined): HumanReviewRow | null {
  const newest = newestFirst(reviews ?? [])[0];
  return newest?.decision === "reject" ? newest : null;
}

/** Admin wording for one decision, e.g. "Rejected: Lip-sync off". */
export function reviewHeadline(review: HumanReviewRow): string {
  if (review.decision === "approve") return "Approved";
  const label = REJECT_REASON_LABELS[review.reason as RejectReason] ?? review.reason ?? "no reason";
  return `Rejected: ${label}`;
}

/** Newest first, for the history list. */
export function sortReviews(reviews: HumanReviewRow[]): HumanReviewRow[] {
  return newestFirst(reviews);
}

/**
 * Approve or reject one queued video. The caller (Server Action) has ALREADY run requireAdmin().
 * Returns a plain message for the admin; throws PlainError for a refusal.
 */
export async function reviewQueuedVideo(
  input: HumanReviewInput,
  deps: { store: HumanReviewStore; adminEmail: string; confirmPlanSlot?: (video: { id: string; brand_id: string }) => Promise<void> },
): Promise<string> {
  const { outcome, brandId } = await deps.store.review({
    videoId: input.videoId,
    decision: input.decision,
    checklist: input.decision === "approve" ? { ...input.checklist } : {},
    reason: input.decision === "reject" ? input.reason : null,
    note: input.decision === "reject" ? (input.note ?? null) : null,
    adminEmail: deps.adminEmail,
  });
  if (outcome === "approved") {
    // The video is delivered now (the rpc committed); the plan slot is confirmed after (stub until Phase 7).
    if (brandId) await deps.confirmPlanSlot?.({ id: input.videoId, brand_id: brandId });
    return REVIEW_MESSAGES.approved;
  }
  if (outcome === "rejected") return REVIEW_MESSAGES.rejected;
  throw new PlainError(REVIEW_MESSAGES[outcome]);
}
