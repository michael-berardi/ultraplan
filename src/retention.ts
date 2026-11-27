/**
 * UltraPlan local-data retention.
 *
 * This module is the single inventory of the local files UltraPlan writes
 * (LOCAL_WRITES, rendered in PRIVACY.md) and the sweep that keeps those paths
 * free of debris: staging files left by a crash, a plan lock left by a dead
 * writer, an expired check claim, a stale install lock, an old install log,
 * installer and wrapper staging, only the tool's own folders in the system temp
 * directory, and — once the replacing release has run a command (update
 * contract §4a), or at the latest seven days after the swap — the rollback copy
 * an update keeps.
 *
 * Rules the sweep obeys, so a cleanup can never become the incident:
 * - it never creates a directory, so an unused install stays untouched;
 * - it never removes a plan (`todo.json`, `TODO.md`), the update state or a
 *   live release: those are state, not debris;
 * - it never removes debris younger than that entry's stated lifetime;
 * - it only matches names this tool itself writes;
 * - it prints nothing and never throws: a failed cleanup must never fail the
 *   command that triggered it.
 *
 * Paths are passed in from the CLI, which takes them from the update module's
 * own `cacheDir` and `detectInstall` (src/update.js). This module imports
 * nothing from it, so the CLI can also load it from memory after stripping its
 * types (an npm global install under node_modules).
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
/** Contract §4a: a rollback copy lives at most this long, even with no successful run. */
export const ROLLBACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** The background install log is diagnostic only, so it is dropped after this long. */
export const INSTALL_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** An in-flight check claim is stale after the update module's 4 s timeout plus 10 s (CLAIM_STALE_MS). */
export const CHECK_CLAIM_MAX_MS = 14_000;
/** A stale update-install lock is reclaimed after the update module's 10-minute limit. */
export const INSTALL_LOCK_MAX_MS = 10 * 60 * 1_000;
/** Nothing the tool leaves in the system temp directory outlives this. */
export const TEMP_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/**
 * The only temp-directory names that belong to UltraPlan: `ut-todo update`'s
 * download folder (src/update.js), install.sh's `mktemp` folder and
 * install.ps1's GUID folder. Everything else in the temp directory is not ours.
 */
export const TEMP_DIR_PREFIXES = ["ut-todo-update-", "ultraplan-install.", "ultraplan-install-"] as const;
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

/** Derive the update module's cache layout from its resolved cache folder. */
export function localPaths(cacheDir: string): LocalPaths {
  const dir = path.resolve(cacheDir);
  return {
    cacheDir: dir,
    stateFile: path.join(dir, "update.json"),
    claimFile: path.join(dir, "update.claim"),
    logFile: path.join(dir, INSTALL_LOG_NAME),
    lockFile: path.join(dir, "update.lock"),
  };
}

/** An installer-managed copy, mapped by the CLI from the update module's `detectInstall`. */
export interface InstallPlan {
  kind: "installer" | "npm" | "manual";
  /** Installer home (`<home>/app` is the application folder). */
  home?: string;
  appDir?: string;
  binDir?: string;
  /** The command wrapper (`ut-todo`, or `ut-todo.cmd` on Windows); its text names the release in use. */
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
 * Every path UltraPlan writes, with its lifetime and what cleans it up.
 * PRIVACY.md renders this table; `test/retention.test.ts` keeps the two in
 * step, so a new local write cannot ship undocumented.
 */
export const LOCAL_WRITES: readonly LocalWrite[] = [
  {
    paths: [".steak-pi/todo/<sha256>/todo.json"],
    contents: "Phase names, task text, statuses and block reasons you wrote. No logs, no transcripts, no identifiers.",
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
    contents: "Empty marker: one CLI writer at a time for that plan.",
    lifetime: "One command; stale after 30 s.",
    cleanup: "The command that created it; a stale one is reclaimed by the next writer or removed by the sweep.",
  },
  {
    paths: [".steak-pi/todo/<sha256>/.<name>.<pid>.<uuid>.tmp"],
    contents: "A staged copy of todo.json or TODO.md, used to write atomically.",
    lifetime: "Milliseconds; renamed into place by the writer.",
    cleanup: "The writer's `finally`; a crash leftover is swept after 1 hour.",
  },
  {
    paths: ["<cache>/update.json"],
    contents: "Last check time and result (newest version or failure cause), the version last announced and when, a skipped version, your check and auto-install settings, and after an update the rollback record (both versions, the kept folder's path, the time). No id, no usage data.",
    lifetime: "Until the next check or settings change rewrites it; no expiry.",
    cleanup: "Yours to delete at any time; the next interactive check simply runs again.",
  },
  {
    paths: ["<cache>/update.json.<pid>.<hex>.tmp", "<cache>/update.log.<pid>.<hex>.tmp"],
    contents: "A staged copy of update.json or of the trimmed update.log, used to write atomically.",
    lifetime: "Milliseconds; renamed into place by the writer.",
    cleanup: "The writer's `finally`; a crash leftover is swept after 1 hour.",
  },
  {
    paths: ["<cache>/update.claim"],
    contents: "A random token marking a check in flight, so commands started together share one check.",
    lifetime: "One check; stale after 14 s (the 4 s timeout plus 10 s).",
    cleanup: "The check that owns it; an expired claim is replaced by the next check or removed by the sweep.",
  },
  {
    paths: ["<cache>/update.lock"],
    contents: "Empty marker: one update install at a time.",
    lifetime: "One install; stale after 10 minutes.",
    cleanup: "The install's `finally`; a leftover is replaced by the next install or removed by the sweep after 10 minutes.",
  },
  {
    paths: ["<cache>/update.log"],
    contents: "Written only when automatic updates are on: one timestamped line per background install (started, installed, or why it failed, with the installer's last output). Never plan text.",
    lifetime: "Newest 256 KB only; dropped after 7 days without a new line.",
    cleanup: "Trimmed on every write; removed by the sweep once its last line is 7 days old.",
  },
  {
    paths: ["<app>/release-<version>/"],
    contents: "The installed program: the files of the release archive.",
    lifetime: "Until an install of another version replaces it, or you uninstall.",
    cleanup: "The installer removes every release folder the wrapper no longer names; uninstalling removes the rest.",
  },
  {
    paths: ["<app>/release-<version>.previous"],
    contents: "The release that `ut-todo update` replaced, kept for `ut-todo update --rollback`.",
    lifetime: "Until the replacing release has run a command successfully, and at most 7 days.",
    cleanup: "`update --rollback` restores it; otherwise the update module's pruning or the sweep removes it.",
  },
  {
    paths: ["<app>/runtime/node-<version>-<os>-<arch>/"],
    contents: "The official Node.js build, downloaded only when no Node.js 22.19+ is installed.",
    lifetime: "Until you uninstall; a later Node download leaves older ones in place.",
    cleanup: "Yours: remove the folder (or the whole install folder) when no wrapper uses it.",
  },
  {
    paths: ["<app>/release-<version>.tmp", "<app>/runtime/node-<version>-<os>-<arch>.tmp"],
    contents: "A release or Node.js tree being unpacked and checked before it is renamed into place.",
    lifetime: "One install.",
    cleanup: "Renamed into place or removed by the installer; a crash leftover is swept after 1 hour.",
  },
  {
    paths: ["<app>/.staging-<guid>"],
    contents: "The PowerShell installer's unpack folder, inside the tool's own home.",
    lifetime: "One install.",
    cleanup: "The installer's `finally`; a crash leftover is swept after 1 hour.",
  },
  {
    paths: ["<bin>/ut-todo", "<bin>/ut-todo.cmd"],
    contents: "The command wrapper: the Node.js path and the release path it runs.",
    lifetime: "Until you uninstall.",
    cleanup: "Yours: delete it to uninstall. The installer never overwrites a file there it did not write.",
  },
  {
    paths: ["<bin>/ut-todo.tmp.<pid>", "<bin>/ut-todo.cmd.tmp", "<bin>/<wrapper>.<pid>.<hex>.tmp"],
    contents: "A command wrapper being written by an installer (or by `update --rollback`).",
    lifetime: "Milliseconds; renamed into place.",
    cleanup: "Renamed into place by its writer; a crash leftover is swept after 1 hour.",
  },
  {
    paths: ["<tmp>/ut-todo-update-*"],
    contents: "`ut-todo update`'s download of SHA256SUMS and the release installer.",
    lifetime: "One update.",
    cleanup: "The update's `finally`; a crash leftover is swept after 1 day.",
  },
  {
    paths: ["<tmp>/ultraplan-install.*", "<tmp>/ultraplan-install-<guid>"],
    contents: "An installer's download of the release archive, SHA256SUMS and, when needed, Node.js.",
    lifetime: "One install.",
    cleanup: "The installer's exit trap or `finally`; a crash leftover is swept after 1 day.",
  },
];

const STAGING_RE = /^\..+\.tmp$/;
const CACHE_STAGING_RE = /^update\.(?:json|log)\.\d+\.[0-9a-f]+\.tmp$/;
const PREVIOUS_RE = /^release-(\d+\.\d+\.\d+)\.previous$/;
/** The release a wrapper runs, in the shape both installers write (`.../release-<v>/bin/ut-todo`). */
const WRAPPER_RELEASE_RE = /release-(\d+\.\d+\.\d+)[\\/]bin[\\/]ut-todo/;

interface Entry {
  name: string;
  mtimeMs: number;
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

async function removeIfOlderThan(target: string, maxAgeMs: number, now: number): Promise<string[]> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.lstat(target)).mtimeMs;
  } catch {
    return [];
  }
  if (now - mtimeMs < maxAgeMs) return [];
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
    ...await removeStale(storeDir, (name) => STAGING_RE.test(name), STAGING_MAX_AGE_MS, now),
    ...await removeStale(storeDir, (name) => name === ".lock", STALE_LOCK_MS, now),
  ];
}

/** Staging files in the update cache, an expired claim, a stale install lock and an old log; never update.json. */
export async function sweepUpdateFiles(paths: LocalPaths, now = Date.now()): Promise<string[]> {
  return [
    ...await removeStale(paths.cacheDir, (name) => CACHE_STAGING_RE.test(name), STAGING_MAX_AGE_MS, now),
    ...await removeIfOlderThan(paths.claimFile, CHECK_CLAIM_MAX_MS, now),
    ...await removeIfOlderThan(paths.lockFile, INSTALL_LOCK_MAX_MS, now),
    ...await removeIfOlderThan(paths.logFile, INSTALL_LOG_MAX_AGE_MS, now),
  ];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Names a wrapper is staged under: install.sh `ut-todo.tmp.<pid>`, install.ps1
 * `<wrapper>.tmp` (`ut-todo.cmd.tmp` on Windows) and the update module's atomic
 * rewrite on rollback, `<wrapper>.<pid>.<hex>.tmp`.
 */
function wrapperStaging(wrapperName: string): (name: string) => boolean {
  const atomic = new RegExp(`^${escapeRegExp(wrapperName)}\\.\\d+\\.[0-9a-f]+\\.tmp$`);
  return (name) => name === `${wrapperName}.tmp` || name.startsWith(`${wrapperName}.tmp.`) || atomic.test(name);
}

/** Installer staging left by a crashed install or update, and the tool's own temp folders. */
export async function sweepInstallArea(
  plan: InstallPlan,
  now = Date.now(),
  tmpDir: string = os.tmpdir(),
): Promise<string[]> {
  const removed: string[] = [];
  if (plan.kind === "installer" && plan.appDir) {
    // Only staging goes: `.staging-<guid>`, `release-<version>.tmp` and a Node
    // download being unpacked. A live `release-<version>`, the rollback copy and
    // an unpacked runtime are state, not debris.
    removed.push(...await removeStale(
      plan.appDir,
      (name) => name.startsWith(".staging-") || name.endsWith(".tmp"),
      STAGING_MAX_AGE_MS,
      now,
    ));
    removed.push(...await removeStale(
      path.join(plan.appDir, "runtime"),
      (name) => name.startsWith("node-") && name.endsWith(".tmp"),
      STAGING_MAX_AGE_MS,
      now,
    ));
    if (plan.wrapper) {
      removed.push(...await removeStale(
        path.dirname(plan.wrapper),
        wrapperStaging(path.basename(plan.wrapper)),
        STAGING_MAX_AGE_MS,
        now,
      ));
    }
  }
  removed.push(...await removeStale(
    tmpDir,
    (name) => TEMP_DIR_PREFIXES.some((prefix) => name.startsWith(prefix)),
    TEMP_DIR_MAX_AGE_MS,
    now,
  ));
  return removed;
}

export type RollbackRetirement = "ran-successfully" | "expired" | "kept" | "absent";

export interface RollbackState {
  retirement: RollbackRetirement;
  /** Absolute paths this call removed. */
  removed: string[];
}

function isInside(dir: string, target: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Contract §4a for installer installs. `ut-todo update` runs the release's
 * installer with ULTRAPLAN_KEEP_PREVIOUS, which keeps the replaced release as
 * `<app>/release-<new>.previous`. The update module prunes that copy from its
 * record in update.json; this is the record-free backstop, so the copy still
 * goes when update.json was deleted. A copy is retired
 * - once release `<new>` has run a command successfully: the wrapper names
 *   `release-<new>` and this process runs from inside it (`ran-successfully`);
 * - or seven days after the swap, measured from the newer of the copy's and the
 *   wrapper's modification times (the installer rewrites the wrapper during the
 *   swap) (`expired`).
 *
 * Anything else is kept: a missing or foreign wrapper, a copy for a release the
 * wrapper does not name (until it expires), and a run from any other folder,
 * such as the update command itself running from the release it just replaced.
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
  const copies = await listEntries(options.appDir, (name) => PREVIOUS_RE.test(name));
  if (copies.length === 0) return { retirement: "absent", removed: [] };

  let wrapper: { text: string; mtimeMs: number } | undefined;
  try {
    wrapper = { text: await fs.readFile(options.wrapper, "utf8"), mtimeMs: (await fs.lstat(options.wrapper)).mtimeMs };
  } catch {
    return { retirement: "kept", removed: [] };
  }
  const named = WRAPPER_RELEASE_RE.exec(wrapper.text)?.[1];
  if (!named) return { retirement: "kept", removed: [] };
  const runningNamed = Boolean(options.selfPath
    && isInside(path.join(options.appDir, `release-${named}`), options.selfPath));

  let retirement: RollbackRetirement = "kept";
  const removed: string[] = [];
  for (const copy of copies) {
    const replacedBy = PREVIOUS_RE.exec(copy.name)?.[1];
    let reason: RollbackRetirement | undefined;
    if (runningNamed && replacedBy === named) reason = "ran-successfully";
    else if (now - Math.max(copy.mtimeMs, wrapper.mtimeMs) >= maxAgeMs) reason = "expired";
    if (!reason) continue;
    const target = path.join(options.appDir, copy.name);
    if (await remove(target)) {
      removed.push(target);
      retirement = reason;
    }
  }
  return { retirement, removed };
}

export interface SweepOptions {
  /** The plan folder this command used; only that one is swept here. */
  storeDir?: string;
  /** The file this process is running from; proves the wrapper's release has run. */
  selfPath?: string;
  /** Update cache paths; omitted when no update paths are known. */
  paths?: LocalPaths;
  /** Install shape; only `installer` touches the install and bin folders. */
  plan?: InstallPlan;
  env?: NodeJS.ProcessEnv;
  now?: number;
  tmpDir?: string;
}

export interface SweepReport {
  /** Absolute paths this sweep removed, in the order it removed them. */
  removed: string[];
  /** What happened to the rollback copy, when the install is installer-managed. */
  rollback?: RollbackRetirement;
}

export function cleanupDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ULTRAPLAN_NO_LOCAL_CLEANUP === "1";
}

/**
 * One best-effort pass over the debris paths in `LOCAL_WRITES`. The CLI awaits
 * it after a successful command, so it never runs inside one.
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
