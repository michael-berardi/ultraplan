import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Root is pinned to this package so the suite runs identically from the
// monorepo root (`vitest run --config packages/ultraplan/vitest.config.ts`)
// and from inside the extracted standalone repository.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
    // The CLI tests spawn real node processes; 5 s is too tight on a loaded machine.
    testTimeout: 30_000,
    env: {
      // Keep unit tests hermetic: no cross-process slot files, default caps.
      STEAK_PI_USAP_MACHINE: "off",
    },
  },
});
