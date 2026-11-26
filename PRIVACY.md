# Privacy

UltraPlan collects nothing. There is no telemetry, analytics, crash
reporting, account or identifier, and `ut-todo` and the Pi tool never call a
model API.

## What stays on your machine

- **Plans.** `<project>/.steak-pi/todo/<hash>/todo.json` and `TODO.md`: plain,
  unencrypted JSON and Markdown. They hold only the phase names, task text and
  block reasons you write; there are no logs or transcripts. On macOS and
  Linux the folders are created 0700 and the files 0600, and stores written by
  older versions are tightened the next time they are written. Plans are kept
  until you delete them: remove one plan's `<hash>` folder, or all plans for a
  project with `rm -rf .steak-pi/todo`. Keep secrets out of task text and out
  of committed state.
- **Session detection** reads Claude Code's local transcripts to find the
  current session. Only a hash of the session's file and ID is kept (as the
  plan folder name); nothing from them leaves the machine.
- **Update state.** One folder in the platform cache folder holds
  `update.json` (mode 0600) and, only after an automatic install,
  `update.log` (kept under 256 KB). While a check runs, a 0600 `update.claim`
  file keeps other commands from sending a second request; it is removed when
  the check ends. Update downloads go to a temporary folder
  that is deleted on success and on failure; the rollback copy is deleted
  after the new version completes one command, or after 7 days. Locations
  and removal: [docs/updates.md](docs/updates.md#privacy-and-files).

## Network use

- **Update check.** On an interactive terminal only, at most once a day, the
  CLI sends one anonymous GET to the public GitHub "latest release" record
  (`api.github.com/repos/<owner>/<repo>/releases/latest`) with the User-Agent
  `ut-todo-update-check`. It sends no identifier, version, usage or machine
  data. It is off in CI, in agent shells, in pipes and scripts, with
  `ut-todo update --auto-check off`, or with `UT_TODO_NO_UPDATE_CHECK=1`.
  This is the CLI's only network use while running your commands.
- **Updating.** `ut-todo update` (or an automatic update, if you turned it on)
  downloads the release's installer, archive and `SHA256SUMS` from GitHub, or
  runs npm for npm installs.
- **Installing.** The installers run only when you run them. They download the
  release archive and its SHA-256 checksum from GitHub, and download Node.js
  from nodejs.org with its checksum only if no suitable Node is installed. They
  send no usage data and set `DO_NOT_TRACK=1` for the processes they start
  (the Windows installer restores your previous value afterwards).
  Dependency installation (`npm install`) uses the npm registry and is also
  something you start.
- **Pi extension.** Makes no network calls; update notices come from its host.

GitHub, nodejs.org and the npm registry see the request like any download (IP
address and time); UltraPlan adds nothing to it.

## Agents and model providers

The agent integrations are local files. Your agent or model provider may see
plan text because you asked it to use the tool; UltraPlan does not contact any
provider itself.

## Tests that hold this

`test/privacy.test.ts` runs the CLI with every network API disabled, checks the
store's file modes, rejects telemetry packages and endpoints in shipped code,
limits network code to the update module and its GitHub endpoints, and keeps
the README Privacy section to six lines with the detail here.
