<!-- update-contract: v1 -->

# Updates

UltraPlan follows the open-source update contract: tell the user when a newer
stable release exists, make updating one command, and never install anything
without an explicit opt-in.

## What the check sends

In interactive terminal use, `ut-todo` makes **one anonymous HTTPS GET** to
`https://api.github.com/repos/<owner>/<repo>/releases/latest`, where the owner
and repository come from this package's own metadata. The request has a fixed
`ut-todo-update-check` user agent. It sends no user id, no installed version,
no usage data, no machine data and no credentials. Drafts, prereleases, tags
that are not `x.y.z` and releases that are not strictly newer are ignored.

The result is cached at most once every 24 hours in
`<cache dir>/ultraplan/update-check.json` (0600, atomic write). A failed check
records its cause there; it is never printed as noise and is never retried in a
loop. `ut-todo update --check` reports the cause.

Automatic checks are off outside a human interactive terminal: no TTY, `CI`
set, or an agent/headless host. `ULTRAPLAN_NO_UPDATE_CHECK=1` or
`checkAutomatically: false` in `<config dir>/ultraplan/config.json` disables
checks entirely, including explicit ones.

## Notices

After a normal command finishes, on a TTY only:

```text
ut-todo 0.5.2 available (you have 0.5.1) · run: ut-todo update
turn on automatic updates: ut-todo update --auto on · skip: ut-todo update --skip
```

The second line is dimmed. A version is shown at most once per 24 hours;
`update --skip` hides that version until a newer one exists. Notices never go
inside `ut-todo json` output. Agent hosts get no stderr notice; the Claude Code
skill asks the agent to surface the result of an explicit `update --check` in
its reply instead.

## Commands

- `ut-todo update --check` — report only. Exit 0 when current or disabled,
  10 when an update is available, 1 when a check failed (with the cause).
- `ut-todo update` — show current → new and the first release-note lines, then
  ask `Install <new> now? [Y/n]` on a TTY. Non-TTY explicit use installs
  without questions.
- `ut-todo update --skip [VERSION]` — hide this version's notice until a newer
  release. Without a version, skips the newest checked one.
- `ut-todo update --auto on|off|status` — opt into or out of automatic
  installs. The choice is stored in config so it survives updates; it is off
  by default. After a successful install the CLI asks once
  `Install future updates automatically? [y/N]` on a TTY and remembers the
  answer.
- `ut-todo update --rollback` — restore the previous release for
  installer-managed copies (one rollback is kept).

When automatic installs are on, the check launches a detached, unref'd child
process and returns immediately: your command never waits for the install. On
POSIX the child starts with `nice -n 10` (and falls back to the plain runtime
if `nice` is missing); Windows has no portable `nice`, so it uses the plain
runtime detached and hidden. Output goes to the single owner-only file
`<config dir>/ultraplan/logs/update.log` (0600), trimmed to its newest 256 KB
before a run and again after the install. The child keeps the verified swap
and one rollback, records its own failures in the update cache, and the new
version applies on the next run. A failed install leaves the current version
working, records the cause and falls back to the notice.

## Install safety

Downloads come from the release's own assets. `SHA256SUMS` must match
`ultraplan.tar.gz` before anything is unpacked; a mismatch installs nothing.
The unpacked release is staged, health-checked and renamed into place, with
the prior release and command wrapper kept as `.previous` for rollback.
npm-global installs are detected and updated with
`npm install --global github:<owner>/<repo>#v<version>` rather than by
overwriting files npm owns. Other install kinds print the matching command.

## Privacy

Plans remain local, plain JSON and Markdown in 0700/0600 paths. The only
network request the CLI itself makes is the anonymous check described above;
there is no usage reporting, analytics, crash reporting or model API call.
Installers run only when you run them or after you explicitly opt into
automatic installs, and they verify checksums. Background install logs stay in
the tool's own 0700 config directory. See the README Privacy section for
details.
