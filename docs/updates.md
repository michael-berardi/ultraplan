# Updates

<!-- update-contract: v1 -->

`ut-todo` tells you when a newer release exists and updates in one step.
Automatic installs happen only if you turn them on.

## The notice

On a terminal, after your command finishes, `ut-todo` may print two lines on
stderr (the second one dimmed):

```text
ut-todo 0.6.0 available (you have 0.5.0) · run: ut-todo update
turn on automatic updates: ut-todo update --auto on · skip: ut-todo update --skip
```

It shows at most once a day per version. It never appears in `ut-todo json`
output, in pipes or scripts, in CI, or in agent shells.

## Commands

```sh
ut-todo update                    # show what is new, then install it
ut-todo update --check            # report only: exit 0 up to date, 10 update available, 1 check failed
ut-todo update --skip             # hide this version's notice until a newer release
ut-todo update --auto on|off|status        # install updates automatically (off by default)
ut-todo update --auto-check on|off|status  # the daily check (on by default)
ut-todo update --rollback         # restore the release from before the last update
```

`ut-todo update` shows the current and new versions and the first lines of
the release notes. On a terminal it asks `Install <new> now? [Y/n]`, and after
the first successful install `Install future updates automatically? [y/N]`;
the answer is remembered and not asked again. Run from a script, it installs
without asking.

With automatic updates on, a check that finds a new release installs it in a
detached, low-priority process; the new version runs from your next command.
If that install fails, the current version keeps working, the cause is logged
and the notice comes back.

## How it installs

- **Installer** (`install.sh`, `install.ps1`): `ut-todo update` downloads the
  release's `SHA256SUMS` and installer, refuses to go on if the installer's
  SHA-256 does not match, then runs it. The installer checks the archive's
  SHA-256 before it changes anything, switches the `ut-todo` wrapper to the new
  release and keeps the replaced one as `release-<new>.previous`.
- **npm global install**: runs `npm install --global github:<owner>/<repo>#v<new>`.
- **Source checkout or a dependency of another tool**: `ut-todo update` prints
  the right command (`git pull`, or update the tool that installed it).
- The Pi extension runs inside its host, which shows the host's own update notice.

`ut-todo update --rollback` puts the previous release back and skips the newer
one. The rollback copy is deleted once the new version has completed a command,
or after 7 days. If the new version does not start at all, reinstall the old
one by running the installer with `ULTRAPLAN_VERSION=<old>` set.

## Privacy and files

The check is one anonymous HTTPS GET to the public GitHub "latest release"
record of this repository, with the fixed User-Agent `ut-todo-update-check`.
It sends no identifier, version, usage or machine data. It runs at most once
every 24 hours, in the background, with a 4-second timeout. A failed check is
recorded with its cause (`ut-todo update --check` shows it) and is not retried
until the next day. Drafts, prereleases and tags that are not `x.y.z` are ignored.
Commands started at the same time share one check: the first one marks it in
flight with an owner-only `update.claim` file, the others use the cached result
instead of sending their own request, and the file is removed when the check
ends. A claim left by a process that died is replaced after 14 s.

It is off when output is not a terminal, when `CI` is set, in agent shells, with
`ut-todo update --auto-check off`, or with `UT_TODO_NO_UPDATE_CHECK=1`.

All update state lives in one folder: `~/Library/Caches/ultraplan` (macOS),
`$XDG_CACHE_HOME/ultraplan` or `~/.cache/ultraplan` (Linux),
`%LOCALAPPDATA%\UltraPlan\cache` (Windows). It holds `update.json` (mode 0600:
check time, latest version, skipped version, last notice, your settings) and,
only after an automatic install, `update.log` (kept under 256 KB); `update.claim`
exists only while a check is running. Downloads go
to a temporary folder that is deleted on success and on failure. To uninstall
completely, delete that folder along with the install folder and wrapper.

For testing, `UT_TODO_UPDATE_API` points the check at another release record,
`ULTRAPLAN_RELEASE_BASE` points the install at other release assets, and
`ULTRAPLAN_CACHE_DIR` moves the state folder.


## Local-data retention

After a successful command, never inside one, `ut-todo` makes one bounded,
silent pass over the paths it owns; a failure in that pass is ignored. It
removes crash staging from the plan folder (1 hour), a stale plan lock (30 s),
staging files in the update cache (1 hour), an expired claim (14 s), an install
lock left by a dead update (10 minutes) and a background install log older
than seven days. If a sweep overlaps a reclaim of the same expired claim it
can also remove the new token; that check still finishes, but the next
interactive command may start another. The command's result is never changed.

Installer staging (`release-<version>.tmp`, `release-<version>.rollback.tmp`,
`.staging-<guid>` and `<bin>/ut-todo.tmp.*`) is removed after 1 hour, and only
`<tmp>/ut-todo-update-*`, `<tmp>/ultraplan-update-*` and
`<tmp>/ultraplan-install.*` folders are removed after 1 day. Plans, the update
cache and your settings are never touched. Set
`ULTRAPLAN_NO_LOCAL_CLEANUP=1` to skip the pass and clean up by hand.

Rollback copies (`<app>/release-<version>.previous`) are retained for rollback
until the release the wrapper now names has run successfully once, or for seven
days at most. The sweep also retires a copy when a restored release has itself
run: the wrapper points at the restored release and this process is now running from that restored release, so the kept copies are redundant. Any copy older
than seven days is retired even when its version cannot be attributed to a
wrapper. `ut-todo update --rollback` still restores a kept copy
before then. The full inventory, with every lifetime, is in
[PRIVACY.md](../PRIVACY.md).

