import { execFile } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALL_LOG_MAX_AGE_MS,
  LOCAL_WRITES,
  ROLLBACK_MAX_AGE_MS,
  STALE_LOCK_MS,
  STAGING_MAX_AGE_MS,
  TEMP_DIR_MAX_AGE_MS,
  TEMP_DIR_PREFIXES,
  retireRollbackCopies,
  sweepInstallArea,
  sweepLocalData,
  sweepPlanStore,
  sweepUpdateFiles,
} from "../src/retention.ts";
import { updatePaths, type InstallPlan } from "../src/update.ts";

/**
 * Local-data retention contract: every path in the inventory has a stated
 * lifetime, the sweep removes only debris and only once it is older than that
 * lifetime, the rollback copies go after the new release's first successful run
 * or after seven days, and the privacy document stays in step with the code.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "bin", "ut-todo");
const run = promisify(execFile);
const tempDirs: string[] = [];

async function tempDir(prefix = "ultraplan-retention-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Create a file (or a directory when `contents` is null) aged `ageMs` in the past. */
async function plant(target: string, contents: string | null = "x", ageMs = 0): Promise<string> {
  if (contents === null) await fs.mkdir(target, { recursive: true, mode: 0o700 });
  else {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, contents, { mode: 0o600 });
  }
  if (ageMs > 1_000) {
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(target, when, when);
  }
  return target;
}

const older = (ms: number) => ms + 60_000;

describe("plan store", () => {
  it("sweeps crash leftovers and a stale lock but never the plan or a live lock", async () => {
    const dir = await tempDir();
    const state = await plant(path.join(dir, "todo.json"), '{"phases":[]}');
    const markdown = await plant(path.join(dir, "TODO.md"), "# TODO\n");
    const oldStage = await plant(path.join(dir, ".todo.json.999.dead.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const newStage = await plant(path.join(dir, ".TODO.md.1000.live.tmp"), "x");
    const staleLock = await plant(path.join(dir, ".lock"), "", older(STALE_LOCK_MS));
    const freshLock = await plant(path.join(dir, ".lock.keep"), "");
    const removed = await sweepPlanStore(dir);
    expect(removed.sort()).toEqual([oldStage, staleLock].sort());
    for (const gone of [oldStage, staleLock]) expect(existsSync(gone)).toBe(false);
    for (const kept of [state, markdown, newStage, freshLock]) expect(existsSync(kept)).toBe(true);
  });

  it("is silent and harmless on a missing or unreadable folder", async () => {
    const dir = await tempDir();
    await expect(sweepPlanStore(path.join(dir, "absent"))).resolves.toEqual([]);
    const locked = path.join(dir, "locked");
    await fs.mkdir(locked, { mode: 0o000 });
    await expect(sweepPlanStore(locked)).resolves.toEqual([]);
    await fs.chmod(locked, 0o700);
  });

  it("leaves a store untouched when the debris is younger than its lifetime", async () => {
    const dir = await tempDir();
    const stage = await plant(path.join(dir, ".todo.json.1.fresh.tmp"));
    const lock = await plant(path.join(dir, ".lock"), "");
    expect(await sweepPlanStore(dir)).toEqual([]);
    expect(existsSync(stage)).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });
});

function updateFixture(dir: string) {
  const cache = path.join(dir, "cache");
  const config = path.join(dir, "config");
  const paths = updatePaths(
    { ULTRAPLAN_CACHE_DIR: cache, ULTRAPLAN_CONFIG_DIR: config } as NodeJS.ProcessEnv,
    "linux",
    path.join(dir, "home"),
  );
  return { cache, config, paths };
}

describe("update cache, claim and log", () => {
  it("removes an old staging file and an expired claim, keeping the cache itself", async () => {
    const dir = await tempDir();
    const { paths } = updateFixture(dir);
    const cacheFile = await plant(paths.cacheFile, '{"checkedAt":1}');
    const oldStage = await plant(path.join(path.dirname(paths.cacheFile), ".update-check.json.9.dead.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const claim = await plant(paths.claimFile, '{"token":"t"}', older(60 * 60 * 1_000));
    const removed = await sweepUpdateFiles(paths);
    expect(removed.sort()).toEqual([oldStage, claim].sort());
    expect(existsSync(cacheFile)).toBe(true);
  });

  it("keeps a fresh claim, a fresh staging file and a recent log", async () => {
    const dir = await tempDir();
    const { paths } = updateFixture(dir);
    const claim = await plant(paths.claimFile, '{"token":"t"}');
    const stage = await plant(path.join(path.dirname(paths.cacheFile), ".update-check.json.2.live.tmp"));
    const log = await plant(path.join(paths.logDir, "update.log"), "install output");
    expect(await sweepUpdateFiles(paths)).toEqual([]);
    for (const kept of [claim, stage, log]) expect(existsSync(kept)).toBe(true);
  });

  it("drops an install log older than its seven-day retention and nothing else", async () => {
    const dir = await tempDir();
    const { paths } = updateFixture(dir);
    const config = await plant(paths.configFile, "{}");
    const log = await plant(path.join(paths.logDir, "update.log"), "old output", older(INSTALL_LOG_MAX_AGE_MS));
    expect(await sweepUpdateFiles(paths)).toEqual([log]);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(config)).toBe(true);
  });
});

describe("installer area", () => {
  const installer = (dir: string): InstallPlan & { appDir: string; wrapper: string } => ({
    kind: "installer",
    appDir: path.join(dir, "app"),
    wrapper: path.join(dir, "bin", "ut-todo"),
  });

  it("removes crashed staging but keeps the live release and the rollback copy", async () => {
    const dir = await tempDir();
    const plan = installer(dir);
    const live = await plant(path.join(plan.appDir, "release-0.5.4", "bin", "ut-todo"), "new");
    const stage = await plant(path.join(plan.appDir, "release-0.5.4.tmp"), null);
    await plant(path.join(stage, "bin", "ut-todo"), "new");
    const aged = new Date(Date.now() - older(STAGING_MAX_AGE_MS));
    await fs.utimes(stage, aged, aged);
    const rollbackStage = await plant(path.join(plan.appDir, "release-0.5.3.rollback.tmp"), "old", older(STAGING_MAX_AGE_MS));
    const windowsStage = await plant(path.join(plan.appDir, ".staging-abc123"), null, older(STAGING_MAX_AGE_MS));
    const rollbackCopy = await plant(path.join(plan.appDir, "release-previous"), null);
    const wrapper = await plant(plan.wrapper, "#!/bin/sh\nexec node \".../release-0.5.4/bin/ut-todo\" \"$@\"\n");
    const wrapperStage = await plant(`${plan.wrapper}.tmp.1234`, "x", older(STAGING_MAX_AGE_MS));
    const removed = await sweepInstallArea(plan, Date.now(), path.join(dir, "tmp"));
    expect(removed.sort()).toEqual([stage, rollbackStage, windowsStage, wrapperStage].sort());
    for (const kept of [live, rollbackCopy, wrapper]) expect(existsSync(kept)).toBe(true);
  });

  it("removes only its own aged folders from the system temp directory", async () => {
    const dir = await tempDir();
    const tmp = path.join(dir, "tmp");
    const updateTmp = await plant(path.join(tmp, "ultraplan-update-abcd"), null, older(TEMP_DIR_MAX_AGE_MS));
    const installTmp = await plant(path.join(tmp, "ultraplan-install.xy12"), null, older(TEMP_DIR_MAX_AGE_MS));
    const fresh = await plant(path.join(tmp, "ultraplan-update-fresh"), null);
    const foreign = await plant(path.join(tmp, "someone-else"), null, older(TEMP_DIR_MAX_AGE_MS));
    const removed = await sweepInstallArea({ kind: "npm" }, Date.now(), tmp);
    expect(removed.sort()).toEqual([updateTmp, installTmp].sort());
    for (const kept of [fresh, foreign]) expect(existsSync(kept)).toBe(true);
  });

  it("touches no user area for an npm, source or manual install", async () => {
    const dir = await tempDir();
    const plan = installer(dir);
    await plant(path.join(plan.appDir, "release-0.5.4.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const removed = await sweepInstallArea({ kind: "npm" }, Date.now(), path.join(dir, "absent-tmp"));
    expect(removed).toEqual([]);
    expect(existsSync(path.join(plan.appDir, "release-0.5.4.tmp"))).toBe(true);
  });
});

describe("rollback copies (contract §4a)", () => {
  async function fixture(dir: string, current: string, backup: string) {
    const appDir = path.join(dir, "app");
    const wrapper = path.join(dir, "bin", "ut-todo");
    const selfPath = await plant(path.join(appDir, `release-${current}`, "bin", "ut-todo"), "new");
    await plant(path.join(appDir, "release-previous", "bin", "ut-todo"), "old");
    await plant(wrapper, `#!/bin/sh\nexec node "${path.join(appDir, `release-${current}`, "bin", "ut-todo")}" "$@"\n`);
    const backupFile = await plant(`${wrapper}.previous`,
      `#!/bin/sh\nexec node "${path.join(appDir, `release-${backup}`, "bin", "ut-todo")}" "$@"\n`);
    return { appDir, wrapper, selfPath, backupFile, previousDir: path.join(appDir, "release-previous") };
  }

  it("retires both copies once the replacing release has run successfully", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, selfPath, backupFile, previousDir } = await fixture(dir, "0.5.4", "0.5.3");
    const state = await retireRollbackCopies({ appDir, wrapper, selfPath });
    expect(state).toEqual({ retirement: "ran-successfully", removed: [backupFile, previousDir] });
    expect(existsSync(backupFile)).toBe(false);
    expect(existsSync(previousDir)).toBe(false);
    expect(existsSync(selfPath)).toBe(true);
  });

  it("keeps them while the old release is still the one running", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, previousDir } = await fixture(dir, "0.5.4", "0.5.3");
    const oldSelf = path.join(previousDir, "bin", "ut-todo");
    expect((await retireRollbackCopies({ appDir, wrapper, selfPath: oldSelf })).retirement).toBe("kept");
    expect((await retireRollbackCopies({ appDir, wrapper })).retirement).toBe("kept");
    expect(existsSync(`${wrapper}.previous`)).toBe(true);
    expect(existsSync(previousDir)).toBe(true);
  });

  it("keeps them until the restored release, not the rollback command, has run", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, selfPath, backupFile, previousDir } = await fixture(dir, "0.5.3", "0.5.3");
    const fromReplacedRelease = await plant(path.join(appDir, "release-0.5.4", "bin", "ut-todo"), "new");
    expect((await retireRollbackCopies({ appDir, wrapper, selfPath: fromReplacedRelease })).retirement)
      .toBe("kept");
    expect((await retireRollbackCopies({ appDir, wrapper })).retirement).toBe("kept");
    expect(existsSync(backupFile)).toBe(true);
    expect(existsSync(previousDir)).toBe(true);

    const state = await retireRollbackCopies({ appDir, wrapper, selfPath });
    expect(state).toEqual({ retirement: "restored", removed: [backupFile, previousDir] });
    expect(existsSync(backupFile)).toBe(false);
    expect(existsSync(previousDir)).toBe(false);
  });

  it("retires them after seven days even with no successful run", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, backupFile, previousDir } = await fixture(dir, "0.5.4", "0.5.3");
    const when = new Date(Date.now() - (ROLLBACK_MAX_AGE_MS + 60_000));
    for (const target of [backupFile, previousDir, wrapper]) await fs.utimes(target, when, when);
    expect((await retireRollbackCopies({ appDir, wrapper })).retirement).toBe("expired");
    expect(existsSync(backupFile)).toBe(false);
    expect(existsSync(previousDir)).toBe(false);
  });

  it("keeps an unattributable copy until it expires", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, backupFile, previousDir } = await fixture(dir, "0.5.4", "0.5.3");
    await fs.writeFile(wrapper, "#!/bin/sh\nexec node \"$HOME/elsewhere/ut-todo\" \"$@\"\n");
    const selfPath = path.join(appDir, "release-0.5.4", "bin", "ut-todo");
    expect((await retireRollbackCopies({ appDir, wrapper, selfPath })).retirement).toBe("kept");
    expect(existsSync(backupFile)).toBe(true);
    expect(existsSync(previousDir)).toBe(true);
    const when = new Date(Date.now() - (ROLLBACK_MAX_AGE_MS + 60_000));
    for (const target of [backupFile, previousDir]) await fs.utimes(target, when, when);
    expect((await retireRollbackCopies({ appDir, wrapper, selfPath })).retirement).toBe("expired");
    expect(existsSync(backupFile)).toBe(false);
    expect(existsSync(previousDir)).toBe(false);
  });

  it("reports an absent rollback instead of inventing work", async () => {
    const dir = await tempDir();
    expect(await retireRollbackCopies({ appDir: path.join(dir, "app"), wrapper: path.join(dir, "bin", "ut-todo") }))
      .toEqual({ retirement: "absent", removed: [] });
  });
});

describe("the whole local-data sweep", () => {
  it("removes every stale entry in an installer-managed layout and is then idempotent", async () => {
    const dir = await tempDir();
    const { paths } = updateFixture(dir);
    const appDir = path.join(dir, "app");
    const wrapper = path.join(dir, "bin", "ut-todo");
    const store = await plant(path.join(dir, "project", ".steak-pi", "todo", "hash", "todo.json"), "{}");
    const storeStage = await plant(path.join(dir, "project", ".steak-pi", "todo", "hash", ".todo.json.7.dead.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const claim = await plant(paths.claimFile, "{}", older(60 * 60 * 1_000));
    const log = await plant(path.join(paths.logDir, "update.log"), "x", older(INSTALL_LOG_MAX_AGE_MS));
    const selfPath = await plant(path.join(appDir, "release-0.5.4", "bin", "ut-todo"), "new");
    await plant(path.join(appDir, "release-previous", "bin", "ut-todo"), "old");
    await plant(wrapper, `#!/bin/sh\nexec node "${path.join(appDir, "release-0.5.4", "bin", "ut-todo")}" "$@"\n`);
    const backup = await plant(`${wrapper}.previous`, `#!/bin/sh\nexec node "${path.join(appDir, "release-0.5.3", "bin", "ut-todo")}" "$@"\n`);
    const tmp = await plant(path.join(dir, "tmp", "ultraplan-update-dead"), null, older(TEMP_DIR_MAX_AGE_MS));
    const plan: InstallPlan = { kind: "installer", appDir, wrapper };
    const report = await sweepLocalData({ storeDir: path.dirname(store), selfPath, paths, plan, tmpDir: tmp ? path.dirname(tmp) : dir });
    expect(report.rollback).toBe("ran-successfully");
    for (const gone of [storeStage, claim, log, backup, path.join(appDir, "release-previous"), tmp]) {
      expect(existsSync(gone)).toBe(false);
    }
    expect(existsSync(store)).toBe(true);
    const again = await sweepLocalData({ storeDir: path.dirname(store), selfPath, paths, plan, tmpDir: path.dirname(tmp) });
    expect(again.removed).toEqual([]);
    expect(again.rollback).toBe("absent");
  });

  it("does nothing at all when ULTRAPLAN_NO_LOCAL_CLEANUP=1", async () => {
    const dir = await tempDir();
    const store = await plant(path.join(dir, "store", ".todo.json.9.dead.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const report = await sweepLocalData({
      storeDir: path.dirname(store),
      env: { ULTRAPLAN_NO_LOCAL_CLEANUP: "1" } as NodeJS.ProcessEnv,
    });
    expect(report).toEqual({ removed: [] });
    expect(existsSync(store)).toBe(true);
  });

  it("never throws on paths that do not exist", async () => {
    const dir = await tempDir();
    const { paths } = updateFixture(dir);
    await expect(sweepLocalData({
      storeDir: path.join(dir, "absent-store"),
      selfPath: path.join(dir, "absent", "bin", "ut-todo"),
      paths,
      plan: { kind: "installer", appDir: path.join(dir, "absent-app"), wrapper: path.join(dir, "absent", "ut-todo") },
      tmpDir: path.join(dir, "absent-tmp"),
    })).resolves.toEqual({ removed: [], rollback: "absent" });
  });
});

describe("the running command triggers the sweep, without changing its result", () => {
  async function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
    const clean = { ...process.env } as Record<string, string | undefined>;
    delete clean.CLAUDE_CODE_SESSION_ID;
    delete clean.UT_TODO_SESSION;
    return run(process.execPath, [BIN, ...args], { cwd, env: { ...clean, ...env }, encoding: "utf8", timeout: 30_000 });
  }

  it("clears stale local debris after a successful command and leaves the plan alone", async () => {
    const cwd = await tempDir("ultraplan-retention-cli-");
    const cache = path.join(cwd, "cache");
    const config = path.join(cwd, "config");
    const env = { ULTRAPLAN_CACHE_DIR: cache, ULTRAPLAN_CONFIG_DIR: config };
    const init = await cli(cwd, ["init", "Inspect:read,ship"], env);
    expect(init.stderr).toBe("");
    const todoRoot = path.join(cwd, ".steak-pi", "todo");
    const store = path.join(todoRoot, (await fs.readdir(todoRoot))[0]);

    const storeStage = await plant(path.join(store, ".TODO.md.4242.crashed.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const claim = await plant(path.join(cache, "update-check.claim"), '{"token":"stale"}', older(60 * 60 * 1_000));
    const cacheStage = await plant(path.join(cache, ".update-check.json.11.crashed.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const cacheFile = await plant(path.join(cache, "update-check.json"), '{"checkedAt":1}');

    const done = await cli(cwd, ["done", "read"], env);
    expect(done.stderr).toBe("");
    expect(done.stdout).toContain("Overall: 1/2 done.");
    for (const gone of [storeStage, claim, cacheStage]) expect(existsSync(gone)).toBe(false);
    expect(existsSync(cacheFile)).toBe(true);
    expect((await fs.readdir(store)).sort()).toEqual(["TODO.md", "todo.json"]);
    expect(JSON.parse(await fs.readFile(path.join(store, "todo.json"), "utf8")).phases[0].items[0].status).toBe("done");
  });

  it("keeps the debris when the cleanup opt-out is set", async () => {
    const cwd = await tempDir("ultraplan-retention-cli-");
    const env = {
      ULTRAPLAN_CACHE_DIR: path.join(cwd, "cache"),
      ULTRAPLAN_CONFIG_DIR: path.join(cwd, "config"),
      ULTRAPLAN_NO_LOCAL_CLEANUP: "1",
    };
    await cli(cwd, ["init", "Inspect:read"], env);
    const todoRoot = path.join(cwd, ".steak-pi", "todo");
    const store = path.join(todoRoot, (await fs.readdir(todoRoot))[0]);
    const stage = await plant(path.join(store, ".TODO.md.4343.crashed.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const done = await cli(cwd, ["done", "read"], env);
    expect(done.stdout).toContain("Overall: 1/1 done.");
    expect(existsSync(stage)).toBe(true);
  });
});

describe("the privacy document matches the code", () => {
  const privacy = readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");

  it("documents every path the inventory names", () => {
    const paths = LOCAL_WRITES.flatMap((entry) => entry.paths);
    expect(paths.length).toBeGreaterThanOrEqual(14);
    expect(paths).toContain("<bin>/ut-todo.tmp.*");
    expect(paths.filter((entry) => !privacy.includes(entry))).toEqual([]);
  });

  it("defines its path roots without repeating ultraplan inside them", () => {
    for (const root of ["<cache>", "<config>", "<app>", "<bin>", "<tmp>"]) {
      expect(privacy).toContain(`\`${root}\` is`);
    }
    expect(privacy).toContain("<cache>/update-check.json");
    expect(privacy).toContain("<config>/config.json");
    expect(privacy).not.toContain("<cache>/ultraplan/");
    expect(privacy).not.toContain("<config>/ultraplan/");
  });

  it("names only the two temp prefixes the sweep uses", () => {
    expect(TEMP_DIR_PREFIXES).toEqual(["ultraplan-update-", "ultraplan-install."]);
    expect(privacy).toContain("<tmp>/ultraplan-update-*");
    expect(privacy).toContain("<tmp>/ultraplan-install.*");
    expect(privacy).not.toMatch(/`ultraplan-\*` folders/);
    const updates = readFileSync(path.join(ROOT, "docs", "updates.md"), "utf8");
    expect(updates).toContain("<tmp>/ultraplan-update-*");
    expect(updates).toContain("<tmp>/ultraplan-install.*");
    expect(updates).not.toMatch(/`ultraplan-\*` folders/);
  });

  it("states the claim's age and its overlap with an in-flight reclaim", () => {
    expect(privacy).toContain("14 s old");
    expect(privacy).toMatch(/overlaps a check reclaiming/);
    const updates = readFileSync(path.join(ROOT, "docs", "updates.md"), "utf8");
    expect(updates).toContain("14 s");
    expect(updates).toMatch(/overlaps a reclaim/);
  });

  it("gives every inventory row a lifetime and a cleanup owner", () => {
    for (const entry of LOCAL_WRITES) {
      expect(entry.paths.length).toBeGreaterThan(0);
      expect(entry.contents.trim(), entry.paths[0]).not.toBe("");
      expect(entry.lifetime, entry.paths[0]).not.toBe("");
      expect(entry.cleanup, entry.paths[0]).not.toBe("");
    }
  });

  it("keeps the README Privacy section short and pointed at PRIVACY.md", () => {
    const section = readme.slice(readme.indexOf("## Privacy\n"), readme.indexOf("## Development\n"));
    const lines = section.split("\n").slice(1).filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(section).not.toContain("0700/0600");
    expect(section).not.toContain(".steak-pi/todo/");
    expect(section).toMatch(/[Dd]elete local data/);
    expect(section).toMatch(/remove\s+your plans, cache and config/);
    expect(section).toContain("[PRIVACY.md](PRIVACY.md)");
    expect(section).toContain("[docs/updates.md](docs/updates.md)");
    expect(privacy).toContain("ULTRAPLAN_NO_LOCAL_CLEANUP=1");
    expect(privacy).toMatch(/(?:seven|7) days/);
  });

  it("requires the restored release itself, not just the rollback command, before deleting copies", () => {
    expect(privacy).toMatch(/this process is now\s+running from that restored release/);
    const updates = readFileSync(path.join(ROOT, "docs", "updates.md"), "utf8");
    expect(updates).toMatch(/this process\s+is now running from that restored release/);
  });

  it("records the automatic rollback cleanup in the update contract", () => {
    const updates = readFileSync(path.join(ROOT, "docs", "updates.md"), "utf8");
    expect(updates).not.toMatch(/does \*\*not\*\* implement\s+that cleanup/);
    expect(updates).toMatch(/run successfully once/);
    expect(updates).toMatch(/(?:seven|7) days/);
    expect(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).files).toContain("PRIVACY.md");
  });
});
