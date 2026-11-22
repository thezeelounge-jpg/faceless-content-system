import { ClearClaimForm } from "@/components/admin/clear-claim-form";
import { canClearClaim, clearableAt, karachiDateTime, karachiTime } from "@/lib/claims";

/**
 * p4-fix c1: the "Clear stuck claim" button, but only after the 30-minute
 * wait (or once the row failed). Before that: when it can be cleared.
 * Render it only inside admin pages, after the admin check and data loading.
 */
export function ClaimClearOrWait(props: { target: "video" | "twin"; id: string; startedAt: string; status: string }) {
  if (canClearClaim({ startedAt: props.startedAt, status: props.status, target: props.target }, new Date())) {
    return <ClearClaimForm target={props.target} id={props.id} />;
  }
  const at = clearableAt(props.startedAt, props.target);
  // Twins wait about a day, so show the date too.
  const when = props.target === "twin" ? karachiDateTime(at) : karachiTime(at);
  return (
    <p className="text-muted-foreground text-sm">
      HeyGen may still be making this. It can be cleared after {when} (Karachi time).
    </p>
  );
}
