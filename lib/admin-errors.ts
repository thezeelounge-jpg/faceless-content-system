import "server-only";
import { ClaudeError } from "@/lib/claude";
import { PlainError } from "@/lib/plain-error";

// Admin actions show one plain sentence. The technical details (database
// messages, stack traces) go only to the server log, with enough context to
// find the row. Never log keys or tokens here.

/**
 * The sentence an admin sees. PlainError messages (ClaudeError, PlanError,
 * ...) are our own plain words, so they are safe to show; anything else
 * gets the generic `fallback`.
 */
export function plainAdminMessage(error: unknown, fallback: string): string {
  return error instanceof PlainError ? error.message : fallback;
}

/** Logs the details of a failed admin action on the server. */
export function logAdminError(label: string, context: Record<string, unknown>, error: unknown): void {
  console.error(label, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof ClaudeError ? error.code : undefined,
  });
}
