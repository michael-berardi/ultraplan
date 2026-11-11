#!/bin/sh
# Builds the download assets for the current commit into <out> (default dist/release):
#   ultraplan.tar.gz   the npm pack file set (zero runtime dependencies), repacked deterministically
#   install.sh, install.ps1   the installers
#   SHA256SUMS         checksums of the three files above
# Usage: scripts/build-release.sh [out-dir]   (run from a clean checkout of the release tag; needs npm)
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-dist/release}"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "build-release: the working tree has changes; build from a clean checkout" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "build-release: needs npm (ships with Node 22.19+); install Node first" >&2; exit 1; }
commit=$(git rev-parse HEAD)
rm -rf "$OUT"; mkdir -p "$OUT"
stage=$(mktemp -d "${TMPDIR:-/tmp}/ultraplan-build.XXXXXX"); trap 'rm -rf "$stage"' EXIT
# npm pack decides the file set (package.json "files"); repack it with fixed owners and times so the
# archive is byte-for-byte reproducible for the same commit.
npm pack --pack-destination "$stage" --loglevel=error >/dev/null
set -- "$stage"/ultraplan-*.tgz
[ -f "$1" ] || { echo "build-release: npm pack produced no archive" >&2; exit 1; }
mkdir "$stage/unpack"
tar -xzf "$1" -C "$stage/unpack"
# npm pack fixes file times but not directory times; pin everything to the epoch (UTC) so the tar is reproducible.
TZ=UTC find "$stage/unpack" -exec touch -t 197001010000.00 {} +
( cd "$stage/unpack" && find package | LC_ALL=C sort > "$stage/list" )
if tar --version 2>/dev/null | grep -qi gnu; then
  tar -C "$stage/unpack" --owner=0 --group=0 --numeric-owner --mtime=@0 --no-recursion -cf "$stage/plain.tar" -T "$stage/list"
else
  COPYFILE_DISABLE=1 tar -C "$stage/unpack" --uid 0 --gid 0 --uname root --gname root --no-xattrs --no-recursion -cf "$stage/plain.tar" -T "$stage/list"
fi
# gzip -n: no name, no timestamp in the gzip header, so the archive is byte-for-byte reproducible.
gzip -n -c "$stage/plain.tar" > "$OUT/ultraplan.tar.gz"
cp scripts/install.sh scripts/install.ps1 "$OUT/"
( cd "$OUT" && if command -v sha256sum >/dev/null 2>&1; then sha256sum ultraplan.tar.gz install.sh install.ps1; else shasum -a 256 ultraplan.tar.gz install.sh install.ps1; fi > SHA256SUMS )
echo "built $OUT for $commit"; ls -l "$OUT"