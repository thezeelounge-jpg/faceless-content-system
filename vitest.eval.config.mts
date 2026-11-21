// `npm run eval:scripts`: the golden-set prompt regression (docs/QA-SPEC.md).
// Kept apart from `npm test`: this config only picks up tests/golden/*.eval.ts,
// and the normal config only picks up *.test.ts.
//
// MOCK by default. It calls the real Claude API (costs a few cents) only when
// MOCK_CLAUDE is exactly "false" — the same switch as the app (lib/config.ts).
// Ask the owner before running it live.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Same settings as the app: .env.local (git-ignored) when it exists; the shell wins.
const envFile = new URL("./.env.local", import.meta.url);
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
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
    include: ["tests/golden/**/*.eval.ts"],
    env,
    testTimeout: 30 * 60_000,
  },
});
