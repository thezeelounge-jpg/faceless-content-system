"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { runTestJob, type TestJobState } from "./actions";

const initialState: TestJobState = { status: "idle", message: "" };

export function RunTestJob() {
  const [state, formAction, pending] = useActionState(runTestJob, initialState);
  return (
    <form action={formAction} className="space-y-3">
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Starting…" : "Run test job"}
      </Button>
      {state.status !== "idle" && (
        <p role="status" className={state.status === "ok" ? "text-sm" : "text-destructive text-sm"}>
          {state.message}
        </p>
      )}
    </form>
  );
}
