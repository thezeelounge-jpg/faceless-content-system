"use client";

import { useActionState } from "react";
import { actionButtonView } from "@/components/admin/action-button-view";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/plain-error";

const idle: ActionState = { status: "idle", message: "" };

/** One button that runs a Server Action and shows its one-sentence result. */
export function ActionButton({
  action,
  label,
  pendingLabel,
  variant = "default",
  size = "default",
}: {
  action: (prev: ActionState) => Promise<ActionState>;
  label: string;
  pendingLabel: string;
  variant?: "default" | "outline";
  size?: "default" | "sm" | "lg";
}) {
  const [state, formAction, pending] = useActionState(action, idle);
  const view = actionButtonView(pending, label, pendingLabel);
  return (
    <form action={formAction} className="space-y-1" aria-busy={view.busy}>
      <Button type="submit" variant={variant} size={size} disabled={view.disabled}>
        {view.text}
      </Button>
      {state.status !== "idle" && (
        <p
          role={state.status === "error" ? "alert" : "status"}
          className={state.status === "error" ? "text-destructive text-sm" : "text-sm"}
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
