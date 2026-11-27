# Privacy

UltraPlan is a local planning tool. It keeps your plan on your machine, makes
one anonymous release check in interactive use, and ships no telemetry, usage
reporting, analytics, crash reporting or model API client. This page is the
complete list
of what it writes, where, for how long, and what removes it.

## Network traffic

In interactive terminal use `ut-todo` makes at most one anonymous GET once a day
to this repository's own public GitHub "latest release" record
(`api.github.com/repos/<owner>/<repo>/releases/latest`) with the fixed
`ut-todo-update-check` User-Agent. It sends no user id, no installed version,
no usage data, no machine data and no credentials; the answer is cached for
24 hours. Drafts, prereleases and tags that are not `x.y.z` are ignored. The
check has a 4-second timeout and shares one in-flight result between commands
started together; a failed check is reported only by `ut-todo update --check`.
This anonymous daily check is the CLI's only routine network use; see
[docs/updates.md](docs/updates.md) for the update contract.

The daily check is off in CI, in agent shells, in pipes and scripts, with
`UT_TODO_NO_UPDATE_CHECK=1`, or after `ut-todo update --auto-check off`. An
explicit `ut-todo update --check` still runs. With automatic updates on, an
install runs in a detached, low-priority child and downloads the release's
checksums and installer from GitHub. The installers run only when you run them:
they download the release archive and its SHA-256 checksum from GitHub and,
only when no suitable Node.js is installed, Node.js from nodejs.org with its
checksum. They send no usage data and set `DO_NOT_TRACK=1` for processes they
start (the Windows installer restores the previous value). Dependency
installation (`npm install`) is something you invoke yourself.

The Pi extension makes no network calls; its host may show its own notices.
GitHub, nodejs.org and the npm registry see ordinary download requests (IP
address and time); UltraPlan adds nothing to them.

## What is written, and for how long

Plan files are plain, unencrypted JSON and Markdown. They hold only the phase
names, task text and block reasons you write: no logs or transcripts and no
identifiers. On POSIX systems directories are 0700 and files 0600; older stores
with looser permissions are tightened on the next write. `<cache>` is
UltraPlan's own cache folder; a user-chosen cache root may hold other files, so
the sweep matches only this tool's exact staging names there.

| Path | Contents | Lifetime | What removes it |
| --- | --- | --- | --- |
| `.steak-pi/todo/<sha256>/todo.json` | Your plan: phases, tasks, statuses and block reasons | Until you change or delete the plan | You: remove the `<sha256>` folder, or `rm -rf .steak-pi/todo`. No plan ever expires. |
| `.steak-pi/todo/<sha256>/TODO.md` | The rendered checklist, written from the same state just before the JSON | Until you change or delete the plan | Same as `todo.json` |
| `.steak-pi/todo/<sha256>/.lock` | Empty marker: one writer at a time for that plan | One command; stale after 30 s | The command that created it, or the next writer / retention sweep after 30 s |
| `.steak-pi/todo/<sha256>/.<name>.<pid>.<uuid>.tmp` | A staged copy of `todo.json` or `TODO.md` for an atomic write | Milliseconds | The writer's `finally`; a crash leftover after 1 hour |
| `<cache>/update.json` | Last check result and your settings: latest version, note text, timestamps, failure cause, skip, checks and auto-install choices. No id, no usage data. | Until the next check or settings change replaces it; no expiry | You can delete it at any time; the next interactive check simply runs again |
| `<cache>/update.json.<pid>.<hex>.tmp` | A staged copy of `update.json` for an atomic write | Milliseconds | The writer's `finally`; a crash leftover after 1 hour |
| `<cache>/update.claim` | A random token marking a check in flight, so parallel commands reuse one check | 14 s (4 s timeout plus 10 s) | The check that owns it, or the next check / retention sweep once expired |
| `<cache>/update.lock` | One-install-at-a-time marker for an update | The duration of one install; stale after 10 minutes | The install's `finally`; a crash leftover after 10 minutes |
| `<cache>/update.log` | Output of an opted-in background install. Never plan text. | Newest 256 KB only; dropped after 7 days | Trimmed before and after every background install; removed by the sweep after 7 days |
| `<app>/release-<version>.tmp`, `<app>/release-<version>.rollback.tmp` | A verified release tree being staged or rolled back | One install | Renamed into place by the install; a crash leftover after 1 hour |
| `<app>/.staging-<guid>` | A Windows installer's download and unpack folder inside the tool's own home | One install | The installer; a crash leftover after 1 hour |
| `<bin>/ut-todo.tmp.*` | A command wrapper staged during an install | Milliseconds | Renamed into place by the installer; a crash leftover after 1 hour |
| `<app>/release-<version>.previous` | The release kept for `ut-todo update --rollback` | Until the replacing release has run successfully once, and at most 7 days | The update's own cleanup or the retention sweep (see below), or `update --rollback` first |
| `<tmp>/ut-todo-update-*`, `<tmp>/ultraplan-update-*`, `<tmp>/ultraplan-install.*` | Downloaded installer, checksums and unpacked tree for one install | One install | The install's `finally`; a crash leftover after 1 day |

`<cache>` is `~/Library/Caches/ultraplan` on macOS,
`$XDG_CACHE_HOME/ultraplan` (or `~/.cache/ultraplan`) on Linux, and
`%LOCALAPPDATA%\UltraPlan\cache` on Windows; `ULTRAPLAN_CACHE_DIR` overrides it.
`<app>` is the installer's application folder (`$ULTRAPLAN_HOME/app`, by default
`~/.ultraplan/app` or `%LOCALAPPDATA%\UltraPlan\app`), `<bin>` is the folder
holding the `ut-todo` wrapper (`$ULTRAPLAN_BIN_DIR`, by default `~/.local/bin`
or the Windows installer's `bin` folder), and `<tmp>` is the system temp folder.

Nothing else is written. There is no usage counter, no history of commands, no
copy of a plan outside its project folder and no log of plan text. The single
`update.log` is kept under 256 KB and holds no plan text.

## Automatic cleanup

After a successful command — and never inside one, so it cannot change that
command's result — `ut-todo` makes one bounded, silent pass over exactly these
paths. It never creates a directory, so an unused install is left untouched; it
never deletes a plan, the update cache or your settings; and it never deletes a
file younger than the lifetime in the table above. A cleanup that fails is
ignored.

The pass removes:

- staging files and a stale lock in the plan folder that command used;
- a staging file in the update cache, an expired check claim, an install lock
  left by a dead update, and an install log older than 7 days;
- installer staging folders, wrapper staging and release staging older than
  1 hour, plus only `<tmp>/ut-todo-update-*`, `<tmp>/ultraplan-update-*` and
  `<tmp>/ultraplan-install.*` folders older than 1 day — no other temp entries
  are touched;
- rollback copies (`<app>/release-<version>.previous`) when the release the
  wrapper now names has run successfully once (this process is running from
  it), when a release restored by `ut-todo update --rollback` has itself run
  and this process is now running from that restored release, or when the
  copies are 7 days old. A copy whose version cannot be attributed to a wrapper
  is not removed early; it still expires after 7 days.

Claim removal is age-based: the sweep removes a claim only when it is at least
14 s old. If that sweep overlaps a check reclaiming the same expired claim, it
can also remove the new token; that check finishes, but the next interactive
command can start another. The command's own result is never changed.

Set `ULTRAPLAN_NO_LOCAL_CLEANUP=1` to skip this pass entirely and clean up by
hand. `ut-todo update --rollback` still restores a kept release until the sweep
retires it.

## Agents and model providers

The agent integrations are local files (a Claude Code plugin, an `AGENTS.md`
snippet and the Pi extension). Your agent or model provider can see plan text
because you asked it to use the tool. UltraPlan itself does not contact any
provider.

## Deleting everything

- One plan: remove its `<project>/.steak-pi/todo/<sha256>/` folder.
- All plans for a project: `rm -rf .steak-pi/todo`.
- Update cache, claims, log and settings: delete `<cache>/`.
- An installer-managed copy: run the installer's uninstall steps in the README
  (delete the install folder and its command wrapper).
- An npm copy: `npm uninstall --global ultraplan`.

Keep secrets out of task text: plans are plain text, and a plan you paste into
a prompt becomes part of that prompt. The tests in `test/privacy.test.ts` and
`test/retention.test.ts` hold this contract.
