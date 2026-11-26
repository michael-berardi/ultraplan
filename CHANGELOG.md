# Changelog

All notable changes to UltraPlan are documented here. The project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Documentation

- Recorded the contract §4a rollback gap in `docs/updates.md`: `release-previous` and the `.previous` wrapper are retained indefinitely with no first-run or seven-day cleanup and must be removed manually; `update --auto off` disables automatic installs but does not delete the rollback copies. No update behavior changed.
- Confirmed that `v0.5.2` is a published GitHub release and pinned the README's npm example to it. The pending branch changes are numbered `0.5.3`; no README install command points at an unpublished tag.

## 0.5.3 — 2026-11-26

- Automatic release checks no longer run inside the CLI process: a detached,
  unref'd, low-priority child performs the one anonymous GET, so a command
  never waits out the 4 s timeout. POSIX uses `nice -n 10` with a plain-runtime
  fallback; Windows uses the detached hidden runtime.
- An owner-only, atomic in-flight claim makes rapid invocations reuse one
  check; orphaned claims expire shortly after the timeout. Notices and opted-in
  installs now come from the cached result on the next interactive command.
- Kept opt-in auto-install detached, verified (SHA-256 + rollback) and the
  single install log capped at its newest 256 KB.

## 0.5.2 — 2026-11-26 (published)

Already published as [`v0.5.2`](https://github.com/michael-berardi/ultraplan/releases/tag/v0.5.2).
That release contains:

- `ut-todo --version` and `ut-todo version` print `ut-todo <version>` from the
  shipped `package.json` and exit 0; both previously failed with `unknown op`.
  `--help` and the README list them.
- Commands started together share one daily update check: the first writes a
  0600 `update.claim` file in the update cache folder and the rest reuse the
  cached result. The claim is removed when the check ends, including on a
  failing command, and a claim left by a dead process is replaced after 14 s.

## 0.5.1 — 2026-11-26

- Opt-in automatic installs now spawn a truly detached, unref'd child, so the
  command that triggered the check exits immediately. POSIX uses `nice -n 10`
  with a plain-runtime fallback; Windows uses the detached runtime (no `nice`
  equivalent). Verified swapping, one rollback and failure reporting are kept.
- Background install logs are one owner-only file capped at the newest 256 KB,
  before launch and after the child install. Documentation and the Claude Code
  plugin version match the package version.

## 0.5.0 — 2026-11-26

- Added the v1 update contract: one anonymous, at-most-daily release check in
  interactive use with a 4 s timeout, opt-out by `ULTRAPLAN_NO_UPDATE_CHECK=1`
  or config, and no checks in CI, non-TTY or agent mode.
- `ut-todo update --check|--skip|--auto on|off|status|--rollback` and a
  non-modal stderr notice after commands; automatic install is opt-in,
  stored in config and applied on the next run.
- Installer updates verify `SHA256SUMS`, stage the release and keep one
  rollback; npm-global installs use the package manager's upgrade command.
  Failures are cached with their cause and reported by `--check`.
- Added `docs/updates.md` with the `update-contract: v1` marker, a README
  Updates/Privacy section, offline tests and aligned plugin metadata.

## 0.4.3 — 2026-11-26

- Privacy: the CLI and Pi extension now create the plan store with 0700
  directories and 0600 files, and tighten stores written by older versions.
- Both installers set `DO_NOT_TRACK=1` for the processes they invoke (and
  restore the caller's value on Windows). The test runner does the same.
- Added a README Privacy section and a privacy test that blocks network APIs
  during CLI runs and fails if telemetry code or endpoints are reintroduced.

## 0.4.2 — 2026-11-12

- Windows installer fix: adding the bin folder to your user Path no longer
  turns entries such as `%USERPROFILE%\AppData\Local\Microsoft\WindowsApps`
  into fixed, expanded text, and keeps the Path value expandable. The folder is
  recognised as already present whether it is listed literally or through a
  variable. The installer's helper functions now live inside one function, so
  `irm | iex` leaves nothing in your session. Linux and macOS: the fallback
  health check works when your home folder path contains a space.

## 0.4.1 — 2026-11-11

- Installer fixes (no change to `ut-todo` itself). Windows: the `ut-todo.cmd`
  shim no longer breaks when your user name has non-ASCII letters (it uses
  paths relative to the shim, or the console code page for a custom bin
  folder); the release is unpacked inside UltraPlan's own folder, so installs
  work when `%TEMP%` is on another drive; stderr output from Node no longer
  aborts the install on Windows PowerShell 5.1; a relative or slash-style
  `ULTRAPLAN_HOME` no longer deletes the release just installed; the script
  runs inside a function so `irm | iex` leaves no variables or error
  preference in your session. macOS, Linux and Windows: the installer never
  overwrites an existing `ut-todo` it did not write (it says so and leaves it),
  and the wrapper pins the absolute path of the Node it verified.

## 0.4.0 — 2026-11-11

- One-step installers. `scripts/install.sh` (macOS and Linux) and
  `scripts/install.ps1` (Windows) download the release archive, verify its
  SHA-256, install under `~/.ultraplan` (Windows `%LOCALAPPDATA%\UltraPlan`)
  and put `ut-todo` on your PATH. They use the Node 22.19+ already on the
  machine or fetch the official Node into the tool's own folder, checksum
  verified. Re-running upgrades in place; no sudo, no shell profile edits.
  `scripts/build-release.sh` builds the release assets (archive, installers,
  SHA256SUMS) deterministically, and `scripts/test-install.sh` tests the
  installers on macOS, in an Ubuntu container and under PowerShell 7.

## 0.3.0 — 2026-11-01

- Shipped files name no person. Badges and install commands use a
  `your-github-username` placeholder (replace it with this repository's GitHub
  owner), SECURITY.md and CONTRIBUTING.md point at this repository's own
  Security tab and issues, and the Claude Code plugin manifest credits the
  copyright holder. The LICENSE and package.json's author and registry fields
  are legal metadata and are unchanged.
- `test/neutrality.test.ts` fails the suite when a shipped file names a person
  or a concrete model id or provider route. The `ut-todo` command, its
  `.steak-pi/todo/` store and its file format are unchanged.

## 0.2.0 — 2026-10-16

- Renamed from UltraTerm Plan to UltraPlan. The repository is now
  `your-github-username/ultraplan` (old links redirect), and the npm package
  and Claude Code plugin are named `ultraplan`. The `ut-todo` command, its
  store and its file format are unchanged. Install with
  `npm install --global github:your-github-username/ultraplan#v0.2.0`.

## 0.1.2 — 2026-09-26

- `ut-todo` now works when installed under `node_modules`, including
  `npm install --global github:your-github-username/ultraplan#v0.1.2`. Node
  refuses to strip TypeScript types inside `node_modules`, so the CLI strips
  its dependency-free core explicitly in that case. A regression test covers it.

## 0.1.1 — 2026-09-26

Tag only. Its README advertised a global install that failed with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`; use 0.1.2.

- Package metadata points at this repository; the published file set now
  includes the README and license.
- A fresh clone can run the checks: development dependencies and a lockfile
  are declared, so `npm install && npm run typecheck && npm test` works.
- Added CONTRIBUTING.md, SECURITY.md and a `.gitignore`.

## 0.1.0 — 2026-09-24

Initial packaged release, extracted unchanged from Steak Pi's todo feature:

- `src/core.ts` — the pure phased task state machine (moved from Steak Pi's
  `src/todo-core.ts`): ordered phases, single active task with auto-promotion,
  atomic bulk transitions, idempotent re-init that preserves recorded progress,
  honest blocked states. No imports, no I/O.
- `src/render.ts` — the native Pi pinned-panel renderer (moved from Steak Pi's
  `src/todo-render.ts`).
- `pi/extension.ts` — the Pi tool, persistence, maintenance guidance and pinned
  panel (moved from Steak Pi's `extensions/todo.ts`), with Steak Pi's own
  pinned-panel compositor and session-file canonicalizer injected as deps.
- `bin/ut-todo` — a shell CLI for any agent: `init/start/done/drop/block/
  unblock/rm/append/view/json`, byte-identical output to the Pi tool, same
  `.steak-pi/todo/<hash>` store.
- `integrations/` — a minimal Claude Code plugin (plugin.json, skill, bin
  link) and a copy-paste `AGENTS.md` snippet for Codex, Gemini CLI, OpenCode,
  Cursor and any other AGENTS.md-reading agent.
