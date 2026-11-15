# UltraPlan

Phased task tracking for coding agents and people reviewing their work.
`ut-todo` keeps progress in local JSON and Markdown, outside the agent's
context window. Tasks advance only when you record a change.

The CLI needs Node.js 22.19+ and has no runtime dependencies or build step.
The optional Pi UI uses peer dependencies supplied by its host.

## Install

Download and extract this repository's source archive from GitHub, or clone
it. From the extracted repository directory, with Node.js 22.19+ installed:

```sh
npm install --global .
ut-todo --help
```

Use an npm prefix you can write to. npm links this directory, so keep it
in place while installed. To try it without installing, run
`node bin/ut-todo --help` from the repository directory.

### Release installers

The release assets include `install.sh` (macOS/Linux) and `install.ps1`
(Windows PowerShell 5.1 or 7). Download the appropriate installer from this
repository's Releases page, inspect it, then run `sh install.sh` or
`powershell -NoProfile -File .\install.ps1` from its download directory.
These installers download the release archive and check its SHA-256. They
use an existing Node.js 22.19+ or download Node into the tool's folder.

The shell installer creates a command wrapper in the user's local bin
folder. If that folder is not on PATH, follow the printed instruction;
it does not edit shell profiles. The Windows installer adds its bin folder
to the user Path; open a new shell afterward. Existing commands not owned
by the installer are left alone.

Run the same installer again to update. To uninstall, delete the tool's
install folder and its command wrapper; on Windows also remove the bin
folder from the user Path. For npm installs, use `npm uninstall --global ultraplan`.
See [the shell installer](scripts/install.sh) and
[PowerShell installer](scripts/install.ps1) for install-location overrides.

## First plan

Run these commands from your project directory:

```sh
ut-todo init 'Inspect:read code,map callers' 'Build:edit,test'
ut-todo done read
ut-todo block test --reason 'flaky upstream'
ut-todo json '{"op":"done","items":["map callers","edit"]}'
ut-todo view
```

The final checklist is:

```text
1. Inspect (2/2)
   [x] read code
   [x] map callers
2. Build (1/2)
   [x] edit
   [!] test — flaky upstream
Overall: 3/4 done.
```

## Commands and rules

- `init 'Phase:task,task' ...` creates an ordered plan. Repeating the identical
  list preserves progress; a different list replaces it and resets progress.
- `start TASK` makes one task active. `start TASK TASK ...` deliberately keeps
  multiple tasks active. When none is active, the earliest pending task is
  promoted, skipping blocked tasks. Phase ordering is not an execution barrier.
- `done TASK`, `block TASK --reason TEXT`, and `unblock TASK` record transitions.
  Exact task names or unique prefixes work. Blocked tasks never auto-promote.
- `append PHASE TASK ...` adds tasks. `drop TASK` and `rm TASK` remove tasks.
- Bulk transitions apply all or nothing: an invalid target leaves state unchanged.
- `view` prints the checklist. `json '{"op":"view"}'` accepts native operations;
  see [the core API](src/core.ts) for the operation types, including phase selectors.
- Use `--session NAME` or `UT_TODO_SESSION` for a separate named plan.
  `ut-todo --help` lists command syntax.

Edits, tool calls and tests never mark tasks done. Record changes explicitly,
then reconcile unfinished and blocked tasks before reporting completion.

## Agent integrations

- **Claude Code:** load `integrations/claude-code/` with `claude --plugin-dir`.
  The plugin supplies a planning skill and a CLI wrapper.
- **Codex, Gemini CLI, OpenCode, Cursor:** copy the
  [AGENTS.md snippet](integrations/agents-md.md) into your project and put
  `ut-todo` on PATH.
- **Pi:** [the extension](pi/extension.ts) provides the native `todo` tool and
  pinned panel. Its state machine, renderer and extension were extracted from
  the original host; the shared store format is retained for compatibility.
- Other agents can use the CLI through a shell.

## Storage and privacy

```text
<project>/.steak-pi/todo/<sha256(JSON.stringify([sessionFile, sessionId]))>/
├── todo.json
└── TODO.md
```

JSON contains phases and items with `content`, `status`, and optional `reason`.
Statuses are `pending`, `in_progress`, `done`, and `blocked`. Markdown is the
readable checklist and is written before JSON.

Explicit session names take precedence. Otherwise the CLI uses Claude Code's
session when its ID and unique transcript are available, or a stable per-directory
plan. An indicated Claude session with no unique transcript fails rather than
silently selecting another plan. Separate agents share a list only when they
resolve to the same project and owner. Stored files survive context compaction.

The CLI makes no network calls. Installers and dependency installation do.
Plans are plain files, not encrypted; keep sensitive content out of committed state.

## Development

```sh
npm install
npm run typecheck
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
[CHANGELOG.md](CHANGELOG.md), and the [MIT license](LICENSE).
