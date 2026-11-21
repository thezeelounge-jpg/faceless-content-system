// `npm run test:staging`: OPT-IN tests against the real STAGING Supabase
// (tests/staging/*.staging.test.ts). Never part of `npm test` (the default
// config excludes tests/staging). Each staging file also skips itself unless
// RUN_STAGING_TESTS=1, and only then does tests/setup/no-network.ts let it
// use the network. Rowan runs it after pushing the migrations to staging:
//   RUN_STAGING_TESTS=1 STAGING_BRAND_ID=<a test brand id> npm run test:staging
// Keys come from .env.local (git-ignored) at run time and are never printed.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Same settings as the app: .env.local when it exists; the shell wins.
// Read ONLY on an opted-in run, so importing this file (tests/unit/staging-opt-in.test.ts) reads nothing.
const optedIn = process.env.RUN_STAGING_TESTS === "1";
const envFile = new URL("./.env.local", import.meta.url);
const fileEnv = optedIn && existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
const env = Object.fromEntries(
  Object.entries({ ...fileEnv, ...process.env }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/staging/**/*.staging.test.ts"],
    setupFiles: ["tests/setup/no-network.ts"],
    env,
    testTimeout: 60_000,
  },
});
