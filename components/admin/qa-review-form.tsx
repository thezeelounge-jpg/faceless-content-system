"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/plain-error";
import { CHECKLIST_LABELS, HUMAN_CHECKLIST, HUMAN_REJECT_REASONS, REJECT_REASON_LABELS } from "@/lib/qa/human-review";

const idle: ActionState = { status: "idle", message: "" };

/**
 * p5-b3: Gate 6 decision for one queued video. Approve = every checklist box ticked (the Server
 * Action and the database both check again). Reject = one reason (+ an optional note).
 * Without a finished edit only Reject is offered (the database refuses an approval too).
 */
export function QaReviewForm({
  videoId,
  canApprove,
  action,
}: {
  videoId: string;
  canApprove: boolean;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [approveState, approveAction, approving] = useActionState(action, idle);
  const [rejectState, rejectAction, rejecting] = useActionState(action, idle);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {canApprove && (
        <form action={approveAction} className="space-y-2" aria-busy={approving}>
          <input type="hidden" name="video_id" value={videoId} />
          <input type="hidden" name="decision" value="approve" />
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium">Checklist (watch the whole video)</legend>
            {HUMAN_CHECKLIST.map((item) => (
              <label key={item} className="flex items-start gap-2">
                <input type="checkbox" name={`check_${item}`} value="yes" required className="mt-1" />
                <span>{CHECKLIST_LABELS[item]}</span>
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={approving}>
            {approving ? "Approving…" : "Approve"}
          </Button>
          {approveState.message && (
            <p role="status" className={approveState.status === "error" ? "text-destructive text-sm" : "text-sm"}>
              {approveState.message}
            </p>
          )}
        </form>
      )}
      <form action={rejectAction} className="space-y-2" aria-busy={rejecting}>
        <input type="hidden" name="video_id" value={videoId} />
        <input type="hidden" name="decision" value="reject" />
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Reason</span>
          <select name="reason" required defaultValue="" className="border-input block w-full rounded-md border px-2 py-1">
            <option value="" disabled>
              Pick a reason
            </option>
            {HUMAN_REJECT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {REJECT_REASON_LABELS[reason]}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Note (optional: what and where)</span>
          <input type="text" name="note" maxLength={300} className="border-input block w-full rounded-md border px-2 py-1" />
        </label>
        <Button type="submit" variant="outline" disabled={rejecting}>
          {rejecting ? "Rejecting…" : "Reject"}
        </Button>
        {rejectState.message && (
          <p role="status" className={rejectState.status === "error" ? "text-destructive text-sm" : "text-sm"}>
            {rejectState.message}
          </p>
        )}
      </form>
    </div>
  );
}
