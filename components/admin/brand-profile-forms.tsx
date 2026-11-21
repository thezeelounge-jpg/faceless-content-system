"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MAX_PILLARS, type ProfileActionState } from "@/lib/brand-versions";

type Pillar = { name: string; description: string };
const idle: ProfileActionState = { status: "idle", message: "" };

function Status({ state }: { state: ProfileActionState }) {
  if (state.status === "idle") return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "text-destructive text-sm" : "text-sm"}>
      {state.message}
    </p>
  );
}

/** The "Write profile" button. Claude writes a new version (free sample text in mock mode). */
export function WriteProfileButton({
  action,
  hasProfile,
}: {
  action: (prev: ProfileActionState) => Promise<ProfileActionState>;
  hasProfile: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, idle);
  return (
    <form action={formAction} className="space-y-2">
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Writing… (up to a minute)" : hasProfile ? "Rewrite profile" : "Write profile"}
      </Button>
      <Status state={state} />
    </form>
  );
}

/** Edit the profile and pillars. Saving creates a new version. */
export function ProfileEditForm({
  action,
  profileMd,
  pillars,
}: {
  action: (prev: ProfileActionState, formData: FormData) => Promise<ProfileActionState>;
  profileMd: string;
  pillars: Pillar[];
}) {
  const [state, formAction, pending] = useActionState(action, idle);
  // After an error, refill with what was typed (React clears the form on submit).
  const values = state.status === "error" && state.values ? state.values : { profile_md: profileMd, pillars };
  return (
    <form key={state.attempt ?? 0} action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="profile_md">Profile (Markdown)</Label>
        <Textarea id="profile_md" name="profile_md" defaultValue={values.profile_md} rows={14} />
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Pillars (4 to 6)</legend>
        {Array.from({ length: MAX_PILLARS }, (_, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[12rem_1fr]">
            <Input
              aria-label={`Pillar ${i + 1} name`}
              name={`pillar_name_${i + 1}`}
              defaultValue={values.pillars[i]?.name}
              placeholder={`Pillar ${i + 1}${i >= 4 ? " (optional)" : ""}`}
            />
            <Input
              aria-label={`Pillar ${i + 1} description`}
              name={`pillar_description_${i + 1}`}
              defaultValue={values.pillars[i]?.description}
              placeholder="What posts in this pillar cover"
            />
          </div>
        ))}
      </fieldset>
      <Status state={state} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save as new version"}
      </Button>
    </form>
  );
}
