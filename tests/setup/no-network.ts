import { afterEach, beforeEach, expect } from "vitest";
import { disabledFetch, networkAllowed } from "./network-guard";

// Loaded before every test file (vitest.config.mts setupFiles). Before each
// test, globalThis.fetch becomes a function that throws
// "network disabled in tests: <url>"; after each test it is put back to that
// same thrower (never the real fetch), so a passthrough spy or
// vi.restoreAllMocks() can't reach HeyGen, Anthropic or Supabase.
// Tests that need an answer inject a fake (createHeygenClient({ fetch }) etc.).
//
// Clients that could reach the network from tests, and why they can't:
// - lib/heygen.ts: calls globalThis.fetch at request time → the thrower.
// - Anthropic SDK (lib/claude.ts): mock mode builds no client; a real client
//   uses globalThis.fetch → the thrower.
// - supabase-js: tests never build it (memory stores + vi.mock of the store
//   modules); if one did, it uses globalThis.fetch → the thrower.
// Exception: tests/staging/*, only when RUN_STAGING_TESTS=1 (opt-in, never in npm test).

const realFetch = globalThis.fetch;

function install() {
  const allowed = networkAllowed({ env: process.env, testPath: expect.getState().testPath });
  globalThis.fetch = allowed ? realFetch : disabledFetch;
}

beforeEach(install);
afterEach(install);
