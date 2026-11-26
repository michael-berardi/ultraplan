/**
 * UltraPlan release checks and installs.
 *
 * The automatic check is one anonymous GET to this repository's own public
 * GitHub "latest release" record. It carries no id, version, usage or machine
 * data, uses a fixed user agent, is cached for 24 h and times out in 4 s.
 * Explicit commands can report, skip or install; installing is never silent.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL = "ut-todo";
export const CHECK_TIMEOUT_MS = 4_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PUBLIC_EXEC_MODE = 0o755;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_DIR_RE = /release-(\d+\.\d+\.\d+)/;

export interface UpdatePaths {
  cacheFile: string;
  configFile: string;
  logDir: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface UpdateConfig {
  /** Checks are on by default in interactive use; this is the persistent opt-out. */
  checkAutomatically?: boolean;
  /** Auto-install is strictly opt-in and stored in config, not env-only. */
  autoInstall?: boolean;
  /** Hidden until a strictly newer release exists. */
  skipVersion?: string;
  /** The one-time auto-install question is never repeated after an answer. */
  autoPrompted?: boolean;
}

export interface UpdateCache {
  checkedAt: number;
  latest?: string;
  notes?: string;
  assets?: ReleaseAsset[];
  failure?: string;
  shownVersion?: string;
  shownAt?: number;
  autoAttemptedVersion?: string;
}

export type CheckStatus = "current" | "available" | "failed" | "disabled";

export interface CheckResult {
  status: CheckStatus;
  current: string;
  latest?: string;
  notes?: string;
  failure?: string;
  checkedAt?: number;
  fromCache?: boolean;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string, init?: {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<FetchResponse>;

export type SpawnLike = (command: string, args: string[], options?: {
  cwd?: string;
  stdio?: "inherit" | "ignore" | Array<"ignore" | number>;
  env?: NodeJS.ProcessEnv;
}) => Promise<number>;

export interface InstallPlan {
  kind: "npm" | "installer" | "manual";
  appDir?: string;
  wrapper?: string;
}

export interface InstallResult {
  kind: InstallPlan["kind"];
  installed: boolean;
  command?: string;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function updatePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = os.homedir(),
): UpdatePaths {
  const cacheOverride = env.ULTRAPLAN_CACHE_DIR?.trim();
  const configOverride = env.ULTRAPLAN_CONFIG_DIR?.trim();
  const cacheDir = cacheOverride
    ? path.resolve(cacheOverride)
    : platform === "win32"
      ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ultraplan", "cache")
      : platform === "darwin"
        ? path.join(home, "Library", "Caches", "ultraplan")
        : path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "ultraplan");
  const configDir = configOverride
    ? path.resolve(configOverride)
    : platform === "win32"
      ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "ultraplan")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support", "ultraplan")
        : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "ultraplan");
  return {
    cacheFile: path.join(cacheDir, "update-check.json"),
    configFile: path.join(configDir, "config.json"),
    logDir: path.join(configDir, "logs"),
  };
}

async function atomicWrite(
  file: string,
  content: string,
  mode = PRIVATE_FILE_MODE,
  privateDir = false,
): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: privateDir ? PRIVATE_DIR_MODE : 0o755 });
  if (privateDir) await fs.chmod(dir, PRIVATE_DIR_MODE);
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
  try {
    await fs.rename(temporary, file);
    await fs.chmod(file, mode);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function readConfig(paths: UpdatePaths): Promise<UpdateConfig> {
  const raw = await readJson(paths.configFile);
  const config: UpdateConfig = {};
  if (raw?.checkAutomatically === true || raw?.checkAutomatically === false) {
    config.checkAutomatically = raw.checkAutomatically;
  }
  if (raw?.autoInstall === true || raw?.autoInstall === false) config.autoInstall = raw.autoInstall;
  if (raw?.autoPrompted === true || raw?.autoPrompted === false) config.autoPrompted = raw.autoPrompted;
  if (typeof raw?.skipVersion === "string") config.skipVersion = parseVersion(raw.skipVersion);
  return config;
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, PRIVATE_FILE_MODE, true);
}

export async function updateConfig(paths: UpdatePaths, patch: UpdateConfig): Promise<UpdateConfig> {
  const next = { ...await readConfig(paths), ...patch };
  await writePrivateJson(paths.configFile, next);
  return next;
}

export async function readCache(paths: UpdatePaths): Promise<UpdateCache | undefined> {
  const raw = await readJson(paths.cacheFile);
  if (!raw || typeof raw.checkedAt !== "number" || !Number.isFinite(raw.checkedAt)) return undefined;
  const cache: UpdateCache = { checkedAt: raw.checkedAt };
  if (typeof raw.latest === "string") cache.latest = parseVersion(raw.latest);
  if (typeof raw.notes === "string") cache.notes = raw.notes;
  if (typeof raw.failure === "string") cache.failure = raw.failure;
  if (typeof raw.shownVersion === "string") cache.shownVersion = parseVersion(raw.shownVersion);
  if (typeof raw.shownAt === "number") cache.shownAt = raw.shownAt;
  if (typeof raw.autoAttemptedVersion === "string") cache.autoAttemptedVersion = parseVersion(raw.autoAttemptedVersion);
  if (Array.isArray(raw.assets)) {
    cache.assets = raw.assets.flatMap((asset): ReleaseAsset[] =>
      isRecord(asset) && typeof asset.name === "string" && typeof asset.url === "string"
        ? [{ name: asset.name, url: asset.url }]
        : [],
    );
  }
  return cache;
}

export async function writeCache(paths: UpdatePaths, cache: UpdateCache): Promise<void> {
  await writePrivateJson(paths.cacheFile, cache);
}

export function isOptedOut(env: NodeJS.ProcessEnv, config: UpdateConfig): boolean {
  return env.ULTRAPLAN_NO_UPDATE_CHECK === "1" || config.checkAutomatically === false;
}

/** Only stable x.y.z tags are versions. Drafts, prereleases and garbage are not. */
export function parseVersion(tag: string | undefined): string | undefined {
  if (typeof tag !== "string") return undefined;
  const match = VERSION_RE.exec(tag.trim());
  if (!match) return undefined;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`not stable versions: ${left}, ${right}`);
  const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
  const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

export function isNewer(candidate: string | undefined, current: string): boolean {
  const version = parseVersion(candidate);
  return version !== undefined && compareVersions(version, current) > 0;
}

export function failureCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

interface RepositoryData {
  name: string;
  version: string;
  owner: string;
  repo: string;
}

export async function packageInfo(
  manifestFile = fileURLToPath(new URL("../package.json", import.meta.url)),
): Promise<RepositoryData> {
  const manifest: unknown = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  if (!isRecord(manifest)) throw new Error("package metadata is not an object");
  const current = parseVersion(typeof manifest.version === "string" ? manifest.version : undefined);
  const source = isRecord(manifest.repository)
    ? manifest.repository.url
    : manifest.repository;
  const coordinates = typeof source === "string"
    ? /(?:github\.com[/:]|github:)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(source)
    : null;
  if (!current || !coordinates) throw new Error("package metadata has no stable version and GitHub repository");
  return {
    name: typeof manifest.name === "string" ? manifest.name : TOOL,
    version: current,
    owner: coordinates[1],
    repo: coordinates[2],
  };
}

interface ReleaseInfo {
  version?: string;
  notes?: string;
  assets: ReleaseAsset[];
}

function noteText(body: string): string {
  return body.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean)
    .slice(0, 8).join("\n").slice(0, 1_200);
}

/** A malformed or prerelease record is never treated as an upgrade. */
export function parseRelease(value: unknown): ReleaseInfo {
  if (!isRecord(value) || value.draft === true || value.prerelease === true) return { assets: [] };
  const version = parseVersion(typeof value.tag_name === "string" ? value.tag_name : undefined);
  const notes = typeof value.body === "string" ? noteText(value.body) : undefined;
  const assets = Array.isArray(value.assets)
    ? value.assets.flatMap((asset): ReleaseAsset[] =>
      isRecord(asset) && typeof asset.name === "string" && typeof asset.browser_download_url === "string"
        ? [{ name: asset.name, url: asset.browser_download_url }]
        : [],
    )
    : [];
  return { version, notes, assets };
}

export interface CheckDeps {
  env?: NodeJS.ProcessEnv;
  paths?: UpdatePaths;
  fetchImpl?: FetchLike;
  now?: () => number;
  manifestFile?: string;
  config?: UpdateConfig;
}

function resultFromCache(cache: UpdateCache, current: string): CheckResult {
  const base: CheckResult = { status: "current", current, checkedAt: cache.checkedAt, fromCache: true };
  if (cache.failure) return { ...base, status: "failed", failure: cache.failure };
  if (isNewer(cache.latest, current)) {
    return { ...base, status: "available", latest: parseVersion(cache.latest), notes: cache.notes };
  }
  return base;
}

export async function checkForUpdate(deps: CheckDeps = {}): Promise<CheckResult> {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? updatePaths(env);
  const manifestFile = deps.manifestFile;
  const info = await packageInfo(manifestFile);
  const current = info.version;
  const config = deps.config ?? await readConfig(paths);
  if (isOptedOut(env, config)) {
    return { status: "disabled", current, failure: "update checks are disabled" };
  }
  const now = deps.now?.() ?? Date.now();
  const cache = await readCache(paths);
  if (cache && now - cache.checkedAt < CHECK_INTERVAL_MS) return resultFromCache(cache, current);

  const fetcher = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetcher) {
    const failure = "no release-check client available";
    await writeCache(paths, { ...cache, checkedAt: now, failure, latest: undefined, assets: undefined });
    return { status: "failed", current, failure, checkedAt: now };
  }
  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/releases/latest`;
    const response = await fetcher(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `${TOOL}-update-check`,
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`release check returned HTTP ${response.status}`);
    const release = parseRelease(await response.json());
    const latest = isNewer(release.version, current) ? parseVersion(release.version) : undefined;
    const next: UpdateCache = {
      ...cache,
      checkedAt: now,
      latest,
      notes: latest ? release.notes : undefined,
      assets: latest ? release.assets : undefined,
      failure: undefined,
      autoAttemptedVersion: undefined,
    };
    await writeCache(paths, next);
    return {
      status: latest ? "available" : "current",
      current,
      latest,
      notes: latest ? release.notes : undefined,
      checkedAt: now,
    };
  } catch (error) {
    const failure = failureCause(error);
    await writeCache(paths, { ...cache, checkedAt: now, failure, latest: undefined, assets: undefined });
    return { status: "failed", current, failure, checkedAt: now };
  }
}

export function noticeText(current: string, latest: string, dim = false): string[] {
  const second = `turn on automatic updates: ${TOOL} update --auto on · skip: ${TOOL} update --skip`;
  return [
    `${TOOL} ${latest} available (you have ${current}) · run: ${TOOL} update`,
    dim ? `\x1b[2m${second}\x1b[0m` : second,
  ];
}

export function shouldNotice(
  env: NodeJS.ProcessEnv,
  config: UpdateConfig,
  cache: UpdateCache | undefined,
  current: string,
  now: number,
): boolean {
  if (!cache || isOptedOut(env, config)) return false;
  if (!isNewer(cache.latest, current) || config.skipVersion === cache.latest) return false;
  if (cache.shownVersion === cache.latest && now - (cache.shownAt ?? 0) < CHECK_INTERVAL_MS) return false;
  return true;
}

export async function markNoticeShown(paths: UpdatePaths, version: string, now = Date.now()): Promise<void> {
  const cache = await readCache(paths);
  if (!cache) return;
  await writeCache(paths, { ...cache, shownVersion: parseVersion(version), shownAt: now });
}

export function detectInstallKind(
  binPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = os.homedir(),
): InstallPlan {
  const normalized = path.resolve(binPath);
  const parts = normalized.split(path.sep);
  if (parts.includes("node_modules") && parts.includes("ultraplan")) return { kind: "npm" };
  const marker = `${path.sep}app${path.sep}release-`;
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) {
    const appDir = normalized.slice(0, index + `${path.sep}app`.length);
    const configured = env.ULTRAPLAN_BIN_DIR?.trim();
    const binDir = configured
      ? path.resolve(configured)
      : platform === "win32"
        ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "UltraPlan", "bin")
        : path.join(home, ".local", "bin");
    return { kind: "installer", appDir, wrapper: path.join(binDir, TOOL) };
  }
  return { kind: "manual" };
}

export function installCommand(plan: InstallPlan, version: string, owner: string, repo: string): string {
  const tag = parseVersion(version) ?? version;
  if (plan.kind === "npm") return `npm install --global github:${owner}/${repo}#v${tag}`;
  if (plan.kind === "installer") {
    return `curl -fsSL https://github.com/${owner}/${repo}/releases/download/v${tag}/install.sh | sh`;
  }
  return "see docs/updates.md for the command that matches your install";
}

export function checksumFor(sums: string, name: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+[*\s]?(.+)$/.exec(line.trim());
    if (match && match[2].trim().replace(/^\*/, "") === name) return match[1].toLowerCase();
  }
  return undefined;
}

export function verifyChecksum(sums: string, name: string, bytes: Uint8Array): boolean {
  const expected = checksumFor(sums, name);
  const actual = createHash("sha256").update(bytes).digest("hex");
  return expected !== undefined && expected === actual;
}

function releaseAssetUrl(url: string, owner: string, repo: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("release asset URL is not valid");
  }
  const prefix = `/${owner}/${repo}/releases/`;
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !parsed.pathname.startsWith(prefix)) {
    throw new Error("release asset URL is outside this repository's releases");
  }
  return parsed.href;
}

async function readWrapper(wrapper: string): Promise<{ text: string; mode: number } | undefined> {
  try {
    const stat = await fs.stat(wrapper);
    return { text: await fs.readFile(wrapper, "utf8"), mode: stat.mode & 0o777 };
  } catch {
    return undefined;
  }
}

function rewriteWrapper(text: string, target: string): string | undefined {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trimStart().startsWith("exec "));
  if (index < 0) return undefined;
  const next = lines[index].replace(
    /"[^"\n]*release-\d+\.\d+\.\d+[^"\n]*bin\/ut-todo"/,
    JSON.stringify(path.join(target, "bin", TOOL)),
  );
  if (next === lines[index]) return undefined;
  lines[index] = next;
  return lines.join("\n");
}

export interface SwapOptions {
  validate?: (directory: string) => Promise<void>;
}

/**
 * Install a verified release tree beside the current one. One previous release
 * and one previous wrapper are kept so `update --rollback` can restore them.
 */
export async function swapRelease(
  appDir: string,
  version: string,
  sourceDir: string,
  wrapper: string,
  options: SwapOptions = {},
): Promise<void> {
  const target = path.join(appDir, `release-${parseVersion(version) ?? version}`);
  const staged = `${target}.tmp`;
  const previous = path.join(appDir, "release-previous");
  const currentWrapper = await readWrapper(wrapper);
  const installed = currentWrapper?.text.match(RELEASE_DIR_RE)?.[0];
  await fs.mkdir(appDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.rm(staged, { recursive: true, force: true });
  await fs.cp(sourceDir, staged, { recursive: true, force: true });
  if (options.validate) await options.validate(staged);
  else if (!await exists(path.join(staged, "bin", TOOL))) {
    throw new Error("release archive has no bin/ut-todo; nothing was installed");
  }
  await fs.rm(previous, { recursive: true, force: true });
  const oldRelease = await exists(target) ? target : installed ? path.join(appDir, installed) : undefined;
  if (oldRelease && await exists(oldRelease)) await fs.rename(oldRelease, previous);
  await fs.rename(staged, target);

  if (!currentWrapper) return;
  await atomicWrite(`${wrapper}.previous`, currentWrapper.text, currentWrapper.mode || PUBLIC_EXEC_MODE);
  const updated = rewriteWrapper(currentWrapper.text, target);
  if (updated) await atomicWrite(wrapper, updated, currentWrapper.mode || PUBLIC_EXEC_MODE);
}

export async function rollbackRelease(appDir: string, wrapper: string): Promise<void> {
  const previous = path.join(appDir, "release-previous");
  if (!await exists(previous)) throw new Error("no previous release to roll back to");
  const currentWrapper = await readWrapper(wrapper);
  const backup = await readWrapper(`${wrapper}.previous`);
  const currentName = currentWrapper?.text.match(RELEASE_DIR_RE)?.[0];
  const originalName = backup?.text.match(RELEASE_DIR_RE)?.[0] ?? currentName;
  if (!currentName || !originalName) throw new Error("cannot locate the installed release");
  const current = path.join(appDir, currentName);
  const original = path.join(appDir, originalName);
  if (!await exists(current)) throw new Error("cannot locate the installed release");
  const staged = `${original}.rollback.tmp`;
  await fs.rm(staged, { recursive: true, force: true });
  await fs.rename(current, staged);
  await fs.rename(previous, original);
  await fs.rename(staged, previous);
  if (backup) await atomicWrite(wrapper, backup.text, backup.mode || PUBLIC_EXEC_MODE);
}

const defaultSpawn: SpawnLike = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options?.cwd,
    env: options?.env,
    stdio: options?.stdio ?? "inherit",
    windowsHide: true,
  });
  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 1));
});

export interface InstallDeps {
  version: string;
  binPath?: string;
  env?: NodeJS.ProcessEnv;
  paths?: UpdatePaths;
  fetchImpl?: FetchLike;
  spawnImpl?: SpawnLike;
  manifestFile?: string;
}

export async function installAvailable(deps: InstallDeps): Promise<InstallResult> {
  const env = deps.env ?? process.env;
  const info = await packageInfo(deps.manifestFile);
  const plan = detectInstallKind(deps.binPath ?? process.argv[1] ?? "", env);
  const command = installCommand(plan, deps.version, info.owner, info.repo);
  if (plan.kind === "manual") return { kind: "manual", installed: false, command };
  if (plan.kind === "npm") {
    const code = await (deps.spawnImpl ?? defaultSpawn)("npm", ["install", "--global", `github:${info.owner}/${info.repo}#v${parseVersion(deps.version) ?? deps.version}`]);
    if (code !== 0) throw new Error(`package install failed with exit code ${code}`);
    return { kind: "npm", installed: true, command };
  }

  const paths = deps.paths ?? updatePaths(env);
  const cache = await readCache(paths);
  const assets = cache?.latest === parseVersion(deps.version) ? cache?.assets ?? [] : [];
  const archive = assets.find((asset) => asset.name === "ultraplan.tar.gz");
  const sums = assets.find((asset) => asset.name === "SHA256SUMS");
  if (!archive || !sums) throw new Error("no checked release assets; run update --check first");
  const fetcher = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetcher) throw new Error("no release download client available");
  const headers = { "user-agent": `${TOOL}-update-install` };
  const [archiveResponse, sumsResponse] = await Promise.all([
    fetcher(releaseAssetUrl(archive.url, info.owner, info.repo), { headers }),
    fetcher(releaseAssetUrl(sums.url, info.owner, info.repo), { headers }),
  ]);
  if (!archiveResponse.ok || !sumsResponse.ok) {
    throw new Error(`release download failed (HTTP ${archiveResponse.status}/${sumsResponse.status})`);
  }
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  const checksums = await sumsResponse.text();
  if (!verifyChecksum(checksums, "ultraplan.tar.gz", bytes)) {
    throw new Error("checksum mismatch for ultraplan.tar.gz; nothing was installed");
  }

  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ultraplan-update-"));
  try {
    const archivePath = path.join(folder, "ultraplan.tar.gz");
    await fs.writeFile(archivePath, bytes, { mode: PRIVATE_FILE_MODE });
    const unpacked = path.join(folder, "package");
    await fs.mkdir(unpacked, { mode: PRIVATE_DIR_MODE });
    const code = await (deps.spawnImpl ?? defaultSpawn)("tar", ["-xzf", archivePath, "-C", unpacked, "--strip-components=1"], { stdio: "ignore" });
    if (code !== 0) throw new Error(`release archive could not be unpacked (exit ${code})`);
    await swapRelease(plan.appDir!, deps.version, unpacked, plan.wrapper!);
    return { kind: "installer", installed: true, command };
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

export interface AutoInstallDeps {
  version: string;
  binPath?: string;
  env?: NodeJS.ProcessEnv;
  paths?: UpdatePaths;
  spawnImpl?: SpawnLike;
}

/** Detached, low-priority install for the opt-in path; no output in this process. */
export async function startAutoInstall(deps: AutoInstallDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? updatePaths(env);
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const recordFailure = (error: unknown): Promise<void> => readCache(paths).then((cache) => writeCache(paths, {
    ...(cache ?? {}),
    checkedAt: Date.now(),
    failure: `automatic install failed: ${failureCause(error)}`,
  })).catch(() => {});
  const command = process.platform === "win32" ? process.execPath : "nice";
  const args = process.platform === "win32"
    ? [deps.binPath ?? process.argv[1] ?? "", "update", "--apply", deps.version]
    : ["-n", "10", process.execPath, deps.binPath ?? process.argv[1] ?? "", "update", "--apply", deps.version];
  let descriptor: number | undefined;
  try {
    await fs.mkdir(paths.logDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    descriptor = openSync(path.join(paths.logDir, "update.log"), "a", PRIVATE_FILE_MODE);
    void spawnImpl(command, args, {
      env: { ...env, ULTRAPLAN_UPDATE_APPLY: "1" },
      stdio: ["ignore", descriptor, descriptor],
    }).catch(recordFailure);
  } catch (error) {
    void recordFailure(error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
