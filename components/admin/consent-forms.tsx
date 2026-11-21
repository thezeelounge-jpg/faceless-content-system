"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionState } from "@/lib/plain-error";

const idle: ActionState = { status: "idle", message: "" };

function Message({ state }: { state: ActionState }) {
  if (state.status === "idle" && !state.message) return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "text-destructive text-sm" : "text-sm"}>
      {state.message}
    </p>
  );
}

/** Legal name + consent checkbox. The server picks the 3 words. */
export function StartConsentForm({ action }: { action: (prev: ActionState, formData: FormData) => Promise<ActionState> }) {
  const [state, formAction, pending] = useActionState(action, idle);
  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="legal_name">Full legal name of the person in the clip</Label>
        <Input id="legal_name" name="legal_name" required minLength={3} maxLength={120} autoComplete="off" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="client_email">Client&apos;s own email (HeyGen&apos;s consent link goes here; optional)</Label>
        <Input id="client_email" name="client_email" type="email" maxLength={254} autoComplete="off" />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="agree" required className="mt-1" />
        <span>
          This person agrees that we create a digital twin (a realistic AI copy of their face and voice) with HeyGen and use it
          only for their own videos.
        </span>
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Starting…" : "Get the 3 words"}
      </Button>
      <Message state={state} />
    </form>
  );
}

/** Approve or Reject with a note. */
export function NoteForm({
  action,
  label,
  pendingLabel,
  noteRequired,
  variant = "default",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  label: string;
  pendingLabel: string;
  noteRequired: boolean;
  variant?: "default" | "outline";
}) {
  const [state, formAction, pending] = useActionState(action, idle);
  return (
    <form action={formAction} className="space-y-2" aria-busy={pending}>
      <Textarea
        name="note"
        maxLength={500}
        required={noteRequired}
        placeholder={noteRequired ? "Why? (required)" : "Note (optional)"}
        aria-label={`${label} note`}
      />
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      <Message state={state} />
    </form>
  );
}
