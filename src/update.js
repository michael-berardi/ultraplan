/**
 * Update contract v1 for ut-todo (docs/updates.md). Dependency-free JavaScript,
 * so the CLI can load it before (and without) TypeScript type stripping.
 *
 * - Check: one anonymous GET to the public latest-release record, at most once
 *   a day, only on an interactive terminal, never in CI or agent runs.
 * - Notice: two lines on stderr after the command; `update --skip` hides a version.
 * - Install: installer installs run the release's own installer after checking
 *   it against SHA256SUMS (the installer then checks the archive). npm global
 *   installs run npm. Other copies are told the right command.
 * - Auto-install is off by default; one rollback copy; one bounded log.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const TOOL = "ut-todo";
export const DAY_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 4000;
export const MAX_LOG_BYTES = 256 * 1024;
export const ROLLBACK_MAX_AGE_MS = 7 * DAY_MS;
const USER_AGENT = "ut-todo-update-check";
const LOCK_STALE_MS = 10 * 60 * 1000;
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MANIFEST = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
const WINDOWS = process.platform === "win32";

/** The version this copy runs, from the package.json shipped beside it. */
export const CURRENT = String(MANIFEST.version);

/** owner/repo from the package's own repository field. */
export function repository(manifest = MANIFEST) {
  const url = String(manifest.repository?.url ?? manifest.repository ?? "");
  return /github\.com[/:]([^/\s]+\/[^/\s#]+?)(?:\.git)?(?:#.*)?$/.exec(url)?.[1];
}

// ---------------------------------------------------------------- versions

/** Stable x.y.z (optional leading v) as numbers; anything else is undefined. */
export function parseVersion(text) {
  const match = typeof text === "string" ? /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim()) : null;
  return match ? match.slice(1).map(Number) : undefined;
}

function stable(text) {
  return parseVersion(text)?.join(".");
}

/** Strictly newer stable release; garbage, prereleases and equal versions are not. */
export function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

// ------------------------------------------------------------------- state

/** The platform cache folder; it holds update.json and, only if auto-install ran, update.log. */
export function cacheDir(env = process.env) {
  if (env.ULTRAPLAN_CACHE_DIR) return path.resolve(env.ULTRAPLAN_CACHE_DIR);
  if (WINDOWS) return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "UltraPlan", "cache");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ultraplan");
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ultraplan");
}

export const statePath = (env = process.env) => path.join(cacheDir(env), "update.json");
export const logPath = (env = process.env) => path.join(cacheDir(env), "update.log");

const DEFAULTS = Object.freeze({
  checkedAt: 0, latest: undefined, error: undefined, skip: undefined, shown: undefined, shownAt: 0,
  checks: true, auto: false, autoAsked: false, autoFailed: undefined, rollback: undefined,
});

/** Read the state file; a missing or damaged file is the defaults. */
export function readState(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return { ...DEFAULTS }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULTS };
  const time = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const text = (value) => (typeof value === "string" ? value.slice(0, 500) : undefined);
  const rollback = raw.rollback;
  return {
    checkedAt: time(raw.checkedAt),
    latest: stable(raw.latest),
    error: text(raw.error),
    skip: stable(raw.skip),
    shown: stable(raw.shown),
    shownAt: time(raw.shownAt),
    checks: raw.checks !== false,
    auto: raw.auto === true,
    autoAsked: raw.autoAsked === true,
    autoFailed: stable(raw.autoFailed),
    rollback: rollback && stable(rollback.version) && stable(rollback.from) && typeof rollback.path === "string"
      ? { version: stable(rollback.version), from: stable(rollback.from), path: rollback.path, at: time(rollback.at) }
      : undefined,
  };
}

/** Atomic write (temp file + rename) with mode 0600 in a 0700 folder. */
function writeAtomic(file, text, mode) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeState(file, state) {
  writeAtomic(file, `${JSON.stringify(state)}\n`, 0o600);
  return state;
}

export function updateState(file, patch) {
  return writeState(file, { ...readState(file), ...patch });
}

/** One log file for background installs, trimmed so it never exceeds maxBytes. */
export function appendLog(file, text, maxBytes = MAX_LOG_BYTES) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const line = Buffer.from(`${new Date().toISOString()} ${String(text).trim().slice(0, 2000)}\n`);
  let size = 0;
  try { size = statSync(file).size; } catch {}
  if (size + line.length <= maxBytes) {
    appendFileSync(file, line, { mode: 0o600 });
    return;
  }
  const kept = size ? readFileSync(file).subarray(-Math.floor(maxBytes / 2)) : Buffer.alloc(0);
  writeAtomic(file, Buffer.concat([kept, line]).subarray(-maxBytes), 0o600);
}

// ------------------------------------------------------------------- check

/** Why the daily check stays off, or undefined when it may run. */
export function quietReason(env, streams, state) {
  if (env.UT_TODO_NO_UPDATE_CHECK && env.UT_TODO_NO_UPDATE_CHECK !== "0") return "UT_TODO_NO_UPDATE_CHECK is set";
  if (state.checks === false) return "turned off with ut-todo update --auto-check off";
  if (env.CI) return "CI";
  if (env.UT_TODO_BACKGROUND || env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID) return "agent or background run";
  if (!streams.stdout?.isTTY || !streams.stderr?.isTTY) return "not a terminal";
  return undefined;
}

export function checkUrl(env = process.env) {
  return env.UT_TODO_UPDATE_API || `https://api.github.com/repos/${repository()}/releases/latest`;
}

function cause(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return `timed out after ${CHECK_TIMEOUT_MS / 1000} s`;
  const code = error?.cause?.code;
  return `${String(error?.message ?? error)}${code ? ` (${code})` : ""}`.slice(0, 300);
}

/** One anonymous GET: fixed User-Agent, nothing about the user, machine or version. */
export async function fetchLatest({ url, fetchImpl = globalThis.fetch, timeoutMs = CHECK_TIMEOUT_MS }) {
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { error: `release API returned HTTP ${response.status}` };
    const data = await response.json();
    if (!data || data.draft || data.prerelease) return { version: undefined, notes: "" };
    return { version: stable(data.tag_name), notes: typeof data.body === "string" ? data.body : "" };
  } catch (error) {
    return { error: cause(error) };
  }
}

/** Fetch now and record the result (or the failure and its cause) in the cache. */
export async function refresh({ env = process.env, fetchImpl, now = Date.now() } = {}) {
  const result = await fetchLatest({ url: checkUrl(env), fetchImpl });
  const state = updateState(statePath(env), result.error
    ? { checkedAt: now, error: result.error }
    : { checkedAt: now, error: undefined, latest: result.version });
  return { ...result, state };
}

/** The cached newer version to announce now, honoring skip and once a day per version. */
export function dueNotice(state, current = CURRENT, now = Date.now()) {
  const version = state.latest;
  if (!isNewer(version, current)) return undefined;
  if (state.skip && !isNewer(version, state.skip)) return undefined;
  if (state.shown === version && now - state.shownAt < DAY_MS && state.shownAt <= now) return undefined;
  return version;
}

/**
 * The daily check behind the notice, started alongside the command. Resolves
 * to { version, state } when a notice is due; never rejects and never prints.
 */
export async function passiveCheck({
  env = process.env, streams = process, fetchImpl, now = Date.now(), current = CURRENT,
} = {}) {
  try {
    let state = readState(statePath(env));
    if (quietReason(env, streams, state)) return undefined;
    const fresh = state.checkedAt <= now && now - state.checkedAt < DAY_MS;
    if (!fresh) state = (await refresh({ env, fetchImpl, now })).state;
    const version = dueNotice(state, current, now);
    return version ? { version, state } : undefined;
  } catch {
    return undefined;
  }
}

export function noticeLines(version, current = CURRENT, { dim = false } = {}) {
  const second = `turn on automatic updates: ${TOOL} update --auto on · skip: ${TOOL} update --skip`;
  return [
    `${TOOL} ${version} available (you have ${current}) · run: ${TOOL} update`,
    dim ? `\u001b[2m${second}\u001b[22m` : second,
  ];
}

/** After the command: start the opted-in background install, or print the notice on stderr. */
export async function afterCommand(pending, {
  env = process.env, stderr = process.stderr, binPath, now = Date.now(), current = CURRENT,
} = {}) {
  const due = await pending;
  if (!due) return;
  try {
    updateState(statePath(env), { shown: due.version, shownAt: now });
    if (due.state.auto && due.state.autoFailed !== due.version && binPath) {
      startBackgroundInstall({ env, binPath });
      return;
    }
    stderr.write(`${noticeLines(due.version, current, { dim: !env.NO_COLOR }).join("\n")}\n`);
  } catch {
    // A read-only cache must never fail the user's command.
  }
}

/** Detached, below-normal priority child running `ut-todo update --background`. */
export function startBackgroundInstall({ env = process.env, binPath }) {
  const log = logPath(env);
  try {
    const child = spawn(process.execPath, [binPath, "update", "--background"], {
      detached: true, stdio: "ignore", windowsHide: true, env: { ...env, UT_TODO_BACKGROUND: "1" },
    });
    child.on("error", (error) => appendLog(log, `background install did not start: ${error.message}`));
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    child.unref();
    appendLog(log, `started background install (pid ${child.pid})`);
    return child;
  } catch (error) {
    appendLog(log, `background install did not start: ${cause(error)}`);
    return undefined;
  }
}

// ------------------------------------------------------------ install kind

function installerCommand() {
  const repo = repository();
  return WINDOWS
    ? `irm https://github.com/${repo}/releases/latest/download/install.ps1 | iex`
    : `curl -fsSL https://github.com/${repo}/releases/latest/download/install.sh | sh`;
}

/**
 * How this copy was installed, read from where it lives:
 * - script: <home>/app/release-<version>/ from install.sh or install.ps1, with its wrapper
 * - npm: a global npm install, updated by npm
 * - manual: a source checkout, a dependency of another package, or unknown; `hint` names the command
 */
export function detectInstall({ root = PACKAGE_ROOT, env = process.env, current = CURRENT } = {}) {
  root = path.resolve(root);
  const parent = path.dirname(root);
  if (path.basename(root) === `release-${current}` && path.basename(parent) === "app") {
    const home = path.dirname(parent);
    const binDir = path.resolve(env.ULTRAPLAN_BIN_DIR ||
      (WINDOWS ? path.join(home, "bin") : path.join(os.homedir(), ".local", "bin")));
    const shim = path.join(binDir, WINDOWS ? "ut-todo.cmd" : "ut-todo");
    let text = "";
    try { text = readFileSync(shim, "utf8"); } catch {}
    if (text.includes("ultraplan-installer-shim") && new RegExp(`release-${current.replaceAll(".", "\\.")}[\\\\/]bin[\\\\/]ut-todo`).test(text)) {
      return { kind: "script", home, binDir, shim };
    }
    return {
      kind: "manual",
      hint: `the installer's ut-todo wrapper was not found in ${binDir} (set ULTRAPLAN_BIN_DIR if you chose another folder), or run the installer again: ${installerCommand()}`,
    };
  }
  const segments = root.split(path.sep);
  if (segments.at(-2) === "node_modules") {
    const prefix = path.dirname(parent);
    const global = segments.filter((segment) => segment === "node_modules").length === 1 && (WINDOWS
      ? path.basename(prefix).toLowerCase() === "npm" || prefix.toLowerCase() === path.dirname(process.execPath).toLowerCase()
      : path.basename(prefix) === "lib");
    if (global) return { kind: "npm" };
    return { kind: "manual", hint: `this copy is a dependency in ${parent}; update the project or tool that installed it` };
  }
  if (existsSync(path.join(root, ".git"))) {
    return { kind: "manual", hint: `this is a source checkout; update it with: git -C "${root}" pull --ff-only` };
  }
  return { kind: "manual", hint: `install it with: ${installerCommand()}` };
}

export function npmCommand(version, repo = repository()) {
  return ["npm", ["install", "--global", `github:${repo}#v${version}`]];
}

// ----------------------------------------------------------------- install

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** The hash SHA256SUMS lists for name ("<hex>  name" or "<hex> *name"). */
export function checksumFor(sums, name) {
  for (const line of String(sums).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return undefined;
}

async function download(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${url.split("/").pop()}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Put release `to` back in place of `from`: the rollback copy becomes
 * release-<to> again, the wrapper points at it, and release-<from> goes.
 */
function restorePrevious({ home, shim }, from, to) {
  const app = path.join(home, "app");
  const kept = path.join(app, `release-${from}.previous`);
  const target = path.join(app, `release-${to}`);
  if (!existsSync(kept)) throw new Error(`no rollback copy at ${kept}`);
  if (existsSync(target)) throw new Error(`${target} already exists; nothing was restored`);
  renameSync(kept, target);
  const text = readFileSync(shim, "utf8");
  writeAtomic(shim, text.split(`release-${from}`).join(`release-${to}`), 0o755);
  try { rmSync(path.join(app, `release-${from}`), { recursive: true, force: true }); } catch {}
}

/** Run a command without blocking the event loop; keeps the tail of its output. */
function run(command, args, { stdio = ["ignore", "pipe", "pipe"], timeout = 10 * 60_000, ...options } = {}) {
  return new Promise((resolve) => {
    const output = { stdout: "", stderr: "" };
    let child;
    try {
      child = spawn(command, args, { ...options, stdio, windowsHide: true });
    } catch (error) {
      resolve({ status: null, error, ...output });
      return;
    }
    for (const name of ["stdout", "stderr"]) {
      child[name]?.on("data", (chunk) => { output[name] = (output[name] + chunk).slice(-4000); });
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.on("error", (error) => { clearTimeout(timer); resolve({ status: null, error, ...output }); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, ...output }); });
  });
}

function lastLines(result) {
  return String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim().slice(-600);
}

/**
 * Install `version`. Installer installs: download SHA256SUMS and the
 * installer, refuse on a checksum mismatch, then run that installer, which
 * verifies the archive before it switches the wrapper and keeps the replaced
 * release as release-<version>.previous. Downloads stay in a temp folder that
 * is always deleted.
 */
export async function installVersion({
  version, install, env = process.env, fetchImpl = globalThis.fetch, current = CURRENT,
  tmpRoot = os.tmpdir(), quiet = false,
}) {
  if (install.kind === "npm") {
    const [command, args] = npmCommand(version);
    const result = await run(command, args, { env, stdio: quiet ? "ignore" : "inherit", shell: WINDOWS });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${lastLines(result)}`);
    return { previous: undefined };
  }
  if (install.kind !== "script") throw new Error(install.hint);

  const base = (env.ULTRAPLAN_RELEASE_BASE || `https://github.com/${repository()}/releases/download/v${version}`)
    .replace(/\/+$/, "");
  const name = WINDOWS ? "install.ps1" : "install.sh";
  const staging = mkdtempSync(path.join(tmpRoot, "ut-todo-update-"));
  try {
    const sums = (await download(`${base}/SHA256SUMS`, fetchImpl)).toString("utf8");
    const script = await download(`${base}/${name}`, fetchImpl);
    const expected = checksumFor(sums, name);
    if (!expected) throw new Error(`SHA256SUMS has no entry for ${name}; nothing was installed`);
    if (sha256(script) !== expected) throw new Error(`checksum mismatch for ${name}; nothing was installed`);
    const scriptPath = path.join(staging, name);
    writeFileSync(scriptPath, script, { mode: 0o700 });
    const runner = WINDOWS
      ? [path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath]]
      : ["sh", [scriptPath]];
    const result = await run(runner[0], runner[1], {
      env: {
        ...env,
        ULTRAPLAN_RELEASE_BASE: base,
        ULTRAPLAN_HOME: install.home,
        ULTRAPLAN_BIN_DIR: install.binDir,
        ULTRAPLAN_KEEP_PREVIOUS: current,
      },
    });
    const previous = path.join(install.home, "app", `release-${version}.previous`);
    const switched = (() => { try { return readFileSync(install.shim, "utf8").includes(`release-${version}`); } catch { return false; } })();
    if (result.status !== 0 || !switched) {
      if (switched && existsSync(previous)) {
        try { restorePrevious(install, version, current); } catch {}
      }
      throw new Error(result.status !== 0
        ? `installer failed: ${lastLines(result)}`
        : `the installer did not switch to ${version}: ${lastLines(result)}`);
    }
    return { previous: existsSync(previous) ? previous : undefined };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** One install at a time per machine; a lock older than 10 minutes is stale. */
async function withInstallLock(env, fn) {
  const lock = path.join(cacheDir(env), "update.lock");
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let age = 0;
    try { age = Date.now() - statSync(lock).mtimeMs; } catch {}
    if (age < LOCK_STALE_MS) throw new Error("another ut-todo update is running");
    rmSync(lock, { force: true });
    closeSync(openSync(lock, "wx", 0o600));
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Install and remember the one rollback copy (replacing any older record). */
async function installAndRecord(options) {
  const { version, env = process.env, current = CURRENT, now = Date.now() } = options;
  return withInstallLock(env, async () => {
    const result = await installVersion(options);
    updateState(statePath(env), {
      error: undefined,
      autoFailed: undefined,
      rollback: result.previous ? { version, from: current, path: result.previous, at: now } : undefined,
    });
    return result;
  });
}

/** `update --rollback`: put the release from before the last update back and skip the newer one. */
export function rollback({ env = process.env, install = detectInstall({ env }), now = Date.now() } = {}) {
  const file = statePath(env);
  const record = readState(file).rollback;
  if (!record) throw new Error("no previous release is kept; nothing to roll back");
  if (install.kind !== "script" || path.resolve(record.path) !== path.join(install.home, "app", `release-${record.version}.previous`)) {
    throw new Error("rollback is only available for installer installs");
  }
  restorePrevious(install, record.version, record.from);
  updateState(file, { rollback: undefined, skip: record.version, shown: record.version, shownAt: now });
  return record;
}

/**
 * Remove the rollback copy once the new version has completed a command, or
 * after 7 days at most. Called by the CLI after a successful command.
 */
export function pruneRollback({ env = process.env, current = CURRENT, now = Date.now() } = {}) {
  try {
    const file = statePath(env);
    const record = readState(file).rollback;
    if (!record) return;
    if (record.version !== current && now - record.at < ROLLBACK_MAX_AGE_MS) return;
    const target = path.resolve(record.path);
    if (path.basename(target) === `release-${record.version}.previous` && path.basename(path.dirname(target)) === "app") {
      rmSync(target, { recursive: true, force: true });
    }
    updateState(file, { rollback: undefined });
  } catch {
    // Advisory cleanup; never fails the command.
  }
}

// ----------------------------------------------------------------- command

export const UPDATE_USAGE = `ut-todo update — check for and install a newer release.

  ut-todo update                  show what is new, then install it
  ut-todo update --check          report only: exit 0 up to date, 10 update available, 1 check failed
  ut-todo update --skip           hide the notice for this version until a newer one
  ut-todo update --auto on|off|status        install updates automatically (off by default)
  ut-todo update --auto-check on|off|status  daily check on a terminal (on by default)
  ut-todo update --rollback       restore the release from before the last update

See docs/updates.md.`;

/** First lines of the release notes, plain and short. */
export function notesHead(notes, maxLines = 4) {
  return String(notes ?? "").split(/\r?\n/)
    .map((line) => line.replace(/\*\*|`/g, "").trim())
    .filter((line) => line && !line.startsWith("```"))
    .slice(0, maxLines)
    .map((line) => (line.length > 100 ? `${line.slice(0, 99)}…` : line))
    .join("\n");
}

/** Yes/no on the terminal; Enter takes the default, closed input means no. */
export function ask(question, defaultYes, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.on("close", () => settle(false));
    rl.on("SIGINT", () => settle(false));
    rl.question(question, (answer) => {
      const value = answer.trim().toLowerCase();
      settle(value ? value === "y" || value === "yes" : defaultYes);
    });
  });
}

/** `ut-todo update ...`; returns the exit code. */
export async function updateCommand(argv, {
  env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  fetchImpl, install = detectInstall({ env }), now = Date.now(), current = CURRENT,
} = {}) {
  const say = (text) => stdout.write(`${text}\n`);
  const complain = (text) => stderr.write(`${TOOL}: ${text}\n`);
  const file = statePath(env);
  const [flag = "", value] = argv;
  const takesValue = flag === "--auto" || flag === "--auto-check";
  if (argv.length > (takesValue ? 2 : 1) || (takesValue && !["on", "off", "status"].includes(value))) {
    complain(takesValue ? `${flag} takes on, off or status` : "unexpected arguments; see ut-todo update --help");
    return 2;
  }
  const latestOrFail = async () => {
    const result = await refresh({ env, fetchImpl, now });
    if (result.error) complain(`update check failed: ${result.error}`);
    return result;
  };

  switch (flag) {
    case "-h":
    case "--help":
      say(UPDATE_USAGE);
      return 0;

    case "--auto-check": {
      if (value !== "status") updateState(file, { checks: value === "on" });
      say(`daily update check: ${readState(file).checks ? "on" : "off"}`);
      return 0;
    }

    case "--auto": {
      if (value === "on" && install.kind === "manual") {
        complain(`automatic updates need an installer or npm install; ${install.hint}`);
        return 1;
      }
      if (value !== "status") updateState(file, { auto: value === "on", autoAsked: true, autoFailed: undefined });
      say(`automatic updates: ${readState(file).auto ? "on" : "off"}`);
      return 0;
    }

    case "--skip": {
      let latest = readState(file).latest;
      if (!isNewer(latest, current)) {
        const result = await latestOrFail();
        if (result.error) return 1;
        latest = result.version;
      }
      if (!isNewer(latest, current)) {
        say(`${TOOL} ${current} is up to date; nothing to skip`);
        return 0;
      }
      updateState(file, { skip: latest });
      say(`${TOOL} ${latest} skipped; a newer release will show a notice again`);
      return 0;
    }

    case "--rollback": {
      try {
        const record = rollback({ env, install, now });
        say(`restored ${TOOL} ${record.from}; ${record.version} is skipped`);
        return 0;
      } catch (error) {
        complain(cause(error));
        return 1;
      }
    }

    case "--background": {
      // Internal: the detached child started by an opted-in check.
      if (env.UT_TODO_BACKGROUND !== "1") {
        complain("--background is internal; use ut-todo update");
        return 2;
      }
      const log = logPath(env);
      const state = readState(file);
      const version = dueVersionForAuto(state, current);
      if (!version) {
        appendLog(log, "background install: nothing to install");
        return 0;
      }
      try {
        await installAndRecord({ version, install, env, fetchImpl, current, now, quiet: true });
        appendLog(log, `installed ${version}; it runs from the next command`);
        return 0;
      } catch (error) {
        // Fall back to the notice on the next command; the cause stays in the cache and the log.
        updateState(file, { autoFailed: version, error: cause(error), shownAt: 0 });
        appendLog(log, `install of ${version} failed: ${cause(error)}`);
        return 1;
      }
    }

    case "--check": {
      const result = await latestOrFail();
      if (result.error) return 1;
      if (!isNewer(result.version, current)) {
        say(`${TOOL} ${current} is up to date`);
        return 0;
      }
      say(noticeLines(result.version, current)[0]);
      const notes = notesHead(result.notes);
      if (notes) say(notes);
      return 10;
    }

    case "": {
      const result = await latestOrFail();
      if (result.error) return 1;
      const version = result.version;
      if (!isNewer(version, current)) {
        say(`${TOOL} ${current} is up to date`);
        return 0;
      }
      say(`${TOOL} ${current} → ${version}`);
      const notes = notesHead(result.notes);
      if (notes) say(notes);
      if (install.kind === "manual") {
        complain(install.hint);
        return 1;
      }
      if (install.kind === "npm") say(`using: ${npmCommand(version).flat().join(" ")}`);
      const terminal = Boolean(stdin.isTTY && stderr.isTTY);
      if (terminal && !(await ask(`Install ${version} now? [Y/n] `, true, { input: stdin, output: stderr }))) {
        say("not installed");
        return 0;
      }
      try {
        await installAndRecord({ version, install, env, fetchImpl, current, now });
      } catch (error) {
        updateState(file, { error: cause(error) });
        complain(cause(error));
        return 1;
      }
      say(`installed ${TOOL} ${version}; it runs from your next command`);
      const state = readState(file);
      if (terminal && !state.auto && !state.autoAsked) {
        const yes = await ask("Install future updates automatically? [y/N] ", false, { input: stdin, output: stderr });
        updateState(file, { auto: yes, autoAsked: true });
      }
      return 0;
    }

    default:
      complain(`unknown option ${JSON.stringify(flag)}; see ut-todo update --help`);
      return 2;
  }
}

/** The cached version an opted-in background install may take, if any. */
function dueVersionForAuto(state, current) {
  if (!state.auto || !isNewer(state.latest, current)) return undefined;
  if (state.skip && !isNewer(state.latest, state.skip)) return undefined;
  if (state.autoFailed === state.latest) return undefined;
  return state.latest;
}
