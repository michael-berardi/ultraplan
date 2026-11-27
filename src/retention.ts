/**
 * UltraPlan local-data retention.
 *
 * UltraPlan writes a small, fixed set of local files. This module is the single
 * inventory of them (`LOCAL_WRITES`) and the sweep that keeps every one of
 * those paths free of debris: staging files left by a crash, a plan lock left
 * by a dead writer, an expired in-flight claim, an old install log, installer
 * and wrapper staging folders, only `ultraplan-update-*` and
 * `ultraplan-install.*` folders in the system temp directory, and — once the
 * replacing or restored release has run successfully (open-source update
 * contract §4a) or at the latest after seven days — the rollback copies a
 * swap keeps.
 *
 * Rules the sweep obeys, so a cleanup can never become the incident:
 * - it never creates a directory, so an unused install stays untouched;
 * - it never removes a plan (`todo.json`, `TODO.md`), the update cache or the
 *   config: those are live state, not debris;
 * - it never removes a file younger than that file's stated lifetime, so a
 *   live lock, a fresh claim or an install in progress is left alone;
 * - it only touches paths this tool owns;
 * - it prints nothing and never throws: a failed cleanup must never fail the
 *   command that triggered it.
 *
 * `ULTRAPLAN_NO_LOCAL_CLEANUP=1` skips the sweep entirely.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHECK_CLAIM_MAX_MS, type InstallPlan, type UpdatePaths } from "./update.ts";

/** Age after which staging debris (a `.tmp` or `.staging-*` left by a crash) goes. */
export const STAGING_MAX_AGE_MS = 60 * 60 * 1_000;
/** A plan-store lock is stale after this long, exactly like the CLI writer's own lock. */
export const STALE_LOCK_MS = 30_000;
/** Contract §4a: the rollback copies live at most this long, even with no successful run. */
export const ROLLBACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** The background install log is diagnostic only, so it is dropped after this long. */
export const INSTALL_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** Nothing the tool leaves in the system temp directory outlives this. */
export const TEMP_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** Only these temp-directory prefixes belong to UltraPlan; everything else is not ours. */
export const TEMP_DIR_PREFIXES = ["ultraplan-update-", "ultraplan-install."] as const;
/** The one install-log file name; it is capped by `capInstallLog` and aged out here. */
export const INSTALL_LOG_NAME = "update.log";

export interface LocalWrite {
  /** Path templates, relative to the project or to the tool's cache/config folder. */
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
    paths: ["<cache>/update-check.json"],
    contents: "The last release-check result: latest version, note text, timestamps, failure cause. No id, no install id, no usage data.",
    lifetime: "Until the next check replaces it (at most once a day); no expiry.",
    cleanup: "Yours to delete at any time; deleting it only makes the next interactive check run.",
  },
  {
    paths: ["<cache>/update-check.claim"],
    contents: "A random token marking a check in flight, so parallel commands reuse one check.",
    lifetime: "14 s: the check's 4 s timeout plus 10 s.",
    cleanup: "Removed by the check that owns it; an expired claim is reclaimed by the next check or this sweep.",
  },
  {
    paths: ["<config>/config.json"],
    contents: "Your update choices: automatic checks, automatic installs, skipped version, whether the auto-install question was answered.",
    lifetime: "Until you change it with `ut-todo update --auto`, `--skip`, or delete the file.",
    cleanup: "Yours; uninstalling removes it.",
  },
  {
    paths: ["<config>/logs/update.log"],
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
    cleanup: "Removed by the installer; a leftover from a crash is swept after 1 hour.",
  },
  {
    paths: ["<bin>/ut-todo.tmp.*"],
    contents: "A command wrapper staged during an install, written beside the live wrapper.",
    lifetime: "Milliseconds; renamed into place by the installer.",
    cleanup: "Renamed by the installer; a leftover from a crash is swept after 1 hour.",
  },
  {
    paths: ["<app>/release-previous", "<bin>/ut-todo.previous"],
    contents: "The release and command wrapper kept for `ut-todo update --rollback`.",
    lifetime: "Until the replacing release has run successfully once, and at most 7 days.",
    cleanup: "Removed automatically by this sweep after the new release's first successful run or after 7 days; `update --rollback` consumes it first.",
  },
  {
    paths: ["<tmp>/ultraplan-update-*", "<tmp>/ultraplan-install.*"],
    contents: "Downloaded archive, checksums and unpacked tree for one install.",
    lifetime: "The duration of one install.",
    cleanup: "Removed by the install's own `finally`; a leftover from a crash is swept after 1 day.",
  },
];

const STAGING_RE = /^\..+\.tmp$/;
const RELEASE_RE = /release-(\d+\.\d+\.\d+)/;

interface Entry {
  name: string;
  mtimeMs: number;
}

function stagingName(name: string): boolean {
  return STAGING_RE.test(name);
}

/**
 * Matching entries with their mtimes; a missing or unreadable directory is
 * empty. Only matching names are stat'ed: the system temp directory can hold
 * thousands of entries and this runs after every command.
 */
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

/** The update cache, its in-flight claim and the install log. */
export async function sweepUpdateFiles(paths: UpdatePaths, now = Date.now()): Promise<string[]> {
  return [
    ...await removeStale(path.dirname(paths.cacheFile), stagingName, STAGING_MAX_AGE_MS, now),
    ...await removeIfOlderThan(paths.claimFile, CHECK_CLAIM_MAX_MS, now),
    ...await removeIfOlderThan(path.join(paths.logDir, INSTALL_LOG_NAME), INSTALL_LOG_MAX_AGE_MS, now),
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
    // `release-previous` rollback copy are state, not debris.
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
  return RELEASE_RE.exec(text)?.[0];
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

/**
 * Contract §4a: the rollback copies of an installer-managed swap are debris
 * once the release they replaced has proved itself. They go when
 * - this process is running from the release the wrapper now names, and that
 *   release is not the one in `<wrapper>.previous` (`ran-successfully`),
 * - the wrapper was restored from the backup and this process is running from
 *   that restored release (`restored`),
 * - or they are seven days old (`expired`).
 *
 * Anything else is kept: an unreadable wrapper, a foreign wrapper, a copy whose
 * version cannot be attributed, or a first run that never completed.
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
  const previousDir = path.join(options.appDir, "release-previous");
  const backupPath = `${options.wrapper}.previous`;
  const current = await readText(options.wrapper);
  const backup = await readText(backupPath);
  const currentRelease = current ? releaseName(current.text) : undefined;
  const backupRelease = backup ? releaseName(backup.text) : undefined;
  const dirExists = (await mtimeOf(previousDir)) !== undefined;

  if (!backup && !dirExists) return { retirement: "absent", removed: [] };

  const newest = Math.max(
    ...[backup?.mtimeMs, await mtimeOf(previousDir), await mtimeOf(options.wrapper)]
      .filter((value): value is number => typeof value === "number"),
  );
  let retirement: RollbackRetirement | undefined;
  if (now - newest >= maxAgeMs) retirement = "expired";
  else if (currentRelease && backupRelease && currentRelease !== backupRelease
    && options.selfPath && isInside(path.join(options.appDir, currentRelease), options.selfPath)) {
    retirement = "ran-successfully";
  } else if (currentRelease && backupRelease && currentRelease === backupRelease
    && options.selfPath && isInside(path.join(options.appDir, currentRelease), options.selfPath)) {
    retirement = "restored";
  }

  if (!retirement) return { retirement: "kept", removed: [] };
  const removed: string[] = [];
  if (backup && await remove(backupPath)) removed.push(backupPath);
  if (dirExists && await remove(previousDir)) removed.push(previousDir);
  return { retirement, removed };
}

export interface SweepOptions {
  /** The plan folder this command used; only that one is swept here. */
  storeDir?: string;
  /** The file this process is running from; proves a swap's new release started. */
  selfPath?: string;
  /** Update cache, claim and log locations; omitted when no update paths are known. */
  paths?: UpdatePaths;
  /** Install shape from `detectInstallKind`; absent for npm, source and manual installs. */
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
