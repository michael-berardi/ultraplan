import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// No dependency of the test runner gets a usage signal from this suite.
process.env.DO_NOT_TRACK ??= "1";

// Hermetic: no test (or CLI it spawns) reads or sweeps the real user cache or
// system temp folder. One private scratch root per run, removed on exit.
const scratch = mkdtempSync(path.join(os.tmpdir(), "ultraplan-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const hermetic = {
  ULTRAPLAN_CACHE_DIR: path.join(scratch, "cache"),
  TMPDIR: path.join(scratch, "tmp"),
  TMP: path.join(scratch, "tmp"),
  TEMP: path.join(scratch, "tmp"),
};
for (const [key, value] of Object.entries(hermetic)) process.env[key] = value;
mkdirSync(hermetic.TMPDIR, { recursive: true });

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
      DO_NOT_TRACK: "1",
      ...hermetic,
    },
  },
});
