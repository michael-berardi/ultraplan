/** Types for src/update.js (plain JavaScript so the CLI loads it without type stripping). */
type Env = Record<string, string | undefined>;
type Stream = { isTTY?: boolean };
type Fetch = typeof globalThis.fetch;

export const TOOL: "ut-todo";
export const DAY_MS: number;
export const CHECK_TIMEOUT_MS: number;
export const MAX_LOG_BYTES: number;
export const ROLLBACK_MAX_AGE_MS: number;
export const CLAIM_STALE_MS: number;
export const CURRENT: string;
export const UPDATE_USAGE: string;

export interface UpdateState {
  checkedAt: number;
  latest?: string;
  error?: string;
  skip?: string;
  shown?: string;
  shownAt: number;
  checks: boolean;
  auto: boolean;
  autoAsked: boolean;
  autoFailed?: string;
  rollback?: { version: string; from: string; path: string; at: number };
}

export type Install =
  | { kind: "script"; home: string; binDir: string; shim: string }
  | { kind: "npm" }
  | { kind: "manual"; hint: string };

export function repository(manifest?: object): string | undefined;
export function parseVersion(text: unknown): number[] | undefined;
export function isNewer(candidate: unknown, current: unknown): boolean;
export function cacheDir(env?: Env): string;
export function statePath(env?: Env): string;
export function logPath(env?: Env): string;
export function claimPath(env?: Env): string;
export function readState(file: string): UpdateState;
export function writeState(file: string, state: Partial<UpdateState>): Partial<UpdateState>;
export function updateState(file: string, patch: Partial<UpdateState>): UpdateState;
export function appendLog(file: string, text: string, maxBytes?: number): void;
export function quietReason(env: Env, streams: { stdout?: Stream; stderr?: Stream }, state: Partial<UpdateState>): string | undefined;
export function checkUrl(env?: Env): string;
export function fetchLatest(options: { url: string; fetchImpl?: Fetch; timeoutMs?: number }):
  Promise<{ version?: string; notes?: string; error?: string }>;
export function refresh(options?: { env?: Env; fetchImpl?: Fetch; now?: number }):
  Promise<{ version?: string; notes?: string; error?: string; state: UpdateState }>;
export function dueNotice(state: UpdateState, current?: string, now?: number): string | undefined;
export function passiveCheck(options?: {
  env?: Env; streams?: { stdout?: Stream; stderr?: Stream }; fetchImpl?: Fetch; now?: number; current?: string;
}): Promise<{ version: string; state: UpdateState } | undefined>;
export function noticeLines(version: string, current?: string, options?: { dim?: boolean }): [string, string];
export function afterCommand(
  pending: Promise<{ version: string; state: UpdateState } | undefined> | undefined,
  options?: { env?: Env; stderr?: { write(text: string): unknown }; binPath?: string; now?: number; current?: string },
): Promise<void>;
export function startBackgroundInstall(options: { env?: Env; binPath: string }): unknown;
export function detectInstall(options?: { root?: string; env?: Env; current?: string }): Install;
export function npmCommand(version: string, repo?: string): [string, string[]];
export function checksumFor(sums: string, name: string): string | undefined;
export function installVersion(options: {
  version: string; install: Install; env?: Env; fetchImpl?: Fetch; current?: string; tmpRoot?: string; quiet?: boolean;
}): Promise<{ previous?: string }>;
export function rollback(options?: { env?: Env; install?: Install; now?: number }): NonNullable<UpdateState["rollback"]>;
export function pruneRollback(options?: { env?: Env; current?: string; now?: number }): void;
export function notesHead(notes: unknown, maxLines?: number): string;
export function ask(
  question: string, defaultYes: boolean, streams?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream },
): Promise<boolean>;
export function updateCommand(argv: string[], io?: {
  env?: Env;
  stdin?: NodeJS.ReadableStream & Stream;
  stdout?: { write(text: string): unknown };
  stderr?: NodeJS.WritableStream & Stream;
  fetchImpl?: Fetch;
  install?: Install;
  now?: number;
  current?: string;
}): Promise<number>;
