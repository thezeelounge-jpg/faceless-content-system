"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendMagicLink, signInWithGoogle, type LoginState } from "./actions";

export function LoginForm({
  next,
  initialError,
  googleEnabled,
}: {
  next: string;
  initialError?: string;
  googleEnabled: boolean;
}) {
  const initialState: LoginState = initialError
    ? { status: "error", message: initialError }
    : { status: "idle", message: "" };
  const [state, formAction, pending] = useActionState(sendMagicLink, initialState);

  if (state.status === "sent") {
    return (
      <div className="space-y-3 text-center" role="status">
        <p className="text-lg font-medium">Check your email</p>
        <p className="text-muted-foreground text-sm">
          We sent a login link to <span className="font-medium text-foreground">{state.email}</span>.
          Open it on this device. It works once.
        </p>
        <a href="/login" className="text-sm underline underline-offset-4">
          Use a different email
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="next" value={next} />
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
        </div>
        <Button type="submit" className="w-full" size="lg" disabled={pending}>
          {pending ? "Sending…" : "Email me a login link"}
        </Button>
      </form>

      {googleEnabled && (
        <form action={signInWithGoogle}>
          <input type="hidden" name="next" value={next} />
          <Button type="submit" variant="outline" className="w-full" size="lg">
            Continue with Google
          </Button>
        </form>
      )}

      {state.status === "error" && (
        <p role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
      )}
    </div>
  );
}
