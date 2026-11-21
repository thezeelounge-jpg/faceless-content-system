import path from "node:path";

// Decides whether a test file may use the real network. Only the opt-in
// staging tests may, and only when Rowan sets RUN_STAGING_TESTS=1 on purpose.
// Everything else (all of `npm test`) gets the thrower.

const STAGING_DIR = path.resolve("tests/staging") + path.sep;

export function networkAllowed(opts: { env: Record<string, string | undefined>; testPath: string | undefined }): boolean {
  if (opts.env.RUN_STAGING_TESTS !== "1" || !opts.testPath) return false;
  return path.resolve(opts.testPath).startsWith(STAGING_DIR);
}

/** The fetch every test gets: it never touches the network. */
export const disabledFetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`network disabled in tests: ${url}`);
}) as typeof fetch;
