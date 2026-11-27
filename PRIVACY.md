# Privacy

UltraPlan is a local planning tool. It keeps your plan on your machine and
ships no telemetry, usage reporting, analytics, crash reporting, accounts or
identifiers; `ut-todo` and the Pi tool never call a model API. In interactive
use the CLI makes one anonymous update check a day, described below. This page
lists everything UltraPlan sends and writes, where, for how long, and what
removes it.

## Network traffic

- **Daily update check.** On an interactive terminal only, at most once a day,
  `ut-todo` sends one anonymous GET to this repository's public GitHub "latest
  release" record (`api.github.com/repos/<owner>/<repo>/releases/latest`) with
  the fixed User-Agent `ut-todo-update-check`. It sends no identifier,
  installed version, usage data, machine data or credentials. It runs
  alongside your command with a 4-second timeout; the answer, or a failure and
  its cause, is cached for 24 hours, and commands started together share one
  check. Drafts, prereleases and tags that are not `x.y.z` are ignored.
- **When it is off.** The check is off in CI, in agent shells (Claude Code
  sessions, and any run whose output is not a terminal), in pipes and scripts,
  for `ut-todo json`, with `UT_TODO_NO_UPDATE_CHECK=1`, or after
  `ut-todo update --auto-check off`.
- **Updates.** `ut-todo update` and `update --check` query the same record
  when you run them, and `update --skip` does when nothing newer is cached. An
  install, when you confirm one or, only if
  you turned on `ut-todo update --auto on`, in a detached low-priority process,
  downloads the release's `SHA256SUMS` and installer from GitHub, checks the
  installer's SHA-256 and runs it. npm global installs run
  `npm install --global github:<owner>/<repo>#v<version>` instead.
- **Installers.** `install.sh` and `install.ps1` run only when you run them,
  directly or through an update. They download the release archive and
  `SHA256SUMS` from GitHub and check the archive's SHA-256, and, only when no
  Node.js 22.19+ is installed, the official Node.js build from nodejs.org with
  its checksum. They send no usage data and set `DO_NOT_TRACK=1` for the
  processes they start (the Windows installer restores your previous value).
- **Pi extension.** Makes no network calls; update notices come from its host.

GitHub, nodejs.org and the npm registry see ordinary download requests (IP
address and time); UltraPlan adds nothing to them. Installing development
dependencies (`npm install`) uses the npm registry and is something you start.
See [docs/updates.md](docs/updates.md) for the update contract.

## What is written, and for how long

Plan files are plain, unencrypted JSON and Markdown. They hold only the phase
names, task text and block reasons you write: no logs or transcripts and no
identifiers. On macOS and Linux the plan folders are 0700 and the files 0600,
and stores written by older versions are tightened the next time they are
written. Update files are created 0600 in a folder created 0700.

To find the current Claude Code session, the CLI lists Claude Code's local
`projects` folder and reads the start of the session's transcript for its
working directory. Only a hash of the transcript path and session id is kept,
as the plan folder name; nothing from the transcript is stored or sent.

| Path | Contents | Lifetime | What removes it |
| --- | --- | --- | --- |
| `.steak-pi/todo/<sha256>/todo.json` | Your plan: phases, tasks, statuses and block reasons | Until you change or delete the plan | You: remove the `<sha256>` folder, or `rm -rf .steak-pi/todo`. No plan ever expires. |
| `.steak-pi/todo/<sha256>/TODO.md` | The rendered checklist, written from the same state just before the JSON | Until you change or delete the plan | Same as `todo.json` |
| `.steak-pi/todo/<sha256>/.lock` | Empty marker: one CLI writer at a time for that plan | One command; stale after 30 s | The command that created it; a stale one is reclaimed by the next writer or removed by the sweep |
| `.steak-pi/todo/<sha256>/.<name>.<pid>.<uuid>.tmp` | A staged copy of `todo.json` or `TODO.md` for an atomic write | Milliseconds | The writer's `finally`; a crash leftover after 1 hour |
| `<cache>/update.json` | Last check time and result (newest version or failure cause), the version last announced and when, a skipped version, your check and auto-install settings, and after an update the rollback record (both versions, the kept folder's path, the time). No id, no usage data. | Until the next check or settings change rewrites it; no expiry | You can delete it at any time; the next interactive check simply runs again |
| `<cache>/update.json.<pid>.<hex>.tmp`, `<cache>/update.log.<pid>.<hex>.tmp` | A staged copy of `update.json` or of the trimmed `update.log` for an atomic write | Milliseconds | The writer's `finally`; a crash leftover after 1 hour |
| `<cache>/update.claim` | A random token marking a check in flight, so commands started together share one check | One check; stale after 14 s (4 s timeout plus 10 s) | The check that owns it; an expired claim is replaced by the next check or removed by the sweep |
| `<cache>/update.lock` | Empty marker: one update install at a time | One install; stale after 10 minutes | The install's `finally`; a leftover is replaced by the next install or removed by the sweep |
| `<cache>/update.log` | Written only when automatic updates are on: one timestamped line per background install (started, installed, or the failure cause with the installer's last output), never plan text | Newest 256 KB only; dropped 7 days after its last line | Trimmed on every write; removed by the sweep after 7 days |
| `<app>/release-<version>/` | The installed program: the files of the release archive | Until an install of another version replaces it, or you uninstall | The installer removes every release folder the wrapper no longer names; uninstalling removes the rest |
| `<app>/release-<version>.previous` | The release `ut-todo update` replaced, kept for `ut-todo update --rollback` | Until the replacing release has run a command successfully, and at most 7 days | `update --rollback` restores it; otherwise the update module's pruning or the sweep removes it (see below) |
| `<app>/runtime/node-<version>-<os>-<arch>/` | The official Node.js build, downloaded only when no Node.js 22.19+ is installed | Until you uninstall; a later Node download leaves older ones in place | You: remove it, or the whole install folder, when no wrapper uses it |
| `<app>/release-<version>.tmp`, `<app>/runtime/node-<version>-<os>-<arch>.tmp` | A release or Node.js tree being unpacked and checked before it is renamed into place | One install | The installer; a crash leftover after 1 hour |
| `<app>/.staging-<guid>` | The PowerShell installer's unpack folder, inside the tool's own home | One install | The installer's `finally`; a crash leftover after 1 hour |
| `<bin>/ut-todo`, `<bin>/ut-todo.cmd` | The command wrapper: the Node.js path and the release path it runs | Until you uninstall | You. The installer never overwrites a file there that it did not write. |
| `<bin>/ut-todo.tmp.<pid>`, `<bin>/ut-todo.cmd.tmp`, `<bin>/<wrapper>.<pid>.<hex>.tmp` | A wrapper being written by `install.sh`, by `install.ps1` (`ut-todo.tmp` when it runs on macOS or Linux) or by the update module when it restores the previous release | Milliseconds | Renamed into place by its writer; a crash leftover after 1 hour |
| `<tmp>/ut-todo-update-*` | `ut-todo update`'s download of `SHA256SUMS` and the release installer | One update | The update's `finally`; a crash leftover after 1 day |
| `<tmp>/ultraplan-install.*`, `<tmp>/ultraplan-install-<guid>` | An installer's download of the release archive, `SHA256SUMS` and, when needed, Node.js | One install | The installer's exit trap or `finally`; a crash leftover after 1 day |

`<cache>` is `~/Library/Caches/ultraplan` on macOS,
`$XDG_CACHE_HOME/ultraplan` (or `~/.cache/ultraplan`) on Linux, and
`%LOCALAPPDATA%\UltraPlan\cache` on Windows; `ULTRAPLAN_CACHE_DIR` overrides it.
`<app>` is the `app` folder of the install folder (`$ULTRAPLAN_HOME`, by
default `~/.ultraplan`, or `%LOCALAPPDATA%\UltraPlan` on Windows;
`install.sh` makes the install folder 0700). `<bin>` is the folder holding the wrapper (`$ULTRAPLAN_BIN_DIR`,
by default `~/.local/bin`, or the install folder's `bin` on Windows). `<tmp>` is
the system temp folder.

The Windows installer also adds `<bin>` to your user `Path` (only when it is
not there yet) and sets and clears a `ULTRAPLAN_PATH_REFRESH` user variable so
new terminals see the change. Nothing else is written: there is no usage
counter, no history of commands, no copy of a plan outside its project folder
and no log of plan text. The single `update.log` is kept under 256 KB and
holds no plan text.

## Automatic cleanup

After a successful plan command (`init`, `start`, `done`, `view`, `json` and
the rest; not `update`, `--version` or `--help`) the CLI makes one bounded,
silent pass over the debris in the table, then exits. It never creates a
directory, never deletes a plan, `update.json`, a live release or a Node.js
runtime, and never deletes debris younger than its lifetime above. A cleanup
that fails is ignored and never changes the command's result. The pass
removes:

- in the plan folder that command used: staging files older than 1 hour and a
  `.lock` older than 30 s;
- in `<cache>`: `update.json` and `update.log` staging files older than 1 hour,
  an `update.claim` at least 14 s old, an `update.lock` at least 10 minutes
  old, and an `update.log` 7 days after its last line. Only these exact names
  are matched, because `ULTRAPLAN_CACHE_DIR` may point at a folder that holds
  other files;
- for installer installs: `<app>/.staging-*`, `<app>/*.tmp`,
  `<app>/runtime/node-*.tmp` and the wrapper staging names above, older than
  1 hour;
- in `<tmp>`: only entries named `ut-todo-update-*`, `ultraplan-install.*` or
  `ultraplan-install-*` that are older than 1 day; no other temp entries are
  touched;
- `<app>/release-<new>.previous`, once release `<new>`, the one the wrapper
  names, has run a command successfully (this process is running from it),
  or 7 days after the swap, measured from the newer of the copy's and the
  wrapper's modification times. A copy for a release the wrapper does not name
  is kept until those 7 days pass.

Separately, the update module removes the rollback copy it recorded in
`update.json` after the new version completes a command, or 7 days after the
update. So `ut-todo update --rollback` works until the new version has run one
command; after that, run the installer with `ULTRAPLAN_VERSION=<old>` to go
back.

Claim removal is age-based: the sweep removes a claim only when it is at least
14 s old. If that sweep overlaps a check reclaiming the same expired claim, it
can also remove the new token; that check finishes, but the next interactive
command can start another. The command's own result is never changed.

Set `ULTRAPLAN_NO_LOCAL_CLEANUP=1` to skip this pass and clean up by hand. It
does not switch off the update module's own housekeeping: each update still
deletes its download folder, `update.log` is still trimmed, and the recorded
rollback copy is still removed as described above.

## Agents and model providers

The agent integrations are local files (a Claude Code plugin, an `AGENTS.md`
snippet and the Pi extension). Your agent or model provider can see plan text
because you asked it to use the tool. UltraPlan itself does not contact any
provider.

## Deleting everything

- One plan: remove its `<project>/.steak-pi/todo/<sha256>/` folder.
- All plans for a project: `rm -rf .steak-pi/todo`.
- Update state, claim, lock and log: delete `<cache>`.
- An installer-managed copy: delete the install folder (the release, the
  rollback copy and any downloaded Node.js) and the wrapper in `<bin>`; on
  Windows also remove `<bin>` from your user Path. See the README's
  Uninstalling section.
- An npm copy: `npm uninstall --global ultraplan`, then delete `<cache>`.

Keep secrets out of task text: plans are plain text, and a plan you paste into
a prompt becomes part of that prompt. The tests in `test/privacy.test.ts` and
`test/retention.test.ts` check this page against the code.
