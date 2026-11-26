import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  afterCommand, appendLog, CLAIM_STALE_MS, claimPath, CURRENT, DAY_MS, detectInstall, dueNotice, fetchLatest, isNewer, MAX_LOG_BYTES,
  noticeLines, npmCommand, parseVersion, passiveCheck, pruneRollback, readState,
  statePath, logPath, updateCommand, updateState,
} from "../src/update.js";

/**
 * Update contract v1. No test touches the network: the release record and the
 * release assets come from a local HTTP server, and installs run the real
 * scripts/install.sh against a throwaway home folder.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
const TTY = { stdout: { isTTY: true }, stderr: { isTTY: true } };
const PACKAGE_FILES = ["bin/ut-todo", "src/core.ts", "src/render.ts", "src/update.js", "src/update.d.ts"];

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ultraplan-update-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Environment with no CI/agent markers, a private cache, temp folder and wrapper folder. */
function baseEnv(root: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(UT_TODO_|ULTRAPLAN_|CLAUDE)/.test(key) || ["CI", "NO_COLOR"].includes(key)) delete env[key];
  }
  mkdirSync(path.join(root, "tmp"), { recursive: true });
  return {
    ...env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`,
    TMPDIR: path.join(root, "tmp"),
    ULTRAPLAN_CACHE_DIR: path.join(root, "cache"),
    ULTRAPLAN_BIN_DIR: path.join(root, "bin"),
    ...extra,
  };
}

/** Local release server: GET /api answers `record`; other paths are files under `root`. */
async function releaseServer(root: string, record: { current: object | "fail" }) {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    seen.push({ url, headers: req.headers });
    if (url === "/api") {
      if (record.current === "fail") res.writeHead(503).end("unavailable");
      else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(record.current));
      return;
    }
    const file = path.join(root, path.normalize(decodeURIComponent(url)));
    if (!file.startsWith(root) || !existsSync(file)) res.writeHead(404).end("missing");
    else res.writeHead(200).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${address.port}`, seen, apiCalls: () => seen.filter((s) => s.url === "/api").length };
}

/** A runnable copy of this package with its version set to `version`. */
function copyPackage(dest: string, version: string) {
  for (const file of PACKAGE_FILES) {
    mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
    copyFileSync(path.join(ROOT, file), path.join(dest, file));
  }
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  writeFileSync(path.join(dest, "package.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
}

/** Release assets as build-release.sh lays them out: archive, installer, SHA256SUMS. */
function makeRelease(root: string, version: string): string {
  const assets = path.join(root, `assets-${version}`);
  const stage = path.join(root, `stage-${version}`);
  copyPackage(path.join(stage, "package"), version);
  mkdirSync(assets, { recursive: true });
  const packed = spawnSync("tar", ["-czf", path.join(assets, "ultraplan.tar.gz"), "-C", stage, "package"]);
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr}`);
  copyFileSync(path.join(ROOT, "scripts", "install.sh"), path.join(assets, "install.sh"));
  const sums = ["ultraplan.tar.gz", "install.sh"].map((name) =>
    `${createHash("sha256").update(readFileSync(path.join(assets, name))).digest("hex")}  ${name}`);
  writeFileSync(path.join(assets, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return assets;
}

/** An installer-style install of `version`: <home>/app/release-<version> plus the marked wrapper. */
function installFixture(root: string, version = CURRENT) {
  const home = path.join(root, "home");
  const app = path.join(home, "app");
  const release = path.join(app, `release-${version}`);
  copyPackage(release, version);
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, "ut-todo");
  writeFileSync(shim, `#!/bin/sh\n# ultraplan-installer-shim\nexec "${process.execPath}" "${release}/bin/ut-todo" "$@"\n`, { mode: 0o755 });
  return { home, app, binDir, shim, bin: (v: string) => path.join(app, `release-${v}`, "bin", "ut-todo") };
}

async function cli(bin: string, args: string[], env: Record<string, string | undefined>, cwd = path.dirname(bin)) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8", timeout: 60000 });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { status: typeof failure.code === "number" ? failure.code : -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const json = (body: object) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const REPO_BIN = path.join(ROOT, "bin", "ut-todo");

describe("version rules", () => {
  it("only a strictly newer stable x.y.z is newer", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(isNewer("0.6.0", "0.5.0")).toBe(true);
    expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("0.5.0", "0.5.0")).toBe(false);
    expect(isNewer("0.4.9", "0.5.0")).toBe(false);
    for (const bad of ["0.6.0-rc.1", "nightly", "0.6", "1.2.3.4", "", undefined, null]) {
      expect(isNewer(bad, "0.5.0")).toBe(false);
    }
  });
});

describe("daily check", () => {
  it("sends nothing and writes nothing when not a terminal, in CI, in agent runs or opted out", async () => {
    const root = tempDir();
    let calls = 0;
    const fetchImpl = (async () => { calls++; return json({ tag_name: "v9.9.9" }); }) as typeof fetch;
    const env = baseEnv(root);
    const cases: Array<[Record<string, string | undefined>, typeof TTY | object]> = [
      [env, { stdout: { isTTY: false }, stderr: { isTTY: true } }],
      [env, { stdout: { isTTY: true }, stderr: { isTTY: false } }],
      [{ ...env, CI: "true" }, TTY],
      [{ ...env, CLAUDECODE: "1" }, TTY],
      [{ ...env, UT_TODO_BACKGROUND: "1" }, TTY],
      [{ ...env, UT_TODO_NO_UPDATE_CHECK: "1" }, TTY],
    ];
    for (const [caseEnv, streams] of cases) {
      expect(await passiveCheck({ env: caseEnv, streams, fetchImpl })).toBeUndefined();
    }
    expect(existsSync(path.join(root, "cache"))).toBe(false);
    updateState(statePath(env), { checks: false }); // ut-todo update --auto-check off
    expect(await passiveCheck({ env, streams: TTY, fetchImpl })).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("checks at most once a day and records a failure with its cause, without retrying", async () => {
    const root = tempDir();
    const env = baseEnv(root);
    let calls = 0;
    const failing = (async () => { calls++; return { ok: false, status: 503 } as Response; }) as typeof fetch;
    const now = Date.now();
    expect(await passiveCheck({ env, streams: TTY, fetchImpl: failing, now })).toBeUndefined();
    expect(readState(statePath(env)).error).toBe("release API returned HTTP 503");
    await passiveCheck({ env, streams: TTY, fetchImpl: failing, now: now + DAY_MS - 1 });
    expect(calls).toBe(1);
    const newer = (async () => { calls++; return json({ tag_name: "v9.9.9" }); }) as typeof fetch;
    const due = await passiveCheck({ env, streams: TTY, fetchImpl: newer, now: now + DAY_MS });
    expect(calls).toBe(2);
    expect(due?.version).toBe("9.9.9");
    expect(readState(statePath(env)).error).toBeUndefined();

    const hanging = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    expect((await fetchLatest({ url: "http://127.0.0.1:9/api", fetchImpl: hanging, timeoutMs: 20 })).error)
      .toMatch(/^timed out after/);
  });

  it("commands started together share one in-flight check; its claim is gone afterwards", async () => {
    const root = tempDir();
    const env = baseEnv(root);
    let calls = 0;
    let answer!: () => void;
    const gate = new Promise<void>((resolve) => { answer = resolve; });
    const slow = (async () => { calls++; await gate; return json({ tag_name: "v9.9.9" }); }) as typeof fetch;
    const listeners = process.listenerCount("exit");
    const first = passiveCheck({ env, streams: TTY, fetchImpl: slow });
    expect(existsSync(claimPath(env))).toBe(true);
    expect(statSync(claimPath(env)).mode & 0o777).toBe(0o600);
    expect(process.listenerCount("exit")).toBe(listeners + 1); // a failing command still removes the claim
    const others = await Promise.all([1, 2, 3].map(() => passiveCheck({ env, streams: TTY, fetchImpl: slow })));
    expect(others).toEqual([undefined, undefined, undefined]); // nothing cached yet, and no second request
    answer();
    expect((await first)?.version).toBe("9.9.9");
    expect(calls).toBe(1);
    expect(existsSync(claimPath(env))).toBe(false);
    expect(process.listenerCount("exit")).toBe(listeners);
    expect(readdirSync(path.join(root, "cache"))).toEqual(["update.json"]);
  });

  it("leaves a live claim alone and takes over one left by a process that died", async () => {
    const root = tempDir();
    const env = baseEnv(root);
    let calls = 0;
    const newer = (async () => { calls++; return json({ tag_name: "v9.9.9" }); }) as typeof fetch;
    mkdirSync(path.dirname(claimPath(env)), { recursive: true });
    writeFileSync(claimPath(env), "another-process\n");
    expect(await passiveCheck({ env, streams: TTY, fetchImpl: newer })).toBeUndefined();
    expect(calls).toBe(0);
    expect(readFileSync(claimPath(env), "utf8")).toBe("another-process\n"); // not ours to remove
    const old = (Date.now() - CLAIM_STALE_MS - 1000) / 1000;
    utimesSync(claimPath(env), old, old);
    expect((await passiveCheck({ env, streams: TTY, fetchImpl: newer }))?.version).toBe("9.9.9");
    expect(calls).toBe(1);
    expect(existsSync(claimPath(env))).toBe(false);
  });

  it("is one anonymous GET with a fixed User-Agent; drafts, prereleases and odd tags are not releases", async () => {
    const root = tempDir();
    const record = { current: { tag_name: "v0.6.0", body: "notes" } as object | "fail" };
    const server = await releaseServer(root, record);
    expect(await fetchLatest({ url: `${server.url}/api` })).toEqual({ version: "0.6.0", notes: "notes" });
    expect(server.seen).toHaveLength(1);
    const { headers } = server.seen[0];
    expect(headers["user-agent"]).toBe("ut-todo-update-check");
    expect(Object.keys(headers).filter((name) => /cookie|authorization|token/i.test(name))).toEqual([]);
    for (const current of [{ tag_name: "v0.6.0", draft: true }, { tag_name: "v0.6.0", prerelease: true }, { tag_name: "latest" }]) {
      record.current = current;
      const result = await fetchLatest({ url: `${server.url}/api` });
      expect(result.version).toBeUndefined();
      expect(result.error).toBeUndefined();
    }
  });
});

describe("notice", () => {
  const stderr = () => {
    let text = "";
    return { write: (chunk: string) => { text += chunk; return true; }, text: () => text };
  };

  it("prints the two contract lines on stderr, second one dim, at most once a day per version", async () => {
    const root = tempDir();
    const env = baseEnv(root);
    const now = Date.now();
    updateState(statePath(env), { checkedAt: now, latest: "9.9.9" });
    const err = stderr();
    await afterCommand(passiveCheck({ env, streams: TTY, now }), { env, stderr: err, now, current: "0.5.0" });
    expect(err.text()).toBe(
      "ut-todo 9.9.9 available (you have 0.5.0) · run: ut-todo update\n" +
      "\u001b[2mturn on automatic updates: ut-todo update --auto on · skip: ut-todo update --skip\u001b[22m\n",
    );
    const again = stderr();
    await afterCommand(passiveCheck({ env, streams: TTY, now: now + 1000 }), { env, stderr: again, now: now + 1000 });
    expect(again.text()).toBe("");
    updateState(statePath(env), { latest: "9.9.10" }); // a newer release notifies right away
    const newer = stderr();
    await afterCommand(passiveCheck({ env: { ...env, NO_COLOR: "1" }, streams: TTY, now: now + 2000 }),
      { env: { ...env, NO_COLOR: "1" }, stderr: newer, now: now + 2000, current: "0.5.0" });
    expect(newer.text()).toBe(`${noticeLines("9.9.10", "0.5.0").join("\n")}\n`);
  });

  it("a skipped version stays hidden until a newer one appears", () => {
    const state = { ...readState("/nonexistent"), latest: "0.6.0", skip: "0.6.0" };
    expect(dueNotice(state, "0.5.0")).toBeUndefined();
    expect(dueNotice({ ...state, latest: "0.6.1" }, "0.5.0")).toBe("0.6.1");
    expect(dueNotice({ ...state, latest: "0.5.0", skip: undefined }, "0.5.0")).toBeUndefined();
  });

  it("with auto on, starts a detached install instead of the notice; after a failure it shows the notice", async () => {
    const root = tempDir();
    const env = baseEnv(root);
    const marker = path.join(root, "ran.json");
    const fake = path.join(root, "fake-bin.mjs");
    writeFileSync(fake, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), background: process.env.UT_TODO_BACKGROUND }));\n`);
    const now = Date.now();
    updateState(statePath(env), { checkedAt: now, latest: "9.9.9", auto: true });
    const err = stderr();
    await afterCommand(passiveCheck({ env, streams: TTY, now }), { env, stderr: err, binPath: fake, now });
    for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ args: ["update", "--background"], background: "1" });
    expect(err.text()).toBe("");
    expect(readFileSync(logPath(env), "utf8")).toContain("started background install");

    updateState(statePath(env), { autoFailed: "9.9.9", shownAt: 0 }); // what a failed background install records
    const fallback = stderr();
    await afterCommand(passiveCheck({ env, streams: TTY, now }), { env, stderr: fallback, binPath: fake, now });
    expect(fallback.text()).toContain("ut-todo 9.9.9 available");
  });
});

describe("ut-todo update commands", () => {
  it("non-terminal commands and json ops make no request and print nothing on stderr", async () => {
    const root = tempDir();
    const server = await releaseServer(root, { current: { tag_name: "v9.9.9" } });
    const env = baseEnv(root, { UT_TODO_UPDATE_API: `${server.url}/api` });
    const work = path.join(root, "work");
    mkdirSync(work);
    for (const args of [["init", "Build:a"], ["json", '{"op":"view"}'], ["view"]]) {
      const result = await cli(REPO_BIN, args, env, work);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("9.9.9");
    }
    expect(server.apiCalls()).toBe(0);
    expect(existsSync(path.join(root, "cache"))).toBe(false);
  });

  it("--check exits 0 when current, 10 with an update, 1 with the cause of a failure", async () => {
    const root = tempDir();
    const record = { current: { tag_name: `v${CURRENT}` } as object | "fail" };
    const server = await releaseServer(root, record);
    const env = baseEnv(root, { UT_TODO_UPDATE_API: `${server.url}/api` });
    expect(await cli(REPO_BIN, ["update", "--check"], env)).toMatchObject({ status: 0, stdout: `ut-todo ${CURRENT} is up to date\n` });
    record.current = { tag_name: "v9.9.9", body: "**Headline** for 9.9.9\n\nSecond line" };
    expect(await cli(REPO_BIN, ["update", "--check"], env)).toMatchObject({
      status: 10,
      stdout: `ut-todo 9.9.9 available (you have ${CURRENT}) · run: ut-todo update\nHeadline for 9.9.9\nSecond line\n`,
    });
    record.current = "fail";
    expect(await cli(REPO_BIN, ["update", "--check"], env)).toMatchObject({
      status: 1, stderr: "ut-todo: update check failed: release API returned HTTP 503\n",
    });
    expect(readState(statePath(env)).error).toBe("release API returned HTTP 503");
    expect((await cli(REPO_BIN, ["update", "--bogus"], env)).status).toBe(2);
    expect((await cli(REPO_BIN, ["update", "--background"], env)).status).toBe(2);
  });

  it("--skip, --auto and --auto-check persist; auto is off by default", async () => {
    const root = tempDir();
    const server = await releaseServer(root, { current: { tag_name: "v9.9.9" } });
    const fixture = installFixture(root);
    const env = baseEnv(root, { UT_TODO_UPDATE_API: `${server.url}/api` });
    const bin = fixture.bin(CURRENT);
    expect((await cli(bin, ["update", "--auto", "status"], env)).stdout).toBe("automatic updates: off\n");
    expect((await cli(bin, ["update", "--auto", "on"], env)).stdout).toBe("automatic updates: on\n");
    expect((await cli(bin, ["update", "--auto", "status"], env)).stdout).toBe("automatic updates: on\n");
    expect(readState(statePath(env))).toMatchObject({ auto: true, autoAsked: true });
    expect((await cli(bin, ["update", "--auto", "off"], env)).stdout).toBe("automatic updates: off\n");
    expect(readState(statePath(env)).auto).toBe(false);
    expect((await cli(bin, ["update", "--auto-check", "off"], env)).stdout).toBe("daily update check: off\n");
    expect(readState(statePath(env)).checks).toBe(false);
    expect(await cli(bin, ["update", "--skip"], env)).toMatchObject({
      status: 0, stdout: "ut-todo 9.9.9 skipped; a newer release will show a notice again\n",
    });
    expect(readState(statePath(env)).skip).toBe("9.9.9");
    // A source checkout cannot update itself, so it cannot opt in either.
    const source = await cli(REPO_BIN, ["update", "--auto", "on"], env);
    expect(source.status).toBe(1);
    expect(source.stderr).toContain("git -C");
  });
});

describe("install, rollback and debris", () => {
  it("installs a verified release, keeps one rollback copy, and --rollback from the new version restores it", async () => {
    const root = tempDir();
    const fixture = installFixture(root);
    makeRelease(root, "0.6.0");
    const server = await releaseServer(root, { current: { tag_name: "v0.6.0", body: "Notes for 0.6.0" } });
    const env = baseEnv(root, { UT_TODO_UPDATE_API: `${server.url}/api`, ULTRAPLAN_RELEASE_BASE: `${server.url}/assets-0.6.0` });

    const result = await cli(fixture.bin(CURRENT), ["update"], env);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`ut-todo ${CURRENT} → 0.6.0\nNotes for 0.6.0\n`);
    expect(result.stdout).toContain("installed ut-todo 0.6.0; it runs from your next command");
    expect(result.status).toBe(0);
    expect(readdirSync(fixture.app).sort()).toEqual(["release-0.6.0", "release-0.6.0.previous"]);
    expect(readFileSync(fixture.shim, "utf8")).toContain("release-0.6.0/bin/ut-todo");
    expect(readState(statePath(env)).rollback).toMatchObject({ version: "0.6.0", from: CURRENT });
    expect(readdirSync(path.join(root, "tmp"))).toEqual([]); // CLI and installer temp folders are gone
    expect(readdirSync(path.join(root, "cache")).sort()).toEqual(["update.json"]);

    const back = await cli(fixture.bin("0.6.0"), ["update", "--rollback"], env);
    expect(back).toMatchObject({ status: 0, stdout: `restored ut-todo ${CURRENT}; 0.6.0 is skipped\n` });
    expect(readdirSync(fixture.app)).toEqual([`release-${CURRENT}`]);
    expect(readFileSync(fixture.shim, "utf8")).toContain(`release-${CURRENT}/bin/ut-todo`);
    expect(readState(statePath(env))).toMatchObject({ skip: "0.6.0", rollback: undefined });
    const help = spawnSync(fixture.shim, ["--help"], { env, encoding: "utf8" });
    expect(help.stdout).toContain("ut-todo init");
  });

  it("drops the rollback copy after the new version runs once; a second update still keeps only one", async () => {
    const root = tempDir();
    const fixture = installFixture(root);
    makeRelease(root, "0.6.0");
    makeRelease(root, "0.7.0");
    const record = { current: { tag_name: "v0.6.0" } as object | "fail" };
    const server = await releaseServer(root, record);
    const env = baseEnv(root, { UT_TODO_UPDATE_API: `${server.url}/api`, ULTRAPLAN_RELEASE_BASE: `${server.url}/assets-0.6.0` });
    expect((await cli(fixture.bin(CURRENT), ["update"], env)).status).toBe(0);
    const work = path.join(root, "work");
    mkdirSync(work);
    expect((await cli(fixture.bin("0.6.0"), ["init", "Build:a"], env, work)).status).toBe(0);
    expect(readdirSync(fixture.app)).toEqual(["release-0.6.0"]);
    expect(readState(statePath(env)).rollback).toBeUndefined();
    expect(await cli(fixture.bin("0.6.0"), ["update", "--rollback"], env)).toMatchObject({
      status: 1, stderr: "ut-todo: no previous release is kept; nothing to roll back\n",
    });

    record.current = { tag_name: "v0.7.0" };
    const next = { ...env, ULTRAPLAN_RELEASE_BASE: `${server.url}/assets-0.7.0` };
    expect((await cli(fixture.bin("0.6.0"), ["update"], next)).status).toBe(0);
    expect(readdirSync(fixture.app).sort()).toEqual(["release-0.7.0", "release-0.7.0.previous"]);
  });

  it("removes the rollback copy after 7 days even if the new version never ran", () => {
    const root = tempDir();
    const env = baseEnv(root);
    const kept = path.join(root, "home", "app", "release-0.6.0.previous");
    mkdirSync(kept, { recursive: true });
    const at = Date.now();
    updateState(statePath(env), { rollback: { version: "0.6.0", from: "0.5.0", path: kept, at } });
    pruneRollback({ env, current: "0.5.0", now: at + 6 * DAY_MS });
    expect(existsSync(kept)).toBe(true);
    pruneRollback({ env, current: "0.5.0", now: at + 7 * DAY_MS + 1 });
    expect(existsSync(kept)).toBe(false);
    expect(readState(statePath(env)).rollback).toBeUndefined();
  });

  it("refuses a tampered installer or archive and leaves the current release untouched", async () => {
    for (const tampered of ["install.sh", "ultraplan.tar.gz"]) {
      const root = tempDir();
      const fixture = installFixture(root);
      const assets = makeRelease(root, "0.6.0");
      writeFileSync(path.join(assets, tampered), "tampered\n");
      const server = await releaseServer(root, { current: { tag_name: "v0.6.0" } });
      const env = baseEnv(root, { UT_TODO_UPDATE_API: `${server.url}/api`, ULTRAPLAN_RELEASE_BASE: `${server.url}/assets-0.6.0` });
      const shimBefore = readFileSync(fixture.shim, "utf8");
      const result = await cli(fixture.bin(CURRENT), ["update"], env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`checksum mismatch for ${tampered}; nothing was installed`);
      expect(readdirSync(fixture.app)).toEqual([`release-${CURRENT}`]);
      expect(readFileSync(fixture.shim, "utf8")).toBe(shimBefore);
      expect(readState(statePath(env)).error).toContain("checksum mismatch");
      expect(readdirSync(path.join(root, "tmp"))).toEqual([]);
    }
  });

  it("on a terminal asks before installing, then asks once about automatic updates", async () => {
    const root = tempDir();
    const fixture = installFixture(root);
    makeRelease(root, "0.6.0");
    const server = await releaseServer(root, { current: { tag_name: "v0.6.0" } });
    const env = baseEnv(root, { UT_TODO_UPDATE_API: `${server.url}/api`, ULTRAPLAN_RELEASE_BASE: `${server.url}/assets-0.6.0` });
    const install = detectInstall({ root: path.join(fixture.app, `release-${CURRENT}`), env });
    expect(install.kind).toBe("script");

    const terminal = (answers: Record<string, string>) => {
      const stdin = Object.assign(new PassThrough(), { isTTY: true });
      let asked = "";
      const stderr = Object.assign(new Writable({
        write(chunk, _encoding, done) {
          const text = String(chunk);
          asked += text;
          for (const [question, answer] of Object.entries(answers)) if (text.includes(question)) stdin.write(answer);
          done();
        },
      }), { isTTY: true });
      let out = "";
      const stdout = { write: (text: string) => { out += text; return true; } };
      return { stdin, stderr, stdout, asked: () => asked, out: () => out };
    };

    const declined = terminal({ "Install 0.6.0 now? [Y/n]": "n\n" });
    expect(await updateCommand([], { env, install, ...declined })).toBe(0);
    expect(declined.out()).toContain("not installed");
    expect(readdirSync(fixture.app)).toEqual([`release-${CURRENT}`]);

    const accepted = terminal({ "Install 0.6.0 now? [Y/n]": "\n", "Install future updates automatically? [y/N]": "n\n" });
    expect(await updateCommand([], { env, install, ...accepted })).toBe(0);
    expect(accepted.asked()).toContain("Install future updates automatically? [y/N]");
    expect(readState(statePath(env))).toMatchObject({ auto: false, autoAsked: true });
    expect(readdirSync(fixture.app).sort()).toEqual(["release-0.6.0", "release-0.6.0.previous"]);
  });

  it("names the right update for npm, dependency, source and unknown copies", () => {
    expect(detectInstall({ root: "/usr/local/lib/node_modules/ultraplan" }).kind).toBe("npm");
    expect(npmCommand("0.6.0", "owner/repo")).toEqual(["npm", ["install", "--global", "github:owner/repo#v0.6.0"]]);
    const dependency = detectInstall({ root: "/work/host/node_modules/ultraplan" });
    expect(dependency).toMatchObject({ kind: "manual", hint: expect.stringContaining("dependency") });
    expect(detectInstall({ root: "/x/lib/node_modules/host/node_modules/ultraplan" }).kind).toBe("manual");
    expect(detectInstall({ root: ROOT })).toMatchObject({ kind: "manual", hint: expect.stringContaining("git -C") });
    expect(detectInstall({ root: "/nowhere/ultraplan" })).toMatchObject({ kind: "manual", hint: expect.stringContaining("install.sh | sh") });
    const root = tempDir();
    const fixture = installFixture(root);
    const env = baseEnv(root);
    expect(detectInstall({ root: path.join(fixture.app, `release-${CURRENT}`), env }).kind).toBe("script");
    rmSync(fixture.shim); // no wrapper: the release folder cannot be switched safely
    expect(detectInstall({ root: path.join(fixture.app, `release-${CURRENT}`), env })).toMatchObject({ kind: "manual" });
  });

  it("keeps all update files in one cache folder: a 0600 state file and a log of at most 256 KB", async () => {
    const root = tempDir();
    const env = baseEnv(root);
    await passiveCheck({ env, streams: TTY, fetchImpl: (async () => json({ tag_name: "v9.9.9" })) as typeof fetch });
    expect(readdirSync(path.join(root, "cache"))).toEqual(["update.json"]);
    expect(statSync(statePath(env)).mode & 0o777).toBe(0o600);
    expect(statSync(statePath(env)).size).toBeLessThan(512);
    for (let i = 0; i < 400; i++) {
      appendLog(logPath(env), `${i} ${"x".repeat(1500)}`);
      expect(statSync(logPath(env)).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
    }
    const log = readFileSync(logPath(env), "utf8");
    expect(log.length).toBeGreaterThan(MAX_LOG_BYTES / 2);
    expect(log.trimEnd().split("\n").at(-1)).toContain(" 399 "); // newest lines are kept
    expect(readdirSync(path.join(root, "cache")).sort()).toEqual(["update.json", "update.log"]);
  });

  it("the embedded Pi extension leaves update checks to its host", () => {
    expect(readFileSync(path.join(ROOT, "pi", "extension.ts"), "utf8")).not.toMatch(/update\.js|fetch\(/);
  });
});
