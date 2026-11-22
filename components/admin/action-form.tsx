"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/plain-error";

const idle: ActionState = { status: "idle", message: "" };

/**
 * One button that runs a Server Action with a few hidden fields and, for
 * paid HeyGen work, an "I agree to spend" box (confirm_spend = "yes"; the
 * Server Action checks it with zod and the lib function refuses without it).
 */
export function ActionForm({
  action,
  label,
  pendingLabel,
  hidden = {},
  confirmSpend = false,
  confirmCheck,
  textField,
  variant = "default",
  size = "default",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  label: string;
  pendingLabel: string;
  hidden?: Record<string, string>;
  confirmSpend?: boolean;
  /** Another required "I checked…" box (value "yes"); the Server Action checks it again. */
  confirmCheck?: { name: string; label: string };
  /** One required short text box (e.g. a reason); the Server Action checks it again with zod. */
  textField?: { name: string; label: string; minLength: number; maxLength: number };
  variant?: "default" | "outline";
  size?: "default" | "sm" | "lg";
}) {
  const [state, formAction, pending] = useActionState(action, idle);
  return (
    <form action={formAction} className="space-y-2" aria-busy={pending}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {textField && (
        <label className="block space-y-1 text-sm">
          <span>{textField.label}</span>
          <input
            type="text"
            name={textField.name}
            required
            minLength={textField.minLength}
            maxLength={textField.maxLength}
            className="border-input block w-full rounded-md border px-2 py-1"
          />
        </label>
      )}
      {confirmSpend && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirm_spend" value="yes" required className="mt-1" />
          <span>I agree to spend money: this sends real renders to HeyGen.</span>
        </label>
      )}
      {confirmCheck && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name={confirmCheck.name} value="yes" required className="mt-1" />
          <span>{confirmCheck.label}</span>
        </label>
      )}
      <Button type="submit" variant={variant} size={size} disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      {state.status !== "idle" && (
        <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "text-destructive text-sm" : "text-sm"}>
          {state.message}
        </p>
      )}
    </form>
  );
}
