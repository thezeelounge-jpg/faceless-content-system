"use server";

import { revalidatePath } from "next/cache";
import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { requireAdmin } from "@/lib/auth";
import { confirmPlanSlot } from "@/lib/plan-slots";
import { PlainError, type ActionState } from "@/lib/plain-error";
import { humanReviewFromForm, reviewQueuedVideo } from "@/lib/qa/human-review";
import { createHumanReviewStore } from "@/lib/qa/queue-store";

// p5-b3: Admin → QA queue → Approve / Reject (Gate 6). Admin FIRST, then zod (approve: every
// checklist box; reject: a reason), then rpc review_queued_video (only a video still in the queue,
// so a double submit changes nothing; qa_reports gate 'human' + audit row in one transaction).
export async function reviewVideoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = humanReviewFromForm(formData);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Please check the form." };
  try {
    const message = await reviewQueuedVideo(parsed.data, { store: createHumanReviewStore(), adminEmail: admin.email, confirmPlanSlot });
    revalidatePath("/admin/qa");
    return { status: "ok", message };
  } catch (error) {
    if (!(error instanceof PlainError)) logAdminError("[admin] QA queue review failed", { videoId: parsed.data.videoId }, error);
    return { status: "error", message: plainAdminMessage(error, "Something went wrong. Please try again in a minute.") };
  }
}
