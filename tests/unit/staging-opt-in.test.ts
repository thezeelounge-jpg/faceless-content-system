import { describe, expect, it } from "vitest";

// The .mts config files are loaded at run time (TypeScript won't import .mts paths).
type TestConfig = { test?: { include?: string[]; exclude?: string[]; setupFiles?: string | string[]; env?: Record<string, string> } };
const load = async (file: string) =>
  ((await import(/* @vite-ignore */ new URL(`../../${file}`, import.meta.url).href)) as { default: TestConfig }).default;
const defaultConfig = await load("vitest.config.mts");
const stagingConfig = await load("vitest.staging.config.mts");

// The staging tests talk to the real staging Supabase, so they must never run
// in `npm test`: the default config excludes tests/staging, the staging config
// is separate, and the file itself skips unless RUN_STAGING_TESTS=1.

describe("staging tests are opt-in only", () => {
  it("npm test (vitest.config.mts) excludes tests/staging and keeps the network thrower", () => {
    expect(defaultConfig.test?.exclude).toContain("tests/staging/**");
    expect(defaultConfig.test?.setupFiles).toEqual(["tests/setup/no-network.ts"]);
  });

  it("the staging config runs only tests/staging, with the same setup (thrower off only for RUN_STAGING_TESTS=1)", () => {
    expect(stagingConfig.test?.include).toEqual(["tests/staging/**/*.staging.test.ts"]);
    expect(stagingConfig.test?.setupFiles).toEqual(["tests/setup/no-network.ts"]);
  });

  it("without the flag the staging config loads no .env.local values (only the shell's env)", () => {
    expect(process.env.RUN_STAGING_TESTS).toBeUndefined();
    const keys = Object.keys(stagingConfig.test?.env ?? {}).sort();
    expect(keys).toEqual(Object.keys(process.env).filter((k) => typeof process.env[k] === "string").sort());
  });
});
