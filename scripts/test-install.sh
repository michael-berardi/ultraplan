#!/bin/sh
# Installer tests for scripts/install.sh and scripts/install.ps1.
# Builds dist/release, serves it over a short-lived local HTTP server, then tests:
#   macOS host (when run on Darwin): fresh install, ut-todo runs, re-run upgrades,
#     corrupted archive refused, missing prerequisite named.
#   ubuntu:24.04 container (docker): same, with no Node present (the installer must
#     fetch the official Node), plus a too-old Node on PATH.
#   mcr.microsoft.com/powershell container: install.ps1 under PowerShell 7 on Linux
#     (install, ut-todo runs, re-run, corrupted archive refused), then PSScriptAnalyzer.
# Usage: scripts/test-install.sh [--skip-docker]   (needs python3, curl; docker for the container tests)
set -eu
cd "$(dirname "$0")/.."
PORT="${ULTRAPLAN_TEST_PORT:-18923}"
SKIP_DOCKER=0
case "${1:-}" in --skip-docker) SKIP_DOCKER=1 ;; "") ;; *) echo "usage: $0 [--skip-docker]" >&2; exit 2 ;; esac

command -v python3 >/dev/null 2>&1 || { echo "test-install: needs python3 for the local release server" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "test-install: needs curl" >&2; exit 1; }

pass() { printf 'ok - %s\n' "$1"; }
fail() { printf 'FAIL - %s\n' "$1" >&2; exit 1; }

scripts/build-release.sh dist/release
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/ultraplan-test.XXXXXX")
SRV=""
cleanup() {
  if [ -n "$SRV" ]; then kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; fi
  rm -rf "$ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$ROOT/www/good" "$ROOT/www/bad" "$ROOT/emptybin"
cp dist/release/ultraplan.tar.gz dist/release/install.sh dist/release/install.ps1 dist/release/SHA256SUMS "$ROOT/www/good/"
cp "$ROOT/www/good/"* "$ROOT/www/bad/"
printf 'corrupted bytes' >> "$ROOT/www/bad/ultraplan.tar.gz"

python3 -m http.server "$PORT" --bind 0.0.0.0 --directory "$ROOT/www" >"$ROOT/server.log" 2>&1 &
SRV=$!
up=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/good/SHA256SUMS" 2>/dev/null; then up=1; break; fi
  sleep 0.25
done
[ "$up" = 1 ] || fail "local release server did not start on port $PORT"
HOST_BASE="http://127.0.0.1:$PORT"
DOCKER_BASE="http://host.docker.internal:$PORT"

if [ "$(uname -s)" = Darwin ]; then
  h1="$ROOT/h1"; mkdir -p "$h1"
  env HOME="$h1" ULTRAPLAN_HOME="$h1/.ultraplan" ULTRAPLAN_BIN_DIR="$h1/.local/bin" \
    ULTRAPLAN_RELEASE_BASE="$HOST_BASE/good" sh scripts/install.sh >"$ROOT/mac1.log" 2>&1 \
    || { cat "$ROOT/mac1.log" >&2; fail "macOS fresh install"; }
  grep -q 'UltraPlan .* installed' "$ROOT/mac1.log" || fail "macOS install did not report success"
  "$h1/.local/bin/ut-todo" --help | grep -q 'ut-todo' || fail "installed ut-todo --help (macOS)"
  mkdir -p "$ROOT/work"
  ( cd "$ROOT/work" && "$h1/.local/bin/ut-todo" init 'Inspect:read code' 'Build:ship' ) | grep -q 'Overall: 0/2 done.' \
    || fail "installed ut-todo init (macOS)"
  pass "macOS: fresh install, ut-todo --help and init work"

  env HOME="$h1" ULTRAPLAN_HOME="$h1/.ultraplan" ULTRAPLAN_BIN_DIR="$h1/.local/bin" \
    ULTRAPLAN_RELEASE_BASE="$HOST_BASE/good" sh scripts/install.sh >"$ROOT/mac2.log" 2>&1 \
    || { cat "$ROOT/mac2.log" >&2; fail "macOS re-run"; }
  grep -q 'already unpacked' "$ROOT/mac2.log" || fail "macOS re-run did not upgrade in place"
  "$h1/.local/bin/ut-todo" --help >/dev/null || fail "ut-todo after re-run (macOS)"
  pass "macOS: re-run upgrades in place"

  h2="$ROOT/h2"; mkdir -p "$h2"
  if env HOME="$h2" ULTRAPLAN_HOME="$h2/.ultraplan" ULTRAPLAN_BIN_DIR="$h2/.local/bin" \
    ULTRAPLAN_RELEASE_BASE="$HOST_BASE/bad" sh scripts/install.sh >"$ROOT/mac3.log" 2>&1; then
    fail "macOS: corrupted archive was accepted"
  fi
  grep -q 'checksum mismatch' "$ROOT/mac3.log" || { cat "$ROOT/mac3.log" >&2; fail "macOS: wrong error for corrupted archive"; }
  [ ! -e "$h2/.ultraplan/app" ] && [ ! -e "$h2/.local/bin/ut-todo" ] || fail "macOS: corrupted install left files behind"
  pass "macOS: corrupted archive refused with checksum error, nothing installed"

  if env PATH="$ROOT/emptybin" /bin/sh scripts/install.sh >"$ROOT/mac4.log" 2>&1; then
    fail "macOS: missing prerequisite was not detected"
  fi
  grep -q 'needs curl or wget' "$ROOT/mac4.log" || { cat "$ROOT/mac4.log" >&2; fail "macOS: prerequisite error does not name the cause"; }
  pass "macOS: missing prerequisite named (curl or wget)"
else
  pass "macOS section skipped (host is $(uname -s))"
fi

if [ "$SKIP_DOCKER" = 1 ]; then
  pass "docker sections skipped (--skip-docker)"
else
  command -v docker >/dev/null 2>&1 || fail "docker not found; use --skip-docker to run only the host tests"

  cat > "$ROOT/linux-test.sh" <<'LINUX'
set -eu
apt-get update -qq >/dev/null
apt-get install -y -qq curl ca-certificates >/dev/null
export HOME=/root
if command -v node >/dev/null 2>&1; then echo "FAIL - node unexpectedly present in ubuntu:24.04" >&2; exit 1; fi
# Main case: no Node at all; the installer must fetch the official Node.
ULTRAPLAN_HOME=/root/.ultraplan ULTRAPLAN_BIN_DIR=/root/.local/bin ULTRAPLAN_RELEASE_BASE="$BASE/good" \
  sh /scripts/install.sh > /tmp/lin1.log 2>&1 || { cat /tmp/lin1.log >&2; echo "FAIL - linux fresh install (no node)" >&2; exit 1; }
grep -q 'fetching the official Node' /tmp/lin1.log || { cat /tmp/lin1.log >&2; echo "FAIL - installer did not fetch Node" >&2; exit 1; }
/root/.local/bin/ut-todo --help | grep -q 'ut-todo' || { echo "FAIL - ut-todo --help after install (linux)" >&2; exit 1; }
echo 'ok - linux: no Node present, official Node fetched, ut-todo --help works'
ULTRAPLAN_HOME=/root/.ultraplan ULTRAPLAN_BIN_DIR=/root/.local/bin ULTRAPLAN_RELEASE_BASE="$BASE/good" \
  sh /scripts/install.sh > /tmp/lin2.log 2>&1 || { cat /tmp/lin2.log >&2; echo "FAIL - linux re-run" >&2; exit 1; }
grep -q 'already unpacked' /tmp/lin2.log || { echo "FAIL - linux re-run did not upgrade in place" >&2; exit 1; }
/root/.local/bin/ut-todo --help >/dev/null || { echo "FAIL - ut-todo after re-run (linux)" >&2; exit 1; }
echo 'ok - linux: re-run upgrades in place and reuses the fetched Node'
# A too-old Node on PATH must be ignored in favor of the official build.
mkdir -p /tmp/fakebin
printf '#!/bin/sh\nprintf "18.20.4\\n"\n' > /tmp/fakebin/node
chmod 755 /tmp/fakebin/node
PATH="/tmp/fakebin:$PATH" ULTRAPLAN_HOME=/root/.up2 ULTRAPLAN_BIN_DIR=/root/.local/bin2 ULTRAPLAN_RELEASE_BASE="$BASE/good" \
  sh /scripts/install.sh > /tmp/lin3.log 2>&1 || { cat /tmp/lin3.log >&2; echo "FAIL - linux install with too-old node" >&2; exit 1; }
grep -q 'fetching the official Node' /tmp/lin3.log || { echo "FAIL - too-old Node was not replaced" >&2; exit 1; }
/root/.local/bin2/ut-todo --help >/dev/null || { echo "FAIL - ut-todo with too-old node on PATH" >&2; exit 1; }
echo 'ok - linux: too-old Node on PATH ignored, official Node fetched'
if ULTRAPLAN_HOME=/root/.up3 ULTRAPLAN_BIN_DIR=/root/.local/bin3 ULTRAPLAN_RELEASE_BASE="$BASE/bad" \
  sh /scripts/install.sh > /tmp/lin4.log 2>&1; then
  echo "FAIL - linux: corrupted archive was accepted" >&2; exit 1
fi
grep -q 'checksum mismatch' /tmp/lin4.log || { cat /tmp/lin4.log >&2; echo "FAIL - linux: wrong error for corrupted archive" >&2; exit 1; }
[ ! -e /root/.up3/app ] && [ ! -e /root/.local/bin3/ut-todo ] || { echo "FAIL - linux: corrupted install left files behind" >&2; exit 1; }
echo 'ok - linux: corrupted archive refused with checksum error, nothing installed'
mkdir -p /tmp/emptybin
if PATH=/tmp/emptybin sh /scripts/install.sh > /tmp/lin5.log 2>&1; then
  echo "FAIL - linux: missing prerequisite was not detected" >&2; exit 1
fi
grep -q 'needs curl or wget' /tmp/lin5.log || { cat /tmp/lin5.log >&2; echo "FAIL - linux: prerequisite error does not name the cause" >&2; exit 1; }
echo 'ok - linux: missing prerequisite named (curl or wget)'
LINUX
  docker run --rm -v "$PWD/scripts:/scripts:ro" -v "$ROOT/linux-test.sh:/linux-test.sh:ro" \
    -e BASE="$DOCKER_BASE" ubuntu:24.04 sh /linux-test.sh || fail "ubuntu:24.04 container tests"

  cat > "$ROOT/ps-test.ps1" <<'PSWIN'
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$base = "http://host.docker.internal:$env:TEST_PORT"
$env:ULTRAPLAN_HOME = '/root/.ultraplan'
$env:ULTRAPLAN_BIN_DIR = '/root/.local/bin'
$env:ULTRAPLAN_RELEASE_BASE = "$base/good"
& pwsh -NoProfile -File /scripts/install.ps1
if ($LASTEXITCODE -ne 0) { throw 'install.ps1 failed' }
& /root/.local/bin/ut-todo --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'ut-todo --help failed after install' }
Write-Host 'ok - pwsh: fresh install (no Node present, official Node fetched), ut-todo --help works'
& pwsh -NoProfile -File /scripts/install.ps1
if ($LASTEXITCODE -ne 0) { throw 'install.ps1 re-run failed' }
& /root/.local/bin/ut-todo --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'ut-todo --help failed after re-run' }
Write-Host 'ok - pwsh: re-run upgrades in place'
$env:ULTRAPLAN_HOME = '/root/.ultraplan-bad'
$env:ULTRAPLAN_BIN_DIR = '/root/.local/bin-bad'
$env:ULTRAPLAN_RELEASE_BASE = "$base/bad"
$out = & pwsh -NoProfile -File /scripts/install.ps1 2>&1
if ($LASTEXITCODE -eq 0) { throw 'corrupted archive was accepted' }
if ("$out" -notmatch 'checksum mismatch') { throw "wrong error for corrupted archive: $out" }
if (Test-Path '/root/.ultraplan-bad/app') { throw 'corrupted install left files behind' }
Write-Host 'ok - pwsh: corrupted archive refused with checksum error, nothing installed'
PSWIN
  docker run --rm -v "$PWD/scripts:/scripts:ro" -v "$ROOT/ps-test.ps1:/ps-test.ps1:ro" \
    -e TEST_PORT="$PORT" mcr.microsoft.com/powershell pwsh -NoProfile -File /ps-test.ps1 \
    || fail "PowerShell 7 (Linux) container tests"

  cat > "$ROOT/ps-analyze.ps1" <<'PSA'
$ErrorActionPreference = 'Stop'
try {
  Install-Module PSScriptAnalyzer -Force -Scope CurrentUser
} catch {
  Write-Host "PSScriptAnalyzer skipped: $($_.Exception.Message)"
  exit 0
}
$r = Invoke-ScriptAnalyzer -Path /scripts/install.ps1
if ($r) { $r | Format-Table -AutoSize | Out-String | Write-Host; exit 1 }
Write-Host 'ok - PSScriptAnalyzer: install.ps1 clean'
PSA
  docker run --rm -v "$PWD/scripts:/scripts:ro" -v "$ROOT/ps-analyze.ps1:/ps-analyze.ps1:ro" \
    mcr.microsoft.com/powershell pwsh -NoProfile -File /ps-analyze.ps1 \
    || fail "PSScriptAnalyzer reported findings in install.ps1"
fi

kill "$SRV" 2>/dev/null || true
wait "$SRV" 2>/dev/null || true
SRV=""
if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then
  fail "test server still serving on port $PORT after shutdown"
fi
pass "test server stopped, port $PORT released"
echo "all installer tests passed"