# Security policy

## Supported versions

Security fixes land on `main` and ship in the next release. Only the latest
release of UltraPlan is supported.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub private vulnerability
reporting: open this repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue for an undisclosed vulnerability.

Include the affected version, your operating system, reproduction steps and
the impact you observed. Leave out credentials, personal data and private
files; a minimal synthetic reproduction is enough.

You can expect an acknowledgement within 7 days. Reporters are credited in
the release notes if they want to be.

## Scope

The CLI stores plain JSON and Markdown under the project's `.steak-pi/todo/`
directory and makes no network calls. Automatic session detection also reads
local agent transcripts. Release installers download archives and checksums,
and may download Node.js.
Relevant reports include unintended writes outside the store, unsafe handling
of a crafted store file or release archive, and command-line parsing that
could execute input.
