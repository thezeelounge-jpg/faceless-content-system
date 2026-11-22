import { afterEach, beforeEach, expect } from "vitest";
import {
  disabledFetch,
  installSocketGuard,
  networkAllowed,
  realFetchForGuardTests,
  setNetworkBlocked,
} from "./network-guard";

// Loaded before every test file (vitest.config.mts setupFiles; also
// vitest.staging.config.mts, and vitest.eval.config.mts unless both live
// switches are on). Two layers:
//
// 1. globalThis.fetch: before each test it becomes a function that throws
//    "network disabled in tests: <url>"; after each test it is put back to
//    that same thrower (never the real fetch), so a passthrough spy or
//    vi.restoreAllMocks() can't reach HeyGen, Anthropic or Supabase.
// 2. Sockets (SF1): net.Socket.prototype.connect, net.connect /
//    createConnection, tls.connect, http(s).request / get all throw
//    "network disabled in tests: <host>". That covers node:http, node:https,
//    net, tls and undici (Node's real fetch), whatever a library uses.
//    PGlite is in-process and needs no socket.
// 3. DNS (p4-fix a): node:dns lookup / lookupService / resolve* / reverse,
//    dns.promises (= node:dns/promises) and every dns.Resolver /
//    dns.promises.Resolver instance fail with the same message. Only
//    `lookup` of a literal IP passes (no query; local stubs need it).
//
// Tests that need an answer inject a fake (createHeygenClient({ fetch }) etc.).
// Exception: tests/staging/*, only when RUN_STAGING_TESTS=1 (opt-in, never in npm test).

installSocketGuard();
const realFetch = realFetchForGuardTests();

function install() {
  const allowed = networkAllowed({ env: process.env, testPath: expect.getState().testPath });
  globalThis.fetch = allowed ? realFetch : disabledFetch;
  setNetworkBlocked(!allowed);
}

install();
beforeEach(install);
afterEach(install);
