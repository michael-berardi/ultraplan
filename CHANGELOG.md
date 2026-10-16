# Changelog

All notable changes to UltraPlan are documented here. The project uses
[Semantic Versioning](https://semver.org/).

## 0.2.0 — 2026-10-16

- Renamed from UltraTerm Plan to UltraPlan. The repository is now
  `michael-berardi/ultraplan` (old links redirect), and the npm package and
  Claude Code plugin are named `ultraplan`. The `ut-todo` command, its store
  and its file format are unchanged. Install with
  `npm install --global github:michael-berardi/ultraplan#v0.2.0`.

## 0.1.2 — 2026-09-26

- `ut-todo` now works when installed under `node_modules`, including
  `npm install --global github:michael-berardi/ultraplan#v0.1.2`. Node
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
