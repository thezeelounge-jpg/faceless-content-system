// QA-SPEC "Security": no secret key strings in the browser bundle.
//
// Order: `npm run build` first, then `npm run test:bundle` (fails if there is
// no build output). Plain `npm test` also scans .next/static whenever it
// exists, so a stale or fresh build with a secret in it fails every test run.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSecrets, scanDirectory, secretEnvValues } from "./bundle-scan";

const STATIC_DIR = path.resolve(process.cwd(), ".next/static");
const hasBuild = existsSync(STATIC_DIR);
// npm sets npm_lifecycle_event to the script name (works on Windows too).
const buildRequired = process.env.npm_lifecycle_event === "test:bundle";

// Fake secrets are assembled at run time, so no secret-looking string sits in the repo.
const fakeJwt = (role: string) =>
  [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
    Buffer.from(JSON.stringify({ iss: "supabase", role })).toString("base64url"),
    "c2lnbmF0dXJlLXNpZ25hdHVyZQ",
  ].join(".");

describe("the secret scanner", () => {
  it("finds key patterns and secret env names, and says only which pattern matched", () => {
    const text = [
      `const a="${"sk-" + "ant-"}api03-${"x".repeat(20)}";`,
      `const b="${"sb_" + "secret_"}${"y".repeat(20)}";`,
      `const c="${fakeJwt("service_role")}";`,
      `const d=process.env.${"ANTHROPIC_" + "API_KEY"};`,
    ].join("\n");
    const found = findSecrets(text);
    expect(found).toEqual([
      "anthropic key (sk-ant-)",
      "secret env name ANTHROPIC_API_KEY",
      "supabase secret key (sb_secret_)",
      "supabase service_role JWT",
    ]);
    for (const name of found) expect(name).not.toMatch(/x{5}|y{5}|eyJ/);
  });

  it("allows public things: the anon JWT and NEXT_PUBLIC names", () => {
    const text = `const k="${fakeJwt("anon")}"; const u=process.env.NEXT_PUBLIC_SUPABASE_URL;`;
    expect(findSecrets(text)).toEqual([]);
  });

  it("scans a folder and reports the file name and pattern name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-scan-"));
    try {
      mkdirSync(path.join(dir, "chunks"));
      writeFileSync(path.join(dir, "chunks", "bad.js"), `var k="${"sk-" + "ant-"}${"a".repeat(24)}";`);
      writeFileSync(path.join(dir, "chunks", "ok.js"), `var ok="${fakeJwt("anon")}";`);
      expect(scanDirectory(dir)).toEqual([{ file: path.join("chunks", "bad.js"), pattern: "anthropic key (sk-ant-)" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches a real secret value from this machine's env without returning it", () => {
    const value = "local-" + "secret-value-123";
    const found = findSecrets(`var z="${value}"`, { SUPABASE_SECRET_KEY: value });
    expect(found).toEqual(["value of SUPABASE_SECRET_KEY"]);
    expect(found.join(" ")).not.toContain(value);
  });
});

describe("the built browser bundle (.next/static)", () => {
  it.runIf(buildRequired && !hasBuild)("needs a build first", () => {
    expect.fail("No .next/static found. Run `npm run build`, then `npm run test:bundle`.");
  });

  it.skipIf(!hasBuild)("has no secrets (file and pattern names only)", () => {
    const findings = scanDirectory(STATIC_DIR, secretEnvValues());
    expect(findings, findings.map((f) => `${f.file}: ${f.pattern}`).join("\n")).toEqual([]);
  });

  if (!hasBuild && !buildRequired) {
    console.warn("[bundle scan] skipped: no .next/static yet. Run `npm run build`, then `npm run test:bundle`.");
  }
});
