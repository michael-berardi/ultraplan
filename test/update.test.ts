import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECK_TIMEOUT_MS,
  MAX_INSTALL_LOG_BYTES,
  autoInstallLaunch,
  capInstallLog,
  checkForUpdate,
  compareVersions,
  defaultSpawn,
  failureCause,
  installAvailable,
  installCommand,
  isNewer,
  isOptedOut,
  markNoticeShown,
  noticeText,
  packageInfo,
  parseRelease,
  parseVersion,
  readCache,
  readConfig,
  rollbackRelease,
  shouldNotice,
  startAutoInstall,
  swapRelease,
  updateConfig,
  updatePaths,
  verifyChecksum,
  writeCache,
  type FetchLike,
  type FetchResponse,
  type SpawnLike,
} from "../src/update.ts";

/**
 * Update-contract tests. Every network dependency is injected: the suite makes
 * no real request, and the CLI child processes run with checks disabled.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = path.join(ROOT, "package.json");
const BIN = path.join(ROOT, "bin", "ut-todo");
const run = promisify(execFile);
const tempDirs: string[] = [];

async function fixture() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "ultraplan-update-"));
  tempDirs.push(dir);
  const env: NodeJS.ProcessEnv = {
    ULTRAPLAN_CACHE_DIR: path.join(dir, "cache"),
    ULTRAPLAN_CONFIG_DIR: path.join(dir, "config"),
  };
  return { dir, env, paths: updatePaths(env, "darwin", dir) };
}

function response(overrides: Partial<FetchResponse> = {}): FetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("stable version comparison", () => {
  it("accepts only strict x.y.z releases", () => {
    expect(parseVersion("v1.2.3")).toBe("1.2.3");
    expect(parseVersion(" 10.0.1 ")).toBe("10.0.1");
    for (const garbage of ["1.2", "1.2.3-rc.1", "v2.0.0-beta", "latest", "", undefined, "1.2.3.4"]) {
      expect(parseVersion(garbage)).toBeUndefined();
    }
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.2", "1.2.3")).toBeLessThan(0);
    expect(isNewer("v2.0.0", "1.2.3")).toBe(true);
    expect(isNewer("2.0.0-rc.1", "1.2.3")).toBe(false);
    expect(isNewer(undefined, "1.2.3")).toBe(false);
  });

  it("ignores drafts, prereleases and unparseable tags", () => {
    for (const record of [
      { tag_name: "v9.0.0", prerelease: true },
      { tag_name: "v9.0.0", draft: true },
      { tag_name: "nightly" },
      { tag_name: "9.0.0+build" },
    ]) expect(parseRelease(record).version).toBeUndefined();
    expect(parseRelease({ tag_name: "v9.0.0", body: "# Notes\r\nfirst\r\nsecond" }).notes).toBe("# Notes\nfirst\nsecond");
  });
});

describe("anonymous at-most-daily check", () => {
  it("uses one public release URL, a fixed agent, no identifiers and a short timeout", async () => {
    const { env, paths } = await fixture();
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const info = await packageInfo(MANIFEST);
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return response({ json: async () => ({ tag_name: "v9.0.0", body: "notes" }) });
    };
    const result = await checkForUpdate({ env, paths, manifestFile: MANIFEST, fetchImpl, now: () => 1_000_000 });
    expect(result.status).toBe("available");
    expect(result.latest).toBe("9.0.0");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.github.com/repos/${info.owner}/${info.repo}/releases/latest`);
    expect(calls[0].url).not.toMatch(/\?|version=|id=|machine/);
    expect(calls[0].init?.headers?.["user-agent"]).toBe("ut-todo-update-check");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(CHECK_TIMEOUT_MS).toBeLessThanOrEqual(4_000);

    const source = await fs.readFile(path.join(ROOT, "src", "update.ts"), "utf8");
    expect(source).toMatch(/AbortSignal\.timeout\(CHECK_TIMEOUT_MS\)/);
    expect(source).not.toMatch(/os\.hostname|cpus\(|client_id|machine_id|authorization|Bearer/i);
  });

  it("caches for 24 h and rechecks after the interval", async () => {
    const { env, paths } = await fixture();
    let clock = 1_000_000;
    let newest = "9.0.0";
    const fetchImpl: FetchLike = async () => response({ json: async () => ({ tag_name: `v${newest}` }) });
    const deps = { env, paths, manifestFile: MANIFEST, fetchImpl, now: () => clock };
    expect((await checkForUpdate(deps)).latest).toBe("9.0.0");
    newest = "10.0.0";
    clock += 23 * 60 * 60 * 1_000;
    const cached = await checkForUpdate(deps);
    expect(cached.latest).toBe("9.0.0");
    expect(cached.fromCache).toBe(true);
    clock += 2 * 60 * 60 * 1_000;
    expect((await checkForUpdate(deps)).latest).toBe("10.0.0");
  });

  it("records a failure with its cause and does not retry in a loop", async () => {
    const { env, paths } = await fixture();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      throw new Error("fixture offline");
    };
    const deps = { env, paths, manifestFile: MANIFEST, fetchImpl, now: () => 1_000_000 };
    const failed = await checkForUpdate(deps);
    expect(failed.status).toBe("failed");
    expect(failed.failure).toContain("fixture offline");
    expect((await readCache(paths))?.failure).toContain("fixture offline");
    const again = await checkForUpdate({ ...deps, fetchImpl: async () => response() });
    expect(again.status).toBe("failed");
    expect(calls).toBe(1);
    expect(failureCause(new Error("  bad\n cause "))).toBe("bad cause");
  });

  it("is disabled by env and by persistent config", async () => {
    const { env, paths } = await fixture();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return response();
    };
    const deps = { env, paths, manifestFile: MANIFEST, fetchImpl };
    expect((await checkForUpdate({ ...deps, env: { ...env, ULTRAPLAN_NO_UPDATE_CHECK: "1" } })).status).toBe("disabled");
    await updateConfig(paths, { checkAutomatically: false });
    expect((await checkForUpdate(deps)).status).toBe("disabled");
    expect(calls).toBe(0);
    expect(isOptedOut({ ...env, ULTRAPLAN_NO_UPDATE_CHECK: "1" }, {})).toBe(true);
  });
});

describe("notice, skip and opt-in persistence", () => {
  it("uses the contract lines and hides a shown or skipped version", async () => {
    const { env, paths } = await fixture();
    const lines = noticeText("0.4.3", "0.5.0");
    expect(lines[0]).toBe("ut-todo 0.5.0 available (you have 0.4.3) · run: ut-todo update");
    expect(lines[1]).toBe("turn on automatic updates: ut-todo update --auto on · skip: ut-todo update --skip");
    expect(noticeText("0.4.3", "0.5.0", true)[1]).toContain("\x1b[2m");

    const config = await updateConfig(paths, {});
    const cache = { checkedAt: 1_000, latest: "0.5.0", notes: "notes" };
    await writeCache(paths, cache);
    expect(shouldNotice(env, config, cache, "0.4.3", 2_000)).toBe(true);
    await markNoticeShown(paths, "0.5.0", 2_000);
    const shown = (await readCache(paths))!;
    expect(shouldNotice(env, config, shown, "0.4.3", 2_000)).toBe(false);
    expect(shouldNotice(env, config, shown, "0.4.3", 2_000 + 24 * 60 * 60 * 1_000)).toBe(true);
    const skipped = await updateConfig(paths, { skipVersion: "0.5.0" });
    expect(shouldNotice(env, skipped, cache, "0.4.3", 3_000)).toBe(false);
    expect(shouldNotice(env, skipped, { ...cache, latest: "0.6.0" }, "0.4.3", 3_000)).toBe(true);
  });

  it("persists auto-install off by default and on when opted in", async () => {
    const { paths } = await fixture();
    expect((await readConfig(paths)).autoInstall).toBeUndefined();
    await updateConfig(paths, { autoInstall: true });
    expect((await readConfig(paths)).autoInstall).toBe(true);
    await updateConfig(paths, { autoInstall: false, autoPrompted: true });
    expect((await readConfig(paths))).toMatchObject({ autoInstall: false, autoPrompted: true });
    const stat = await fs.stat(paths.configFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("install safety", () => {
  it("refuses a checksum mismatch", async () => {
    const { dir, env, paths } = await fixture();
    const bytes = Buffer.from("archive");
    const sums = `${createHash("sha256").update("other").digest("hex")}  ultraplan.tar.gz\n`;
    expect(verifyChecksum(sums, "ultraplan.tar.gz", bytes)).toBe(false);
    const good = `${createHash("sha256").update(bytes).digest("hex")} *ultraplan.tar.gz\n`;
    expect(verifyChecksum(good, "ultraplan.tar.gz", bytes)).toBe(true);

    const app = path.join(dir, "home", ".ultraplan", "app");
    const binDir = path.join(dir, "bin");
    const wrapper = path.join(binDir, "ut-todo");
    await fs.mkdir(path.join(app, "release-0.5.0", "bin"), { recursive: true });
    await fs.writeFile(path.join(app, "release-0.5.0", "bin", "ut-todo"), "old");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(wrapper, `#!/bin/sh\nexec "${path.join(app, "release-0.5.0", "bin", "ut-todo")}" "$@"\n`);
    const owner = (await packageInfo(MANIFEST)).owner;
    const repo = (await packageInfo(MANIFEST)).repo;
    const base = `https://github.com/${owner}/${repo}/releases/download/v9.0.0/`;
    const fetchImpl: FetchLike = async (url) => response({
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => url.endsWith("SHA256SUMS") ? sums : "",
    });
    const deps = {
      version: "9.0.0",
      env: { ...env, ULTRAPLAN_BIN_DIR: binDir },
      paths,
      binPath: path.join(app, "release-0.5.0", "bin", "ut-todo"),
      manifestFile: MANIFEST,
      fetchImpl,
    };
    await writeCache(paths, {
      checkedAt: 1_000,
      latest: "9.0.0",
      assets: [
        { name: "ultraplan.tar.gz", url: `${base}ultraplan.tar.gz` },
        { name: "SHA256SUMS", url: `${base}SHA256SUMS` },
      ],
    });
    await expect(installAvailable(deps)).rejects.toThrow(/checksum mismatch/);
    expect(await fs.readFile(path.join(app, "release-0.5.0", "bin", "ut-todo"), "utf8")).toBe("old");
    expect(await fs.readdir(app)).toEqual(["release-0.5.0"]);
  });

  it("names the install command that matches the install kind", () => {
    expect(installCommand({ kind: "npm" }, "1.2.3", "owner", "repo"))
      .toBe("npm install --global github:owner/repo#v1.2.3");
    expect(installCommand({ kind: "installer" }, "1.2.3", "owner", "repo", "darwin"))
      .toContain("install.sh | sh");
    expect(installCommand({ kind: "installer" }, "1.2.3", "owner", "repo", "win32"))
      .toContain("install.ps1 | iex");
  });

  it("swaps a verified release and rolls it back", async () => {
    const { dir, env, paths } = await fixture();
    const app = path.join(dir, "home", ".ultraplan", "app");
    const binDir = path.join(dir, "bin");
    const wrapper = path.join(binDir, "ut-todo");
    const oldEntry = path.join(app, "release-0.5.0", "bin", "ut-todo");
    await fs.mkdir(path.dirname(oldEntry), { recursive: true });
    await fs.writeFile(oldEntry, "old");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(wrapper, `#!/bin/sh\nexec "${oldEntry}" "$@"\n`);

    const source = path.join(dir, "source");
    await fs.mkdir(path.join(source, "bin"), { recursive: true });
    await fs.writeFile(path.join(source, "bin", "ut-todo"), "new");
    await swapRelease(app, "0.6.0", source, wrapper);

    const newEntry = path.join(app, "release-0.6.0", "bin", "ut-todo");
    expect(await fs.readFile(newEntry, "utf8")).toBe("new");
    expect(await fs.readFile(path.join(app, "release-previous", "bin", "ut-todo"), "utf8")).toBe("old");
    expect(await fs.readFile(wrapper, "utf8")).toContain("release-0.6.0");
    expect(await fs.readFile(`${wrapper}.previous`, "utf8")).toContain("release-0.5.0");

    await rollbackRelease(app, wrapper);
    expect(await fs.readFile(oldEntry, "utf8")).toBe("old");
    expect(await fs.readFile(wrapper, "utf8")).toContain("release-0.5.0");
    expect(env.ULTRAPLAN_CACHE_DIR).toBeTruthy();
    expect(paths.logDir).toContain("logs");
  });
});

describe("detached automatic installs", () => {
  it("launches low priority, detached and unref'd without waiting for the child", async () => {
    const started = Date.now();
    const code = await defaultSpawn(
      process.execPath, ["-e", "setTimeout(() => {}, 3000)"],
      { detached: true, stdio: "ignore" },
    );
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("uses a detached low-priority child and a capped, private log", async () => {
    const { env, paths } = await fixture();
    const calls: Array<{ command: string; args: string[]; options?: Parameters<SpawnLike>[2] }> = [];
    const spawnImpl: SpawnLike = async (command, args, options) => {
      calls.push({ command, args, options });
      return 0;
    };
    const logFile = path.join(paths.logDir, "update.log");
    await fs.mkdir(paths.logDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(logFile, "a".repeat(MAX_INSTALL_LOG_BYTES + 512), { mode: 0o600 });

    await startAutoInstall({
      version: "9.0.0", binPath: "/tmp/ut-todo", env, paths, platform: "darwin", spawnImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("nice");
    expect(calls[0].args).toEqual(["-n", "10", process.execPath, "/tmp/ut-todo", "update", "--apply", "9.0.0"]);
    expect(calls[0].options?.detached).toBe(true);
    expect(calls[0].options?.stdio?.[0]).toBe("ignore");
    expect(calls[0].options?.env?.ULTRAPLAN_UPDATE_APPLY).toBe("1");
    expect(calls[0].options?.env?.ULTRAPLAN_INSTALL_LOG).toBe(logFile);
    const log = await fs.readFile(logFile, "utf8");
    expect(log).toHaveLength(MAX_INSTALL_LOG_BYTES);
    expect(log.endsWith("a")).toBe(true);
    expect((await fs.stat(logFile)).mode & 0o777).toBe(0o600);

    expect(autoInstallLaunch("/tmp/ut-todo", "9.0.0", "win32")).toEqual({
      command: process.execPath, args: ["/tmp/ut-todo", "update", "--apply", "9.0.0"],
    });
  });

  it("falls back to a detached plain runtime when nice is absent", async () => {
    const { env, paths } = await fixture();
    const called: string[][] = [];
    const spawnImpl: SpawnLike = async (command, args, options) => {
      called.push([command, ...args]);
      expect(options?.detached).toBe(true);
      if (command === "nice") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return 0;
    };
    await startAutoInstall({ version: "9.0.0", binPath: "/tmp/ut-todo", env, paths, platform: "darwin", spawnImpl });
    expect(called).toHaveLength(2);
    expect(called[1]).toEqual([process.execPath, "/tmp/ut-todo", "update", "--apply", "9.0.0"]);
  });

  it("records a launch failure and leaves the current release untouched", async () => {
    const { env, paths } = await fixture();
    await startAutoInstall({
      version: "9.0.0",
      env,
      paths,
      platform: "darwin",
      spawnImpl: async () => { throw new Error("spawn blocked"); },
    });
    expect((await readCache(paths))?.failure).toMatch(/^automatic install failed: spawn blocked$/);
  });

  it("caps a large log to its newest bytes and ignores a missing log", async () => {
    const { dir } = await fixture();
    const logFile = path.join(dir, "update.log");
    await fs.writeFile(logFile, `${"old".repeat(100_000)}${"END"}`);
    await capInstallLog(logFile);
    const log = await fs.readFile(logFile, "utf8");
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(MAX_INSTALL_LOG_BYTES);
    expect(log.endsWith("END")).toBe(true);
    await expect(capInstallLog(path.join(dir, "absent.log"))).resolves.toBeUndefined();
  });
});

describe("shipped documentation and metadata", () => {
  it("carries the update-contract marker, aligned versions and README sections", async () => {
    const docs = await fs.readFile(path.join(ROOT, "docs", "updates.md"), "utf8");
    expect(docs).toContain("<!-- update-contract: v1 -->");
    const manifest = JSON.parse(await fs.readFile(MANIFEST, "utf8"));
    const plugin = JSON.parse(await fs.readFile(
      path.join(ROOT, "integrations", "claude-code", ".claude-plugin", "plugin.json"), "utf8",
    ));
    expect(plugin.version).toBe(manifest.version);
    expect(manifest.files).toContain("docs");
    const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/^## Privacy$/m);
    expect(readme).toMatch(/^## Updates$/m);
    expect(readme).toContain("docs/updates.md");
    const changelog = await fs.readFile(path.join(ROOT, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## ${manifest.version} `);
    const binSource = await fs.readFile(BIN, "utf8");
    expect(binSource).toContain('op !== "json"');
    expect(binSource).toContain("maybeAutoCheck(op.op)");
    expect(binSource).toContain("agentMode(env)");
    expect(binSource).toContain("!envSet(env.CI)");
    expect(binSource).toContain("process.stdout.isTTY && process.stderr.isTTY");
  });
});

describe("CLI silence outside interactive use", () => {
  it("keeps opt-out and non-TTY runs quiet and json output clean", async () => {
    const { dir, env } = await fixture();
    const cwd = await fs.mkdtemp(path.join(tmpdir(), "ultraplan-cli-"));
    tempDirs.push(cwd);
    const clean = { ...process.env } as NodeJS.ProcessEnv;
    delete clean.CLAUDE_CODE_SESSION_ID;
    delete clean.CLAUDECODE;
    const base = { ...clean, ...env, CI: "1" };
    const check = await run(process.execPath, [BIN, "update", "--check"], {
      cwd,
      env: { ...base, ULTRAPLAN_NO_UPDATE_CHECK: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(check.stderr).toContain("update checks are disabled");
    const view = await run(process.execPath, [BIN, "init", "Quiet:task"], {
      cwd,
      env: base,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(view.stderr).toBe("");
    const json = await run(process.execPath, [BIN, "json", '{"op":"view"}'], {
      cwd,
      env: base,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(json.stderr).toBe("");
    expect(json.stdout).toContain("Overall: 0/1 done.");
    expect(dir).toBeTruthy();
  });
});
