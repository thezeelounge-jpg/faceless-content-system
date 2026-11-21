import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

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
    include: ["tests/**/*.test.ts"],
    // Opt-in tests against real staging: only `npm run test:staging` (vitest.staging.config.mts).
    exclude: [...configDefaults.exclude, "tests/staging/**"],
    // SF5: every test runs with globalThis.fetch replaced by a thrower.
    setupFiles: ["tests/setup/no-network.ts"],
    testTimeout: 30_000,
  },
});
