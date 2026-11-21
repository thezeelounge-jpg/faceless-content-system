"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/plain-error";

const idle: ActionState = { status: "idle", message: "" };

function Status({ state }: { state: ActionState }) {
  if (state.status === "idle") return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "text-destructive text-sm" : "text-sm"}>
      {state.message}
    </p>
  );
}

type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** Add a name: how it's written and how to say it. */
export function AddNameForm({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, idle);
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="new-written">Written</Label>
          <Input id="new-written" name="written" placeholder="Ayesha" required maxLength={80} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-say-as">Say as</Label>
          <Input id="new-say-as" name="say_as" placeholder="aa-ye-sha" required maxLength={120} />
        </div>
      </div>
      <Status state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Add name"}
      </Button>
    </form>
  );
}

/** Edit one row in place. */
export function EditNameForm({ action, written, sayAs }: { action: FormAction; written: string; sayAs: string }) {
  const [state, formAction, pending] = useActionState(action, idle);
  return (
    <form action={formAction} className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Written" name="written" defaultValue={written} required maxLength={80} className="w-40" />
        <Input aria-label="Say as" name="say_as" defaultValue={sayAs} required maxLength={120} className="w-48" />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      <Status state={state} />
    </form>
  );
}
