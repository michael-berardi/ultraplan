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

It is off when output is not a terminal, when `CI` is set, in agent shells, with
`ut-todo update --auto-check off`, or with `UT_TODO_NO_UPDATE_CHECK=1`.

All update state lives in one folder: `~/Library/Caches/ultraplan` (macOS),
`$XDG_CACHE_HOME/ultraplan` or `~/.cache/ultraplan` (Linux),
`%LOCALAPPDATA%\UltraPlan\cache` (Windows). It holds `update.json` (mode 0600:
check time, latest version, skipped version, last notice, your settings) and,
only after an automatic install, `update.log` (kept under 256 KB). Downloads go
to a temporary folder that is deleted on success and on failure. To uninstall
completely, delete that folder along with the install folder and wrapper.

For testing, `UT_TODO_UPDATE_API` points the check at another release record,
`ULTRAPLAN_RELEASE_BASE` points the install at other release assets, and
`ULTRAPLAN_CACHE_DIR` moves the state folder.
