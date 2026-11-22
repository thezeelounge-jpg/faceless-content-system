// `npm run p4:artifacts`: writes the Phase 4 before/after files from the
// fixture video into ../logs/p4-artifacts/ (scripts/p4-artifacts.ts).
// Run by hand only; never part of `npm test` (that config only picks up
// tests/**/*.test.ts). Local ffmpeg + the mock transcript only: it reads no
// .env file and keeps the same no-network guard as the tests.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["scripts/p4-artifacts.ts"],
    setupFiles: ["tests/setup/no-network.ts"],
    testTimeout: 5 * 60_000,
  },
});
