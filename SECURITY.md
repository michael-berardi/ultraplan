# Security policy

## Supported versions

Security fixes land on `main` and ship in the next release. Only the latest
release of UltraTerm Plan is supported.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/michael-berardi/ultraterm-plan/security/advisories/new).
Do not open a public issue for an undisclosed vulnerability.

Include the affected version, your operating system, reproduction steps and
the impact you observed. Leave out credentials, personal data and private
files; a minimal synthetic reproduction is enough.

You can expect an acknowledgement within 7 days. Reporters are credited in
the release notes if they want to be.

## Scope

UltraTerm Plan reads and writes plain JSON and Markdown files under the
project's `.steak-pi/todo/` directory and never touches the network.
Relevant reports include writes outside that directory, unsafe handling of a
crafted store file, and command-line parsing that could execute input.
