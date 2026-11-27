import { execFile } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECK_CLAIM_MAX_MS,
  INSTALL_LOG_MAX_AGE_MS,
  INSTALL_LOCK_MAX_MS,
  LOCAL_WRITES,
  ROLLBACK_MAX_AGE_MS,
  STALE_LOCK_MS,
  STAGING_MAX_AGE_MS,
  TEMP_DIR_MAX_AGE_MS,
  TEMP_DIR_PREFIXES,
  localPaths,
  retireRollbackCopies,
  sweepInstallArea,
  sweepLocalData,
  sweepPlanStore,
  sweepUpdateFiles,
} from "../src/retention.ts";
import type { InstallPlan } from "../src/retention.ts";
import * as updates from "../src/update.js";

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
  const paths = localPaths(cache);
  return { cache, config, paths };
}

describe("update cache, claim and log", () => {
  it("removes an old staging file and an expired claim, keeping the cache itself", async () => {
    const dir = await tempDir();
    const { paths } = updateFixture(dir);
    const cacheFile = await plant(paths.stateFile, '{"checkedAt":1}');
    const oldStage = await plant(path.join(path.dirname(paths.stateFile), "update.json.9.dead.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const claim = await plant(paths.claimFile, '{"token":"t"}', older(60 * 60 * 1_000));
    const removed = await sweepUpdateFiles(paths);
    expect(removed.sort()).toEqual([oldStage, claim].sort());
    expect(existsSync(cacheFile)).toBe(true);
  });

  it("does not sweep unrelated temporary files from a user-chosen cache folder", async () => {
    const dir = await tempDir();
    const { paths } = updateFixture(dir);
    const unrelated = await plant(path.join(path.dirname(paths.stateFile), ".notes.json.9.dead.tmp"), "x", older(STAGING_MAX_AGE_MS));
    expect(await sweepUpdateFiles(paths)).toEqual([]);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("removes an install lock left by a dead update but keeps a fresh lock", async () => {
    const dir = await tempDir();
    const paths = localPaths(path.join(dir, "cache"));
    const stale = await plant(paths.lockFile, "x", older(INSTALL_LOCK_MAX_MS));
    const fresh = await plant(path.join(path.dirname(paths.lockFile), "update.lock.keep"), "x");
    expect(await sweepUpdateFiles(paths)).toEqual([stale]);
    expect(existsSync(fresh)).toBe(true);
  });

  it("uses the update module's own cache layout and lifetimes", () => {
    const env = { ULTRAPLAN_CACHE_DIR: path.join(ROOT, "no-such-cache") } as NodeJS.ProcessEnv;
    const paths = localPaths(updates.cacheDir(env));
    expect(paths.stateFile).toBe(updates.statePath(env));
    expect(paths.claimFile).toBe(updates.claimPath(env));
    expect(paths.logFile).toBe(updates.logPath(env));
    expect(paths.lockFile).toBe(path.join(updates.cacheDir(env), "update.lock"));
    expect(CHECK_CLAIM_MAX_MS).toBe(updates.CLAIM_STALE_MS);
    expect(ROLLBACK_MAX_AGE_MS).toBe(updates.ROLLBACK_MAX_AGE_MS);
    const source = readFileSync(path.join(ROOT, "src", "update.js"), "utf8");
    expect(source).toContain(`const LOCK_STALE_MS = ${INSTALL_LOCK_MAX_MS / 60_000} * 60 * 1000;`);
    expect(source).toContain('path.join(cacheDir(env), "update.lock")');
  });

  it("removes a crashed staging file of the trimmed log, but not one of a foreign file", async () => {
    const dir = await tempDir();
    const { paths } = updateFixture(dir);
    const logStage = await plant(path.join(paths.cacheDir, "update.log.77.0a1b.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const foreign = await plant(path.join(paths.cacheDir, "notes.log.77.0a1b.tmp"), "x", older(STAGING_MAX_AGE_MS));
    expect(await sweepUpdateFiles(paths)).toEqual([logStage]);
    expect(existsSync(foreign)).toBe(true);
  });

  it("keeps a fresh claim, a fresh staging file and a recent log", async () => {
    const dir = await tempDir();
    const { paths } = updateFixture(dir);
    const claim = await plant(paths.claimFile, '{"token":"t"}');
    const stage = await plant(path.join(path.dirname(paths.stateFile), "update.json.2.abc123.tmp"));
    const log = await plant(paths.logFile, "install output");
    expect(await sweepUpdateFiles(paths)).toEqual([]);
    for (const kept of [claim, stage, log]) expect(existsSync(kept)).toBe(true);
  });

  it("drops an install log older than its seven-day retention and nothing else", async () => {
    const dir = await tempDir();
    const { paths } = updateFixture(dir);
    const config = await plant(paths.stateFile, "{}");
    const log = await plant(paths.logFile, "old output", older(INSTALL_LOG_MAX_AGE_MS));
    expect(await sweepUpdateFiles(paths)).toEqual([log]);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(config)).toBe(true);
  });
});

describe("installer area", () => {
  const installer = (dir: string, wrapperName = "ut-todo"): InstallPlan & { appDir: string; wrapper: string } => ({
    kind: "installer",
    appDir: path.join(dir, "app"),
    wrapper: path.join(dir, "bin", wrapperName),
  });

  it("removes crashed staging but keeps the live release, the rollback copy and the runtime", async () => {
    const dir = await tempDir();
    const plan = installer(dir);
    const live = await plant(path.join(plan.appDir, "release-0.5.4", "bin", "ut-todo"), "new");
    const stage = await plant(path.join(plan.appDir, "release-0.5.4.tmp"), null);
    await plant(path.join(stage, "bin", "ut-todo"), "new");
    const aged = new Date(Date.now() - older(STAGING_MAX_AGE_MS));
    await fs.utimes(stage, aged, aged);
    const windowsStage = await plant(path.join(plan.appDir, ".staging-abc123"), null, older(STAGING_MAX_AGE_MS));
    const nodeStage = await plant(path.join(plan.appDir, "runtime", "node-v22.20.0-linux-x64.tmp"), null, older(STAGING_MAX_AGE_MS));
    const runtime = await plant(path.join(plan.appDir, "runtime", "node-v22.20.0-linux-x64"), null, older(ROLLBACK_MAX_AGE_MS));
    const rollbackCopy = await plant(path.join(plan.appDir, "release-0.5.4.previous"), null, older(STAGING_MAX_AGE_MS));
    const wrapper = await plant(plan.wrapper, "#!/bin/sh\nexec node \".../release-0.5.4/bin/ut-todo\" \"$@\"\n");
    const shStage = await plant(`${plan.wrapper}.tmp.1234`, "x", older(STAGING_MAX_AGE_MS));
    const psStage = await plant(`${plan.wrapper}.tmp`, "x", older(STAGING_MAX_AGE_MS));
    const rollbackStage = await plant(`${plan.wrapper}.4321.0badc0de.tmp`, "x", older(STAGING_MAX_AGE_MS));
    const freshStage = await plant(`${plan.wrapper}.tmp.99`, "x");
    const foreign = await plant(path.join(path.dirname(plan.wrapper), "other-tool.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const removed = await sweepInstallArea(plan, Date.now(), path.join(dir, "tmp"));
    expect(removed.sort()).toEqual([stage, windowsStage, nodeStage, shStage, psStage, rollbackStage].sort());
    for (const kept of [live, runtime, rollbackCopy, wrapper, freshStage, foreign]) expect(existsSync(kept)).toBe(true);
  });

  it("matches the Windows wrapper's staging name, ut-todo.cmd.tmp", async () => {
    const dir = await tempDir();
    const plan = installer(dir, "ut-todo.cmd");
    await plant(plan.wrapper, "@echo off\r\nREM ultraplan-installer-shim\r\n\"node\" \"%~dp0..\\app\\release-0.5.4\\bin\\ut-todo\" %*\r\n");
    const stage = await plant(`${plan.wrapper}.tmp`, "x", older(STAGING_MAX_AGE_MS));
    expect(await sweepInstallArea(plan, Date.now(), path.join(dir, "tmp"))).toEqual([stage]);
    expect(existsSync(plan.wrapper)).toBe(true);
  });

  it("removes only its own aged folders from the system temp directory", async () => {
    const dir = await tempDir();
    const tmp = path.join(dir, "tmp");
    const updateTmp = await plant(path.join(tmp, "ut-todo-update-AbC123"), null, older(TEMP_DIR_MAX_AGE_MS));
    const shTmp = await plant(path.join(tmp, "ultraplan-install.xy12Zq"), null, older(TEMP_DIR_MAX_AGE_MS));
    const psTmp = await plant(path.join(tmp, "ultraplan-install-6f1c2a3b-0d4e-4f5a-9b6c-7d8e9f0a1b2c"), null, older(TEMP_DIR_MAX_AGE_MS));
    const fresh = await plant(path.join(tmp, "ut-todo-update-fresh1"), null);
    const foreign = await plant(path.join(tmp, "someone-else"), null, older(TEMP_DIR_MAX_AGE_MS));
    const notOurs = await plant(path.join(tmp, "ultraplan-build.k3j2h1"), null, older(TEMP_DIR_MAX_AGE_MS));
    const removed = await sweepInstallArea({ kind: "npm" }, Date.now(), tmp);
    expect(removed.sort()).toEqual([updateTmp, shTmp, psTmp].sort());
    for (const kept of [fresh, foreign, notOurs]) expect(existsSync(kept)).toBe(true);
  });

  it("touches no install folder for an npm, source or manual install", async () => {
    const dir = await tempDir();
    const plan = installer(dir);
    await plant(path.join(plan.appDir, "release-0.5.4.tmp"), "x", older(STAGING_MAX_AGE_MS));
    for (const kind of ["npm", "manual"] as const) {
      expect(await sweepInstallArea({ kind }, Date.now(), path.join(dir, "absent-tmp"))).toEqual([]);
    }
    expect(existsSync(path.join(plan.appDir, "release-0.5.4.tmp"))).toBe(true);
  });

  it("sweeps exactly the staging names the installers and the update module write", () => {
    const sh = readFileSync(path.join(ROOT, "scripts", "install.sh"), "utf8");
    const ps1 = readFileSync(path.join(ROOT, "scripts", "install.ps1"), "utf8");
    const update = readFileSync(path.join(ROOT, "src", "update.js"), "utf8");
    expect(sh).toContain('mktemp -d "${TMPDIR:-/tmp}/ultraplan-install.XXXXXX"');
    expect(sh).toContain('"$BIN_DIR/ut-todo.tmp.$$"');
    expect(sh).toContain('mv "$TMP/src" "$REL.tmp"');
    expect(sh).toContain('NODE_DIR="$APP/runtime/node-$nver-$os-$arch"');
    expect(sh).toContain('mkdir "$NODE_DIR.tmp"');
    expect(sh).toContain('mv "$keep" "$REL.previous"');
    expect(ps1).toContain("('ultraplan-install-' + [guid]::NewGuid())");
    expect(ps1).toContain("('.staging-' + [guid]::NewGuid())");
    expect(ps1).toContain('$relTmp = "$rel.tmp"');
    expect(ps1).toContain('Write-ShimFile -Path "$shim.tmp"');
    expect(ps1).toContain('$previous = "$rel.previous"');
    expect(update).toContain('mkdtempSync(path.join(tmpRoot, "ut-todo-update-"))');
    expect(update).toContain("const temporary = `${file}.${process.pid}.${randomBytes(4).toString(\"hex\")}.tmp`;");
    expect(update).toContain("`release-${version}.previous`");
    expect([...TEMP_DIR_PREFIXES].sort()).toEqual(["ultraplan-install-", "ultraplan-install.", "ut-todo-update-"]);
  });
});

describe("rollback copy (contract §4a)", () => {
  /** The layout `ut-todo update` leaves: release-<new> live, release-<new>.previous kept, wrapper on <new>. */
  async function fixture(dir: string, versions: { live?: string; kept?: string; named?: string } = {}) {
    const { live = "0.5.4", kept = "0.5.4" } = versions;
    const named = versions.named ?? live;
    const appDir = path.join(dir, "app");
    const wrapper = path.join(dir, "bin", "ut-todo");
    const selfPath = await plant(path.join(appDir, `release-${live}`, "bin", "ut-todo"), "new");
    const previousDir = path.join(appDir, `release-${kept}.previous`);
    await plant(path.join(previousDir, "bin", "ut-todo"), "old");
    await plant(wrapper, `#!/bin/sh\n# ultraplan-installer-shim\nexec "/usr/bin/node" "${path.join(appDir, `release-${named}`, "bin", "ut-todo")}" "$@"\n`);
    return { appDir, wrapper, selfPath, previousDir };
  }

  async function age(targets: string[], ms: number) {
    const when = new Date(Date.now() - ms);
    for (const target of targets) await fs.utimes(target, when, when);
  }

  it("retires release-<new>.previous once release <new> has run a command", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, selfPath, previousDir } = await fixture(dir);
    expect(await retireRollbackCopies({ appDir, wrapper, selfPath }))
      .toEqual({ retirement: "ran-successfully", removed: [previousDir] });
    expect(existsSync(previousDir)).toBe(false);
    expect(existsSync(selfPath)).toBe(true);
    expect(existsSync(wrapper)).toBe(true);
  });

  it("keeps it while the update command still runs from the release it replaced", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, previousDir } = await fixture(dir);
    // The updating process started from release-0.5.3, which the installer just renamed to release-0.5.4.previous.
    const oldSelf = path.join(appDir, "release-0.5.3", "bin", "ut-todo");
    expect((await retireRollbackCopies({ appDir, wrapper, selfPath: oldSelf })).retirement).toBe("kept");
    expect((await retireRollbackCopies({ appDir, wrapper, selfPath: path.join(previousDir, "bin", "ut-todo") })).retirement).toBe("kept");
    expect((await retireRollbackCopies({ appDir, wrapper })).retirement).toBe("kept");
    expect(existsSync(previousDir)).toBe(true);
  });

  it("measures the seven days from the swap, not from the old release's own age", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, previousDir } = await fixture(dir);
    // A rename keeps the folder's old mtime; the wrapper written during the swap is fresh.
    await age([previousDir], older(ROLLBACK_MAX_AGE_MS) * 4);
    expect((await retireRollbackCopies({ appDir, wrapper })).retirement).toBe("kept");
    expect(existsSync(previousDir)).toBe(true);
    await age([wrapper], older(ROLLBACK_MAX_AGE_MS));
    expect(await retireRollbackCopies({ appDir, wrapper })).toEqual({ retirement: "expired", removed: [previousDir] });
    expect(existsSync(previousDir)).toBe(false);
  });

  it("keeps a copy for a release the wrapper does not name until it expires", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, selfPath, previousDir } = await fixture(dir, { live: "0.5.5", kept: "0.5.4" });
    expect((await retireRollbackCopies({ appDir, wrapper, selfPath })).retirement).toBe("kept");
    expect(existsSync(previousDir)).toBe(true);
    await age([previousDir, wrapper], older(ROLLBACK_MAX_AGE_MS));
    expect((await retireRollbackCopies({ appDir, wrapper, selfPath })).retirement).toBe("expired");
    expect(existsSync(previousDir)).toBe(false);
  });

  it("keeps everything when the wrapper is missing or names no release", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, selfPath, previousDir } = await fixture(dir);
    await age([previousDir], older(ROLLBACK_MAX_AGE_MS));
    await fs.writeFile(wrapper, "#!/bin/sh\nexec node \"$HOME/elsewhere/ut-todo\" \"$@\"\n");
    await age([wrapper], older(ROLLBACK_MAX_AGE_MS));
    expect((await retireRollbackCopies({ appDir, wrapper, selfPath })).retirement).toBe("kept");
    await fs.rm(wrapper);
    expect((await retireRollbackCopies({ appDir, wrapper, selfPath })).retirement).toBe("kept");
    expect(existsSync(previousDir)).toBe(true);
  });

  it("reads the release from a Windows cmd wrapper", async () => {
    const dir = await tempDir();
    const appDir = path.join(dir, "app");
    const wrapper = path.join(dir, "bin", "ut-todo.cmd");
    const selfPath = await plant(path.join(appDir, "release-0.5.4", "bin", "ut-todo"), "new");
    const previousDir = await plant(path.join(appDir, "release-0.5.4.previous"), null);
    await plant(wrapper, "@echo off\r\nREM ultraplan-installer-shim\r\n\"node\" \"%~dp0..\\app\\release-0.5.4\\bin\\ut-todo\" %*\r\n");
    expect(await retireRollbackCopies({ appDir, wrapper, selfPath }))
      .toEqual({ retirement: "ran-successfully", removed: [previousDir] });
  });

  it("never touches names the tool does not write", async () => {
    const dir = await tempDir();
    const { appDir, wrapper, selfPath } = await fixture(dir);
    const generic = await plant(path.join(appDir, "release-previous"), null, older(ROLLBACK_MAX_AGE_MS));
    const backup = await plant(`${wrapper}.previous`, "user file", older(ROLLBACK_MAX_AGE_MS));
    await retireRollbackCopies({ appDir, wrapper, selfPath });
    expect(existsSync(generic)).toBe(true);
    expect(existsSync(backup)).toBe(true);
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
    const log = await plant(paths.logFile, "x", older(INSTALL_LOG_MAX_AGE_MS));
    const selfPath = await plant(path.join(appDir, "release-0.5.4", "bin", "ut-todo"), "new");
    const previous = await plant(path.join(appDir, "release-0.5.4.previous", "bin", "ut-todo"), "old");
    await plant(wrapper, `#!/bin/sh\nexec node "${path.join(appDir, "release-0.5.4", "bin", "ut-todo")}" "$@"\n`);
    const tmp = await plant(path.join(dir, "tmp", "ut-todo-update-dead00"), null, older(TEMP_DIR_MAX_AGE_MS));
    const plan: InstallPlan = { kind: "installer", appDir, wrapper };
    const report = await sweepLocalData({ storeDir: path.dirname(store), selfPath, paths, plan, tmpDir: path.dirname(tmp) });
    expect(report.rollback).toBe("ran-successfully");
    for (const gone of [storeStage, claim, log, path.dirname(path.dirname(previous)), tmp]) {
      expect(existsSync(gone)).toBe(false);
    }
    expect(existsSync(store)).toBe(true);
    expect(existsSync(selfPath)).toBe(true);
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
    const claim = await plant(path.join(cache, "update.claim"), '{"token":"stale"}', older(60 * 60 * 1_000));
    const cacheStage = await plant(path.join(cache, "update.json.11.abcd.tmp"), "x", older(STAGING_MAX_AGE_MS));
    const cacheFile = await plant(path.join(cache, "update.json"), '{"checkedAt":1}');

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
  const updates = readFileSync(path.join(ROOT, "docs", "updates.md"), "utf8");

  it("documents every path the inventory names", () => {
    const paths = LOCAL_WRITES.flatMap((entry) => entry.paths);
    expect(paths.length).toBeGreaterThanOrEqual(20);
    for (const name of ["<bin>/ut-todo.tmp.<pid>", "<bin>/ut-todo.cmd.tmp", "<tmp>/ultraplan-install-<guid>", "<app>/release-<version>.previous"]) {
      expect(paths).toContain(name);
    }
    expect(paths.filter((entry) => !privacy.includes(`\`${entry}\``))).toEqual([]);
  });

  it("defines its path roots without repeating ultraplan inside them", () => {
    for (const root of ["<cache>", "<app>", "<bin>", "<tmp>"]) {
      expect(privacy).toContain(`\`${root}\` is`);
    }
    expect(privacy).toContain("<cache>/update.json");
    expect(privacy).toContain("<cache>/update.lock");
    expect(privacy).not.toContain("<cache>/ultraplan/");
    expect(privacy).not.toContain("<cache>/update-check.json");
  });

  it("names only the temp folders and staging names the tool really writes", () => {
    for (const text of [privacy, updates]) {
      expect(text).toContain("<tmp>/ut-todo-update-*");
      expect(text).toContain("<tmp>/ultraplan-install.*");
      expect(text).toMatch(/ultraplan-install-(?:\*|<guid>)/);
      // Names from the never-released privacy-branch updater; nothing writes them.
      expect(text).not.toContain("ultraplan-update-");
      expect(text).not.toContain(".rollback.tmp");
      expect(text).not.toMatch(/`ultraplan-\*` folders/);
    }
  });

  it("states the lifetimes the code uses", () => {
    expect(STAGING_MAX_AGE_MS).toBe(60 * 60 * 1000);
    expect(STALE_LOCK_MS).toBe(30_000);
    expect(TEMP_DIR_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(INSTALL_LOG_MAX_AGE_MS).toBe(ROLLBACK_MAX_AGE_MS);
    expect(ROLLBACK_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    for (const fact of ["1 hour", "30 s", "14 s", "10 minutes", "1 day", "7 days", "256 KB"]) expect(privacy).toContain(fact);
  });

  it("states the claim's age and its overlap with an in-flight reclaim", () => {
    expect(privacy).toContain("14 s old");
    expect(privacy).toMatch(/overlaps a check reclaiming/);
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
    expect(section).not.toContain("0700");
    expect(section).toMatch(/anonymous update check a day/);
    expect(section).toContain("UT_TODO_NO_UPDATE_CHECK=1");
    expect(section).toContain("[PRIVACY.md](PRIVACY.md)");
    expect(readme).not.toMatch(/unpublished|not (?:yet )?published/i);
  });

  it("says the cleanup opt-out leaves the update module's own housekeeping on", () => {
    expect(privacy).toContain("ULTRAPLAN_NO_LOCAL_CLEANUP=1");
    expect(privacy).toMatch(/does not switch off the update module's own\s+housekeeping/);
    expect(updates).toMatch(/update module's own rollback pruning above still runs/);
  });

  it("records the automatic rollback cleanup in the update contract", () => {
    expect(updates).not.toMatch(/does \*\*not\*\* implement\s+that cleanup/);
    expect(updates).toMatch(/run\s+successfully\s+once/);
    expect(updates).toMatch(/(?:seven|7) days/);
    const files = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).files;
    expect(files).toContain("PRIVACY.md");
    expect(files).toContain("docs");
  });
});
