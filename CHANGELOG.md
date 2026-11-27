# Changelog

All notable changes to UltraPlan are documented here. The project uses
[Semantic Versioning](https://semver.org/).

## 0.5.4 — 2026-11-26

- Added [PRIVACY.md](PRIVACY.md): the complete inventory of every local write,
  what it holds, how long it lives and what removes it. The README Privacy
  section is a short summary that links to it; SECURITY.md and
  `docs/updates.md` describe the same anonymous daily update check and its
  opt-outs (`UT_TODO_NO_UPDATE_CHECK=1` or `ut-todo update --auto-check off`).
- Added a silent local-data retention pass after successful commands: crash
  staging (1 hour), stale plan locks (30 s), expired check claims (14 s), old
  install logs (7 days), installer/wrapper staging (1 hour), and only the
  tool's own temp folders (1 day). Plans, the update cache and your settings
  are never touched; `ULTRAPLAN_NO_LOCAL_CLEANUP=1` skips the pass.
- Closed the rollback-copy gap for installer swaps: the kept previous release
  is retired after the replacing release has run successfully once, after a
  restored release has itself run, or after seven days, whichever comes first.
  A copy whose version cannot be attributed is still retired after seven days.
- Aligned the package, lockfile, Claude Code plugin metadata and README install
  example with version 0.5.4.

## 0.5.2 — 2026-11-26

- `ut-todo --version` and `ut-todo version` print `ut-todo <version>` (read
  from the installed `package.json`) and exit 0. Before, both failed with
  `unknown op`. `ut-todo --help` and the README list them.
- Commands started at the same time now share one daily update check instead
  of each sending a request. The first one marks the check in flight with a
  0600 `update.claim` file in the update cache folder; the others use the
  cached result. The file is removed when the check ends, also when the
  command fails, and a claim left by a process that died is replaced after
  14 seconds.

## 0.5.1 — 2026-11-26

- Privacy: the CLI and Pi extension now create the plan store with 0700
  directories and 0600 files, and tighten stores written by older versions.
- Both installers set `DO_NOT_TRACK=1` for the processes they start (and
  restore the caller's value on Windows). The test runner does the same.
- A privacy test runs the CLI with every network API blocked, checks the store's
  file modes, fails if telemetry code or endpoints are added, and allows network
  code only in the update module, which may reach only GitHub.
- README: a short Privacy section; the detail (what is stored, for how long,
  what goes over the network) is in `PRIVACY.md`.
- Update notices. On a terminal, `ut-todo` checks once a day for a newer
  release (one anonymous request to the public GitHub release record) and
  prints a two-line notice on stderr after your command. It stays silent in
  `json` output, pipes, CI and agent shells, and with
  `UT_TODO_NO_UPDATE_CHECK=1` or `ut-todo update --auto-check off`.
- `ut-todo update` installs the new release. Installer installs download the
  release's installer, check it against `SHA256SUMS` and run it; the installer
  checks the archive and keeps the replaced release for `ut-todo update
  --rollback` until the new one has run once (7 days at most). npm global
  installs run npm; source checkouts get the `git pull` command.
- `ut-todo update --check` (exit 0, 10 or 1), `--skip` and `--auto on|off|status`.
  Automatic updates are off by default. Update state is one 0600 file in the
  platform cache folder, plus a log under 256 KB only after an automatic
  install; see `docs/updates.md` and `PRIVACY.md`.
- Installers: `ULTRAPLAN_KEEP_PREVIOUS` (set by `ut-todo update`) keeps the
  replaced release as the single rollback copy.

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
