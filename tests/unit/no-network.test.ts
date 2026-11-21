import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { networkAllowed } from "@/tests/setup/network-guard";

// SF5: no test can ever reach the network. tests/setup/no-network.ts swaps
// globalThis.fetch for a thrower before every test (vitest.config.mts
// setupFiles). These tests prove the thrower is on by default, and that a
// passthrough spy or vi.restoreAllMocks() can't bring the real fetch back.

afterEach(() => vi.restoreAllMocks());

describe("network is disabled in tests", () => {
  it("globalThis.fetch rejects with 'network disabled in tests' and names the URL", async () => {
    await expect(globalThis.fetch("https://api.heygen.com/v3/users/me")).rejects.toThrow(
      "network disabled in tests: https://api.heygen.com/v3/users/me",
    );
  });

  it("a spy without a mock passes through to the thrower, not to the real fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow("network disabled in tests");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("after vi.restoreAllMocks() fetch is still the thrower", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fake"));
    vi.restoreAllMocks();
    await expect(fetch(new URL("https://example.supabase.co/rest/v1/brands"))).rejects.toThrow(
      "network disabled in tests: https://example.supabase.co/rest/v1/brands",
    );
  });
});

describe("only the opt-in staging tests may use the network", () => {
  const staging = path.resolve("tests/staging/consent-store.staging.test.ts");
  const unit = path.resolve("tests/unit/heygen.test.ts");

  it("is off by default, even for the staging file", () => {
    expect(networkAllowed({ env: {}, testPath: staging })).toBe(false);
    expect(networkAllowed({ env: { RUN_STAGING_TESTS: "true" }, testPath: staging })).toBe(false);
    expect(networkAllowed({ env: { RUN_STAGING_TESTS: "1" }, testPath: unit })).toBe(false);
    expect(networkAllowed({ env: { RUN_STAGING_TESTS: "1" }, testPath: undefined })).toBe(false);
    expect(networkAllowed({ env: { RUN_STAGING_TESTS: "1" }, testPath: path.resolve("tests/staging/../unit/x.test.ts") })).toBe(false);
  });

  it("is on only with RUN_STAGING_TESTS=1 AND a file under tests/staging", () => {
    expect(networkAllowed({ env: { RUN_STAGING_TESTS: "1" }, testPath: staging })).toBe(true);
  });

  it("this test file runs with the thrower on (RUN_STAGING_TESTS is not set here)", () => {
    expect(process.env.RUN_STAGING_TESTS).toBeUndefined();
    expect(networkAllowed({ env: process.env, testPath: expect.getState().testPath })).toBe(false);
  });
});
