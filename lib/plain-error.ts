/** What a simple admin button action sends back to its form. */
export type ActionState = { status: "idle" | "ok" | "error"; message: string };

/**
 * An error whose message we wrote ourselves in plain words, so it is safe to
 * show to an admin. Database and library errors are never PlainErrors.
 */
export class PlainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlainError";
  }
}
