import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000, // PGlite boots a WASM Postgres per suite
    // Same reason: the boot happens in beforeEach, and 10s (the default) is not
    // enough for it on a cold or loaded machine.
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
});
