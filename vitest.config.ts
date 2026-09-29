import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/testing/sandbox.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/testing/**",
        // bun:sqlite does not exist under Node; `pnpm smoke:bun` runs this driver instead.
        "src/store/drivers/bun-sqlite.ts",
        // Declarations whose callbacks drizzle-kit runs, in its own process; the baseline test checks its output.
        "src/store/sqlite/schema.ts",
      ],
      reporter: ["text-summary", "json-summary", "html"],
      // A little under what the suite reaches (2026-09-29), so coverage can rise and not fall.
      thresholds: {
        lines: 92,
        statements: 90,
        functions: 89,
        branches: 77,
        perFile: { lines: 50 },
      },
    },
  },
})
