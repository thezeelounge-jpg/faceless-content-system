import { clearStuckClaimAction } from "@/app/admin/claims-actions";
import { ActionForm } from "@/components/admin/action-form";

/**
 * "Clear stuck claim" (decision (b)): only for a claim with no HeyGen id.
 * The admin must tick that they checked the HeyGen dashboard first.
 */
export function ClearClaimForm({ target, id }: { target: "video" | "twin"; id: string }) {
  return (
    <ActionForm
      action={clearStuckClaimAction}
      label="Clear stuck claim"
      pendingLabel="Clearing…"
      hidden={{ target, id }}
      confirmCheck={{
        name: "confirm_checked_heygen",
        label: "I checked the HeyGen dashboard: nothing was made for this, so it is safe to start again.",
      }}
      variant="outline"
      size="sm"
    />
  );
}
