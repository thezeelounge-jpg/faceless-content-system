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

/** Logs the details of a failed admin action on the server, with its cause chain. */
export function logAdminError(label: string, context: Record<string, unknown>, error: unknown): void {
  console.error(label, {
    ...context,
    error: redact(error instanceof Error ? error.message : String(error)),
    code: error instanceof ClaudeError ? error.code : undefined,
    causes: causeChain(error),
  });
}

/** How many causes deep we look (also stops cycles). */
const MAX_CAUSES = 5;

type CauseSummary = { name: string; message: string; status?: number; type?: string; code?: string };

/**
 * The error's causes, oldest wrapper first. Only an allow-list of fields:
 * name, message (redacted), HTTP status, API error type and code. Never
 * headers, request bodies or anything else on the error object.
 */
function causeChain(error: unknown): CauseSummary[] {
  const causes: CauseSummary[] = [];
  const seen = new Set<unknown>([error]);
  let current = (error as { cause?: unknown } | null)?.cause;
  while (current !== undefined && current !== null && !seen.has(current) && causes.length < MAX_CAUSES) {
    seen.add(current);
    causes.push(summarise(current));
    current = (current as { cause?: unknown }).cause;
  }
  return causes;
}

function summarise(cause: unknown): CauseSummary {
  if (!(cause instanceof Error)) return { name: typeof cause, message: redact(String(cause)).slice(0, 300) };
  const fields = cause as Error & { status?: unknown; code?: unknown; type?: unknown; error?: unknown };
  // Anthropic SDK errors carry the parsed body as error.error ({ type: "error", error: { type } }).
  const body = fields.error as { type?: unknown; error?: { type?: unknown } } | undefined;
  const type = body?.error?.type ?? body?.type ?? fields.type;
  // Every text field goes through redact(): name, type and code are usually
  // fixed words, but nothing stops a library from putting a key in them.
  const summary: CauseSummary = { name: redact(cause.name).slice(0, 100), message: redact(cause.message).slice(0, 300) };
  if (typeof fields.status === "number") summary.status = fields.status;
  if (typeof type === "string") summary.type = redact(type).slice(0, 100);
  if (typeof fields.code === "string" || typeof fields.code === "number") summary.code = redact(String(fields.code)).slice(0, 100);
  return summary;
}

/** Key-like strings: Anthropic/Stripe-style keys, Supabase secret keys, JWTs, Bearer tokens, long random runs. */
const SECRET_LIKE = [
  /\bsk[-_][A-Za-z0-9_-]{8,}/g,
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]+/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+\S+/gi,
  /[A-Za-z0-9_-]{32,}/g,
];

/** Replaces anything that looks like a key or token with [redacted]. */
export function redact(text: string): string {
  return SECRET_LIKE.reduce((out, pattern) => out.replace(pattern, "[redacted]"), text);
}
