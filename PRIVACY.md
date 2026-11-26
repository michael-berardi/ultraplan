# Privacy

UltraPlan collects nothing. There is no telemetry, account or identifier.

## What stays on your machine

- Plans: `<project>/.steak-pi/todo/<hash>/todo.json` and `TODO.md`, plain files,
  not encrypted. Keep sensitive content out of committed state.
- Session detection reads Claude Code's local transcripts to find the current
  session; nothing from them leaves the machine.
- Update state: one small file in the platform cache folder (see
  [docs/updates.md](docs/updates.md)).

## Network use

- **Update check.** On an interactive terminal only, at most once a day, the
  CLI sends one anonymous GET to the public GitHub "latest release" record
  (`api.github.com/repos/<owner>/<repo>/releases/latest`) with the User-Agent
  `ut-todo-update-check`. It sends no identifier, version, usage or machine
  data. It is off in CI, in agent shells, in pipes and scripts, with
  `ut-todo update --auto-check off`, or with `UT_TODO_NO_UPDATE_CHECK=1`.
- **Updating.** `ut-todo update` (or an automatic update, if you turned it on)
  downloads the release's installer, archive and `SHA256SUMS` from GitHub, or
  runs npm for npm installs.
- **Installing.** The installers download the release from GitHub and, if
  needed, Node.js from nodejs.org. `npm install` uses the npm registry.

GitHub and nodejs.org see the request like any download (IP address and
time); UltraPlan adds nothing to it.
