import type { ConsentRow } from "@/lib/consent-store-types";

// Decision 2: one plain line for the admin consent page about the background
// clip check (trigger/check-clip.ts). The page does not poll; the admin refreshes.

export function clipCheckStatusLine(consent: Pick<ConsentRow, "clip_check_status" | "clip_check_error">): string {
  switch (consent.clip_check_status) {
    case "pending":
      return "Waiting to start. Refresh in a minute.";
    case "running":
      return "Running now (about a minute). Refresh to see the results.";
    case "done":
      return "Done.";
    case "failed":
      return consent.clip_check_error
        ? `Could not finish: ${consent.clip_check_error}`
        : "Could not finish. Press “Run checks” to try again.";
    default:
      return "Not run yet.";
  }
}
