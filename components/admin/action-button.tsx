"use client";

import { useActionState } from "react";
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
  return (
    <form action={formAction} className="space-y-1">
      <Button type="submit" variant={variant} size={size} disabled={pending}>
        {pending ? pendingLabel : label}
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
