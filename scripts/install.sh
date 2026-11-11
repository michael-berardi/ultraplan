#!/bin/sh
# UltraPlan installer for macOS and Linux:  curl -fsSL https://github.com/michael-berardi/ultraplan/releases/latest/download/install.sh | sh
# Downloads the latest release (the npm pack bundle; UltraPlan has zero runtime dependencies), checks its SHA-256, and
# puts `ut-todo` on your PATH. Uses the Node 22.19+ already on this machine, or fetches the official Node into
# UltraPlan's own folder (nothing global). Re-running upgrades in place. No sudo, no shell profile edits.
# Environment: ULTRAPLAN_HOME (default ~/.ultraplan), ULTRAPLAN_BIN_DIR (default ~/.local/bin),
# ULTRAPLAN_VERSION (default: latest, e.g. 0.3.0), ULTRAPLAN_RELEASE_BASE (override the download base URL, used by tests).
set -eu

REPO="michael-berardi/ultraplan"
NODE_MIN_MAJOR=22; NODE_MIN_MINOR=19
HOME_DIR="${ULTRAPLAN_HOME:-$HOME/.ultraplan}"
case "$HOME_DIR" in /*) ;; *) HOME_DIR="$(pwd)/$HOME_DIR" ;; esac
APP="$HOME_DIR/app"
BIN_DIR="${ULTRAPLAN_BIN_DIR:-$HOME/.local/bin}"
case "$BIN_DIR" in /*) ;; *) BIN_DIR="$(pwd)/$BIN_DIR" ;; esac
if [ -n "${ULTRAPLAN_RELEASE_BASE:-}" ]; then BASE="$ULTRAPLAN_RELEASE_BASE"
elif [ -n "${ULTRAPLAN_VERSION:-}" ]; then BASE="https://github.com/$REPO/releases/download/v${ULTRAPLAN_VERSION#v}"
else BASE="https://github.com/$REPO/releases/latest/download"; fi

say() { printf '%s\n' "$*"; }
die() { printf 'ultraplan install: %s\n' "$*" >&2; exit 1; }

if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -q -O "$2" "$1" || die "download failed: $1"; }
else die "needs curl or wget; install one with your package manager (macOS ships curl)"; fi
command -v tar >/dev/null 2>&1 || die "needs tar; install it with your package manager"

if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "needs sha256sum or shasum; install coreutils (or perl) with your package manager"; fi

main() {
TMP=$(mktemp -d "${TMPDIR:-/tmp}/ultraplan-install.XXXXXX") || die "cannot create a temporary folder"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# expect <file> <name> <sums-file>: the file's SHA-256 must equal the line for <name> in the sums file.
expect() {
  want=$(awk -v n="$2" '{ f=$2; sub(/^\*/, "", f); if (f == n) print $1 }' "$3")
  [ -n "$want" ] || die "no checksum for $2 in $(basename "$3")"
  [ "$(sha256 "$1")" = "$want" ] || die "checksum mismatch for $2; nothing was installed"
}

node_ok() { # node_ok <node-binary>
  v=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
  [ "$major" -gt "$NODE_MIN_MAJOR" ] || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]; }
}

say "Downloading UltraPlan..."
fetch "$BASE/ultraplan.tar.gz" "$TMP/ultraplan.tar.gz"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"
expect "$TMP/ultraplan.tar.gz" ultraplan.tar.gz "$TMP/SHA256SUMS"
mkdir "$TMP/src"
tar -xzf "$TMP/ultraplan.tar.gz" -C "$TMP/src" --strip-components=1 || die "cannot unpack the download"
[ -f "$TMP/src/package.json" ] && [ -f "$TMP/src/bin/ut-todo" ] || die "the download is not an UltraPlan release"
VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/src/package.json" | head -n 1)
[ -n "$VERSION" ] || die "cannot read the release version"
REL="$APP/release-$VERSION"

# Node: the one on PATH when it is new enough, else the official build, kept inside UltraPlan's own folder.
NODE_BIN=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN=node
else
  ls /lib/ld-musl-* >/dev/null 2>&1 && die "this system uses musl (Alpine): install Node 22.19+ with its package manager (apk add nodejs npm), then run this again"
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "unsupported system $(uname -s); on Windows use install.ps1" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  say "Node 22.19 or newer not found; fetching the official Node 22 LTS for $os-$arch..."
  nbase="https://nodejs.org/dist/latest-v22.x"
  fetch "$nbase/SHASUMS256.txt" "$TMP/NODESUMS"
  nname=$(awk -v s="-$os-$arch.tar.gz" 'index($2, s) { print $2 }' "$TMP/NODESUMS" | head -n 1)
  [ -n "$nname" ] || die "no official Node build for $os-$arch"
  fetch "$nbase/$nname" "$TMP/$nname"
  expect "$TMP/$nname" "$nname" "$TMP/NODESUMS"
  nver=${nname#node-}; nver=${nver%%-*}
  mkdir -p "$APP/runtime"
  NODE_DIR="$APP/runtime/node-$nver-$os-$arch"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    rm -rf "$NODE_DIR.tmp"; mkdir "$NODE_DIR.tmp"
    tar -xzf "$TMP/$nname" -C "$NODE_DIR.tmp" --strip-components=1 || die "cannot unpack Node"
    rm -rf "$NODE_DIR"; mv "$NODE_DIR.tmp" "$NODE_DIR"
  fi
  NODE_BIN="$NODE_DIR/bin/node"
  node_ok "$NODE_BIN" || die "the downloaded Node does not run on this machine"
fi

mkdir -p "$APP" "$BIN_DIR"
chmod 700 "$HOME_DIR" 2>/dev/null || true
if [ ! -d "$REL" ]; then
  say "Installing UltraPlan $VERSION..."
  rm -rf "$REL.tmp"; mv "$TMP/src" "$REL.tmp"
  # Zero runtime dependencies: the npm pack bundle runs as unpacked, no npm install step.
  got=$("$NODE_BIN" "$REL.tmp/bin/ut-todo" --help 2>&1 </dev/null) || { rm -rf "$REL.tmp"; die "the new copy does not start: $got"; }
  case "$got" in *ut-todo*) ;; *) rm -rf "$REL.tmp"; die "the new copy does not run its help command; nothing was changed" ;; esac
  mv "$REL.tmp" "$REL"
else
  say "UltraPlan $VERSION is already unpacked; relinking."
fi

# `ut-todo` on PATH: a wrapper pinned to the Node that was verified above.
cat > "$BIN_DIR/ut-todo.tmp.$$" <<WRAP
#!/bin/sh
exec "$NODE_BIN" "$REL/bin/ut-todo" "\$@"
WRAP
chmod 755 "$BIN_DIR/ut-todo.tmp.$$"; mv -f "$BIN_DIR/ut-todo.tmp.$$" "$BIN_DIR/ut-todo"

# Only the release the wrapper points at is kept; older release folders are removed.
for d in "$APP"/release-*; do
  if [ -d "$d" ] && [ "$d" != "$REL" ]; then rm -rf "$d"; fi
done

# Finish with the tool's own health command; a failed check fails the install.
got=$("$BIN_DIR/ut-todo" --help 2>&1 </dev/null) || die "the installed ut-todo does not run: $got"
say "UltraPlan $VERSION installed ($BIN_DIR/ut-todo)."
say "$got"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
say "Next: ut-todo init 'Inspect:read code' 'Build:ship'"
}

main "$@"