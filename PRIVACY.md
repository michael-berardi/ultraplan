# Privacy

UltraPlan is a local planning tool. It keeps your plan on your machine, makes
one anonymous release check in interactive use, and ships no usage reporting,
analytics, crash reporting or model API client. This page is the complete list
of what it writes, where, for how long, and what removes it.

## Nothing leaves your machine except the release check

In interactive terminal use `ut-todo` makes at most one HTTPS GET per day to
this repository's own public GitHub "latest release" record: a fixed
`ut-todo-update-check` user agent. It sends no user id, no installed version,
no usage data, no machine data and no credentials, and the answer is cached for
24 hours. Checks are off in CI, in non-TTY use and in agent use, and
`ULTRAPLAN_NO_UPDATE_CHECK=1` (or `checkAutomatically: false` in the config)
disables them entirely. A failed check is reported only by
`ut-todo update --check`. The request runs in a short-lived detached child, so
the command you are waiting for never blocks on it. See
[docs/updates.md](docs/updates.md) for the update contract.

The installers download the release archive and its SHA-256 checksum from
GitHub — and Node.js from nodejs.org with its checksum, only when no suitable
Node is installed — when you run them. They send no usage data, and no tool
they invoke reports usage either. Dependency installation (`npm install`) is
something you invoke yourself.

## What is written, and for how long

Plan files are plain, unencrypted JSON and Markdown. They hold only the phase
names, task text and block reasons you write: no logs, no transcripts and no
identifiers. Directories are 0700 and files 0600 on POSIX systems; older stores
with looser permissions are tightened on the next write.

| Path | Contents | Lifetime | What removes it |
| --- | --- | --- | --- |
| `.steak-pi/todo/<sha256>/todo.json` | Your plan: phases, tasks, statuses, block reasons | Until you change or delete the plan | You: remove the `<sha256>` folder, or `rm -rf .steak-pi/todo`. No plan ever expires. |
| `.steak-pi/todo/<sha256>/TODO.md` | The rendered checklist, written just before the JSON | Until you change or delete the plan | Same as `todo.json` |
| `.steak-pi/todo/<sha256>/.lock` | Empty marker: one writer at a time for that plan | One command; stale after 30 s | The command that created it, or the next writer / retention sweep after 30 s |
| `.steak-pi/todo/<sha256>/.<name>.<pid>.<uuid>.tmp` | A staged copy of `todo.json` or `TODO.md` for an atomic write | Milliseconds | The writer's `finally`; a crash leftover after 1 hour |
| `<cache>/ultraplan/update-check.json` | The last check result: latest version, note text, timestamps, failure cause | Replaced by the next check, at most daily; no expiry | You can delete it at any time; the next interactive check simply runs again |
| `<cache>/ultraplan/update-check.claim` | A random token marking a check in flight | Seconds (4 s timeout plus 10 s) | The check that owns it, or the retention sweep once expired |
| `<config>/ultraplan/config.json` | Your update choices: automatic checks, automatic installs, skipped version, auto-ask answered | Until you change it | `ut-todo update --auto`, `update --skip`, or deleting the file |
| `<config>/ultraplan/logs/update.log` | Output of an opted-in background install; never plan text | Newest 256 KB only; dropped after 7 days | Trimmed around every background install; removed by the sweep after 7 days |
| `<app>/release-<version>.tmp`, `<app>/release-<version>.rollback.tmp` | A verified release tree being staged or rolled back | One install | Renamed into place by the install; a crash leftover after 1 hour |
| `<app>/.staging-<guid>` | A Windows installer's download and unpack folder | One install | The installer; a crash leftover after 1 hour |
| `<app>/release-previous`, `<bin>/ut-todo.previous` | The release and command wrapper kept for `ut-todo update --rollback` | Until the replacing release has run successfully once, and at most 7 days | The retention sweep (see below), or `update --rollback` first |
| `<tmp>/ultraplan-update-*`, `<tmp>/ultraplan-install.*` | Downloaded archive, checksums and unpacked tree for one install | One install | The install's own `finally`; a crash leftover after 1 day |

`<cache>`, `<config>`, `<app>`, `<bin>` and `<tmp>` are the platform folders
`ut-todo` already documents: `~/Library/Caches/ultraplan` and
`~/Library/Application Support/ultraplan` on macOS, the `XDG_*` folders on
Linux, and the `LocalAppData`/`AppData` folders on Windows, plus the tool's own
install folder and the system temp folder. `ULTRAPLAN_CACHE_DIR`,
`ULTRAPLAN_CONFIG_DIR`, `ULTRAPLAN_HOME` and `ULTRAPLAN_BIN_DIR` override them.

Nothing else is written. There is no usage counter, no history of commands, no
copy of a plan outside its project folder and no log of plan text.

## Automatic cleanup

After a successful command — and never inside one, so it cannot change that
command's result — `ut-todo` runs one bounded, silent pass over exactly these
paths. It never creates a directory, so an unused install is left untouched; it
never deletes a plan, the update cache or your config; and it never deletes a
file younger than the lifetime in the table above. A cleanup that fails is
ignored.

The pass removes:

- staging files and a stale lock in the plan folder that command used;
- a staging file in the update cache, an expired in-flight claim, and an
  install log older than 7 days;
- installer staging folders and release staging older than 1 hour, plus
  `ultraplan-*` folders in the system temp folder older than 1 day;
- the rollback copies — `<app>/release-previous` and `<bin>/ut-todo.previous` —
  in the three cases the update contract (§4a) names: the release the wrapper
  now names has run successfully once (this process is running from it), the
  wrapper was restored by `ut-todo update --rollback` and that restored release
  has now run successfully, or the copies are 7 days old. A copy whose version
  cannot be attributed to a wrapper is never removed.

Set `ULTRAPLAN_NO_LOCAL_CLEANUP=1` to skip this pass entirely and clean up by
hand. `ut-todo update --rollback` still restores the previous release until the
sweep retires it.

## Your agent may see plan text

The agent integrations are local files (a Claude Code plugin, an `AGENTS.md`
snippet, the Pi extension). Your agent or model provider can see plan text
because you asked it to use the tool. UltraPlan itself contacts no provider.

## Deleting everything

- One plan: remove its `<project>/.steak-pi/todo/<sha256>/` folder.
- All plans for a project: `rm -rf .steak-pi/todo`.
- Update cache and claims: delete `<cache>/ultraplan/`.
- Update preferences: delete `<config>/ultraplan/`, or run
  `ut-todo update --auto off` to stop automatic installs.
- An installer-managed copy: run the installer's uninstall steps in the README
  (delete the install folder and its command wrapper).
- An npm copy: `npm uninstall --global ultraplan`.

Keep secrets out of task text: plans are plain text, and a plan you paste into
a prompt becomes part of that prompt.
