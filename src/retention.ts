/**
 * UltraPlan local-data retention.
 *
 * This module is the single inventory of the local files UltraPlan writes
 * (LOCAL_WRITES) and the sweep that keeps every one of those paths free of
 * debris: staging files left by a crash, a plan lock left by a dead writer, an
 * expired check claim, a stale install lock, an old install log, installer and
 * wrapper staging folders, only the tool's own folders in the system temp
 * directory, and — once a replacing or restored release has run successfully
 * (open-source update contract §4a), or at the latest after seven days — the
 * rollback copies an installer swap keeps.
 *
 * Rules the sweep obeys, so a cleanup can never become the incident:
 * - it never creates a directory, so an unused install stays untouched;
 * - it never removes a plan (`todo.json`, `TODO.md`), the update cache or the
 *   settings: those are live state, not debris;
 * - it never removes a file younger than that file's stated lifetime;
 * - it only touches paths this tool owns;
 * - it prints nothing and never throws: a failed cleanup must never fail the
 *   command that triggered it.
 *
 * Paths are passed in from the CLI, which uses the main update module's own
 * `cacheDir` and `detectInstall`; this module has no dependency on the update
 * implementation so it also loads from the CLI's TypeScript loader.
 *
 * `ULTRAPLAN_NO_LOCAL_CLEANUP=1` skips the sweep entirely.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Age after which staging debris (a `.tmp` left by a crash) goes. */
export const STAGING_MAX_AGE_MS = 60 * 60 * 1_000;
/** A plan-store lock is stale after this long, exactly like the CLI writer's own lock. */
export const STALE_LOCK_MS = 30_000;
/** Contract §4a: rollback copies live at most this long, even with no successful run. */
export const ROLLBACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** The background install log is diagnostic only, so it is dropped after this long. */
export const INSTALL_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** An in-flight check claim is stale after the main module's 4 s timeout plus slack. */
export const CHECK_CLAIM_MAX_MS = 14_000;
/** A stale update-install lock is reclaimed after the main module's 10-minute limit. */
export const INSTALL_LOCK_MAX_MS = 10 * 60 * 1_000;
/** Nothing the tool leaves in the system temp directory outlives this. */
export const TEMP_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** Only these temp-directory prefixes belong to UltraPlan; everything else is not ours. */
export const TEMP_DIR_PREFIXES = ["ut-todo-update-", "ultraplan-update-", "ultraplan-install."] as const;
/** The one background install-log file name; it is capped by the update module. */
export const INSTALL_LOG_NAME = "update.log";

/** The cache paths of `src/update.js`, supplied by the CLI. */
export interface LocalPaths {
  cacheDir: string;
  stateFile: string;
  claimFile: string;
  logFile: string;
  lockFile: string;
}

/** Derive the main update module's cache layout from its resolved cache folder. */
export function localPaths(cacheDir: string): LocalPaths {
  const dir = path.resolve(cacheDir);
  return {
    cacheDir: dir,
    stateFile: path.join(dir, "update.json"),
    claimFile: path.join(dir, "update.claim"),
    logFile: path.join(dir, "update.log"),
    lockFile: path.join(dir, "update.lock"),
  };
}

/** The shape returned by the main update module's `detectInstall`. */
export interface InstallPlan {
  kind: "installer" | "npm" | "manual";
  /** Installer home (`<home>/app` is the application folder). */
  home?: string;
  appDir?: string;
  binDir?: string;
  /** The command wrapper; its text names the release currently in use. */
  wrapper?: string;
  hint?: string;
}

export interface LocalWrite {
  /** Path templates, relative to the project, cache, app, bin or temp folder. */
  paths: string[];
  /** What the file holds. */
  contents: string;
  /** How long it lives. */
  lifetime: string;
  /** What removes it. */
  cleanup: string;
}

/**
 * Every path UltraPlan writes, with its lifetime and what cleans it up. The
 * privacy document renders this table; `test/retention.test.ts` keeps the two
 * in step, so a new local write cannot ship undocumented.
 */
export const LOCAL_WRITES: readonly LocalWrite[] = [
  {
    paths: [".steak-pi/todo/<sha256>/todo.json"],
    contents: "Phase names, task text and block reasons you wrote. No logs, no transcripts, no identifiers.",
    lifetime: "Until you change or delete the plan.",
    cleanup: "Yours: remove the <sha256> folder, or `rm -rf .steak-pi/todo`. Nothing expires a plan.",
  },
  {
    paths: [".steak-pi/todo/<sha256>/TODO.md"],
    contents: "The rendered checklist, written from the same state just before the JSON.",
    lifetime: "Until you change or delete the plan.",
    cleanup: "Same as todo.json: only you delete a plan.",
  },
  {
    paths: [".steak-pi/todo/<sha256>/.lock"],
    contents: "Empty marker: one writer at a time for that plan.",
    lifetime: "The lifetime of one command; stale after 30 s.",
    cleanup: "Removed by the command that created it; a stale one is reclaimed after 30 s by the next writer or this sweep.",
  },
  {
    paths: [".steak-pi/todo/<sha256>/.<name>.<pid>.<uuid>.tmp"],
    contents: "A staged copy of todo.json or TODO.md, used to write atomically.",
    lifetime: "Milliseconds; renamed into place by the command that wrote it.",
    cleanup: "Removed in the writer's `finally`; a leftover from a crash is swept after 1 hour.",
  },
  {
    paths: ["<cache>/update.json"],
    contents: "The last check result and your settings: latest version, note text, timestamps, failure cause, skip, checks and auto-install choices. No id and no usage data.",
    lifetime: "Until the next check or settings change replaces it; no expiry.",
    cleanup: "Yours to delete at any time; deleting it only makes the next interactive check run.",
  },
  {
    paths: ["<cache>/update.json.<pid>.<hex>.tmp"],
    contents: "A staged copy of update.json, used to write atomically.",
    lifetime: "Milliseconds; renamed into place by the writer.",
    cleanup: "Removed in the writer's `finally`; a leftover from a crash is swept after 1 hour.",
  },
  {
    paths: ["<cache>/update.claim"],
    contents: "A random token marking a check in flight, so parallel commands reuse one check.",
    lifetime: "14 s: the check's 4 s timeout plus 10 s.",
    cleanup: "Removed by the check that owns it; an expired claim is reclaimed by the next check or this sweep.",
  },
  {
    paths: ["<cache>/update.lock"],
    contents: "A marker so only one update installs at a time.",
    lifetime: "The duration of one install; stale after 10 minutes.",
    cleanup: "Removed by the install's `finally`; a leftover from a dead update is swept after 10 minutes.",
  },
  {
    paths: ["<cache>/update.log"],
    contents: "Output of an opted-in background install. Never plan text.",
    lifetime: "Newest 256 KB only; dropped after 7 days.",
    cleanup: "Trimmed before and after every background install; removed by this sweep after 7 days.",
  },
  {
    paths: ["<app>/release-<version>.tmp", "<app>/release-<version>.rollback.tmp"],
    contents: "A verified release tree being staged or rolled back.",
    lifetime: "The duration of one install.",
    cleanup: "Renamed into place by the install; a leftover from a crash is swept after 1 hour.",
  },
  {
    paths: ["<app>/.staging-<guid>"],
    contents: "A Windows installer's download and unpack folder, inside the tool's own home.",
    lifetime: "The duration of one install.",
    cleanup: "The installer; a leftover from a crash is swept after 1 hour.",
  },
  {
    paths: ["<bin>/ut-todo.tmp.*"],
    contents: "A command wrapper staged during an install.",
    lifetime: "Milliseconds; renamed into place by the installer.",
    cleanup: "Renamed into place by the installer; a leftover from a crash is swept after 1 hour.",
  },
  {
    paths: ["<app>/release-<version>.previous"],
    contents: "The release kept for `ut-todo update --rollback`.",
    lifetime: "Until the replacing release has run successfully once, and at most 7 days.",
    cleanup: "The update's own cleanup or this sweep after a successful run / restore / 7 days, or `update --rollback` first.",
  },
  {
    paths: ["<tmp>/ut-todo-update-*", "<tmp>/ultraplan-update-*", "<tmp>/ultraplan-install.*"],
    contents: "Installer, checksums and unpacked tree for one install.",
    lifetime: "The duration of one install.",
    cleanup: "The install's `finally`; a leftover from a crash is swept after 1 day.",
  },
];

const STAGING_RE = /^\..+\.tmp$/;
const RELEASE_RE = /release-(\d+\.\d+\.\d+)/;
const PREVIOUS_RE = /^release-(\d+\.\d+\.\d+)\.previous$/;

interface Entry {
  name: string;
  mtimeMs: number;
}

function stagingName(name: string): boolean {
  return STAGING_RE.test(name);
}

/** Matching entries with their mtimes; a missing or unreadable directory is empty. */
async function listEntries(dir: string, match: (name: string) => boolean): Promise<Entry[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter(match);
  } catch {
    return [];
  }
  if (names.length === 0) return [];
  const entries = await Promise.all(names.map(async (name): Promise<Entry | undefined> => {
    try {
      const stats = await fs.lstat(path.join(dir, name));
      return { name, mtimeMs: stats.mtimeMs };
    } catch {
      return undefined;
    }
  }));
  return entries.filter((entry): entry is Entry => entry !== undefined);
}

async function remove(target: string): Promise<boolean> {
  try {
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function mtimeOf(target: string): Promise<number | undefined> {
  try {
    return (await fs.lstat(target)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function removeIfOlderThan(target: string, maxAgeMs: number, now: number): Promise<string[]> {
  const mtimeMs = await mtimeOf(target);
  if (mtimeMs === undefined || now - mtimeMs < maxAgeMs) return [];
  return await remove(target) ? [target] : [];
}

/** Remove matching entries older than `maxAgeMs`; newer ones are live and stay. */
async function removeStale(
  dir: string,
  match: (name: string) => boolean,
  maxAgeMs: number,
  now: number,
): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await listEntries(dir, match)) {
    if (now - entry.mtimeMs < maxAgeMs) continue;
    const target = path.join(dir, entry.name);
    if (await remove(target)) removed.push(target);
  }
  return removed;
}

/** Staging files and a stale lock inside one plan folder; never the plan itself. */
export async function sweepPlanStore(storeDir: string, now = Date.now()): Promise<string[]> {
  return [
    ...await removeStale(storeDir, stagingName, STAGING_MAX_AGE_MS, now),
    ...await removeStale(storeDir, (name) => name === ".lock", STALE_LOCK_MS, now),
  ];
}

/** The update cache, its in-flight claim, install lock and log. */
const UPDATE_CACHE_TMP_RE = /^update\.json\.\d+\.[0-9a-f]+\.tmp$/;

export async function sweepUpdateFiles(paths: LocalPaths, now = Date.now()): Promise<string[]> {
  return [
    ...await removeStale(paths.cacheDir, (name) => UPDATE_CACHE_TMP_RE.test(name), STAGING_MAX_AGE_MS, now),
    ...await removeIfOlderThan(paths.claimFile, CHECK_CLAIM_MAX_MS, now),
    ...await removeIfOlderThan(paths.lockFile, INSTALL_LOCK_MAX_MS, now),
    ...await removeIfOlderThan(paths.logFile, INSTALL_LOG_MAX_AGE_MS, now),
  ];
}

/** Installer staging left by a crashed install or update, and temp unpack folders. */
export async function sweepInstallArea(
  plan: InstallPlan,
  now = Date.now(),
  tmpDir: string = os.tmpdir(),
): Promise<string[]> {
  const removed: string[] = [];
  if (plan.kind === "installer" && plan.appDir) {
    // Only staging goes: `.staging-<guid>`, `release-<version>.tmp` and
    // `release-<version>.rollback.tmp`. A live `release-<version>` and the
    // rollback copy are state, not debris.
    removed.push(...await removeStale(
      plan.appDir,
      (name) => name.startsWith(".staging-") || name.endsWith(".tmp"),
      STAGING_MAX_AGE_MS,
      now,
    ));
    const wrapper = plan.wrapper;
    if (wrapper) {
      const wrapperStage = `${path.basename(wrapper)}.tmp.`;
      removed.push(...await removeStale(
        path.dirname(wrapper),
        (name) => name.startsWith(wrapperStage),
        STAGING_MAX_AGE_MS,
        now,
      ));
    }
  }
  for (const prefix of TEMP_DIR_PREFIXES) {
    removed.push(...await removeStale(tmpDir, (name) => name.startsWith(prefix), TEMP_DIR_MAX_AGE_MS, now));
  }
  return removed;
}

export type RollbackRetirement = "ran-successfully" | "expired" | "restored" | "kept" | "absent";

export interface RollbackState {
  retirement: RollbackRetirement;
  /** Absolute paths this call removed. */
  removed: string[];
}

function releaseName(text: string): string | undefined {
  return RELEASE_RE.exec(text)?.[1];
}

async function readText(file: string): Promise<{ text: string; mtimeMs: number } | undefined> {
  try {
    const text = await fs.readFile(file, "utf8");
    return { text, mtimeMs: (await fs.lstat(file)).mtimeMs };
  } catch {
    return undefined;
  }
}

function isInside(dir: string, target: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

interface Copy {
  target: string;
  version?: string;
  mtimeMs: number;
}

/**
 * Contract §4a: the rollback copies of an installer-managed swap are debris
 * once the release they replaced has proved itself. Main's installer keeps
 * `<app>/release-<version>.previous`; older copies keep a generic
 * `release-previous` with a `<wrapper>.previous` backup. Both are retired when
 * - this process is running from the release the wrapper now names and that
 *   release is not the kept one (`ran-successfully`),
 * - the wrapper was restored from the backup and this process is running from
 *   that restored release (`restored`),
 * - or the copies are seven days old (`expired`).
 *
 * Anything else is kept: an unreadable or foreign wrapper, a copy whose version
 * cannot be attributed, or a first run that never completed.
 */
export async function retireRollbackCopies(options: {
  appDir: string;
  wrapper: string;
  selfPath?: string;
  now?: number;
  maxAgeMs?: number;
}): Promise<RollbackState> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? ROLLBACK_MAX_AGE_MS;
  const wrapperText = await readText(options.wrapper);
  const backupFile = `${options.wrapper}.previous`;
  const backupText = await readText(backupFile);
  const currentRelease = wrapperText ? releaseName(wrapperText.text) : undefined;
  const backupRelease = backupText ? releaseName(backupText.text) : undefined;

  const copies: Copy[] = [];
  await Promise.all([
    (async () => {
      for (const entry of await listEntries(options.appDir, (name) => PREVIOUS_RE.test(name) || name === "release-previous")) {
        copies.push({
          target: path.join(options.appDir, entry.name),
          version: PREVIOUS_RE.exec(entry.name)?.[1] ?? backupRelease,
          mtimeMs: entry.mtimeMs,
        });
      }
    })(),
    (async () => {
      if (backupText) copies.push({ target: backupFile, version: backupRelease, mtimeMs: backupText.mtimeMs });
    })(),
  ]);
  if (copies.length === 0) return { retirement: "absent", removed: [] };

  const newest = Math.max(
    ...copies.map((copy) => copy.mtimeMs),
    ...[wrapperText?.mtimeMs].filter((value): value is number => typeof value === "number"),
  );
  let retirement: RollbackRetirement | undefined;
  const runningCurrent = Boolean(currentRelease && options.selfPath
    && isInside(path.join(options.appDir, `release-${currentRelease}`), options.selfPath));
  if (now - newest >= maxAgeMs) retirement = "expired";
  else if (runningCurrent && copies.some((copy) => copy.version && copy.version === currentRelease)) retirement = "restored";
  else if (runningCurrent && copies.some((copy) => copy.version && copy.version !== currentRelease)) retirement = "ran-successfully";

  if (!retirement) return { retirement: "kept", removed: [] };
  // Keep the historical order: wrapper backup first, then release copies.
  const rank = (copy: Copy) => copy.target === backupFile ? 0 : 1;
  copies.sort((left, right) => rank(left) - rank(right));
  const removed: string[] = [];
  for (const copy of copies) if (await remove(copy.target)) removed.push(copy.target);
  return { retirement, removed };
}

export interface SweepOptions {
  /** The plan folder this command used; only that one is swept here. */
  storeDir?: string;
  /** The file this process is running from; proves a swap's new release started. */
  selfPath?: string;
  /** Update cache paths; omitted when no update paths are known. */
  paths?: LocalPaths;
  /** Install shape from `detectInstall`; absent for npm, source and manual installs. */
  plan?: InstallPlan;
  env?: NodeJS.ProcessEnv;
  now?: number;
  tmpDir?: string;
}

export interface SweepReport {
  /** Absolute paths this sweep removed, in the order it removed them. */
  removed: string[];
  /** What happened to the rollback copies, when there were any. */
  rollback?: RollbackRetirement;
}

export function cleanupDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ULTRAPLAN_NO_LOCAL_CLEANUP === "1";
}

/**
 * One best-effort pass over every path in `LOCAL_WRITES`. Called after a
 * successful command, never during one, and never awaited by it.
 */
export async function sweepLocalData(options: SweepOptions = {}): Promise<SweepReport> {
  const now = options.now ?? Date.now();
  if (cleanupDisabled(options.env)) return { removed: [] };
  const removed: string[] = [];
  const step = async (work: () => Promise<string[]>): Promise<void> => {
    try {
      removed.push(...await work());
    } catch {
      // A cleanup that fails must never fail the command that triggered it.
    }
  };
  if (options.storeDir) await step(() => sweepPlanStore(options.storeDir!, now));
  if (options.paths) await step(() => sweepUpdateFiles(options.paths!, now));
  if (options.plan) await step(() => sweepInstallArea(options.plan!, now, options.tmpDir));
  let rollback: RollbackRetirement | undefined;
  if (options.plan?.kind === "installer" && options.plan.appDir && options.plan.wrapper) {
    try {
      const state = await retireRollbackCopies({
        appDir: options.plan.appDir,
        wrapper: options.plan.wrapper,
        selfPath: options.selfPath,
        now,
      });
      removed.push(...state.removed);
      rollback = state.retirement;
    } catch {
      // Same rule as above: keep the command's result, not the cleanup's.
    }
  }
  return rollback ? { removed, rollback } : { removed };
}
