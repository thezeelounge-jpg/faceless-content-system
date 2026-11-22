import { resumeRendersAction } from "@/app/admin/settings/actions";
import { ActionForm } from "@/components/admin/action-form";
import { requireAdmin } from "@/lib/auth";
import { createSpendStore } from "@/lib/heygen-spend-store";

/**
 * Admin → Settings: the HeyGen pause switch (p4-fix e). "Resume renders" is
 * shown only while renders_paused is on, needs the "I checked today's HeyGen
 * spend" box, and is logged. It is the only supported way to lift the pause.
 */
export async function ResumeRenders() {
  await requireAdmin();
  const { rendersPaused } = await createSpendStore().getSettings();
  if (!rendersPaused) return <p className="text-muted-foreground text-sm">HeyGen work is running (not paused).</p>;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-destructive">HeyGen work is paused. Nothing is sent to HeyGen until you resume.</p>
      <ActionForm
        action={resumeRendersAction}
        label="Resume renders"
        pendingLabel="Resuming…"
        confirmCheck={{
          name: "confirm_checked_spend",
          label: "I checked today's HeyGen spend and it is safe to continue.",
        }}
        variant="outline"
        size="sm"
      />
    </div>
  );
}
