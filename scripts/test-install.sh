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
# The workspace lives under dist/ (gitignored): the Docker VM shares the checkout path, not $TMPDIR.
ROOT=$(mktemp -d "$PWD/dist/test-install.XXXXXX")
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
if PATH=/tmp/emptybin /bin/sh /scripts/install.sh > /tmp/lin5.log 2>&1; then
  echo "FAIL - linux: missing prerequisite was not detected" >&2; exit 1
fi
grep -q 'needs curl or wget' /tmp/lin5.log || { cat /tmp/lin5.log >&2; echo "FAIL - linux: prerequisite error does not name the cause" >&2; exit 1; }
echo 'ok - linux: missing prerequisite named (curl or wget)'
# install.sh: a foreign ut-todo is left alone; a marker wrapper is upgraded; Node on PATH is pinned by absolute path.
mkdir -p /tmp/w7bin
printf '#!/bin/sh\necho mine\n' > /tmp/w7bin/ut-todo; chmod 755 /tmp/w7bin/ut-todo
ULTRAPLAN_HOME=/root/.up7 ULTRAPLAN_BIN_DIR=/tmp/w7bin ULTRAPLAN_RELEASE_BASE="$BASE/good" \
  sh /scripts/install.sh > /tmp/lin7.log 2>&1 || { cat /tmp/lin7.log >&2; echo "FAIL - linux install beside a foreign ut-todo" >&2; exit 1; }
grep -q 'left alone' /tmp/lin7.log || { echo "FAIL - foreign ut-todo not reported" >&2; exit 1; }
grep -q 'echo mine' /tmp/w7bin/ut-todo || { echo "FAIL - foreign ut-todo was overwritten" >&2; exit 1; }
rm /tmp/w7bin/ut-todo
ULTRAPLAN_HOME=/root/.up7 ULTRAPLAN_BIN_DIR=/tmp/w7bin ULTRAPLAN_RELEASE_BASE="$BASE/good" sh /scripts/install.sh > /tmp/lin8.log 2>&1 || { cat /tmp/lin8.log >&2; exit 1; }
grep -q 'ultraplan-installer-shim' /tmp/w7bin/ut-todo || { echo "FAIL - wrapper has no marker" >&2; exit 1; }
ULTRAPLAN_HOME=/root/.up7 ULTRAPLAN_BIN_DIR=/tmp/w7bin ULTRAPLAN_RELEASE_BASE="$BASE/good" sh /scripts/install.sh > /tmp/lin9.log 2>&1 || { cat /tmp/lin9.log >&2; exit 1; }
if grep -q 'left alone' /tmp/lin9.log; then echo "FAIL - own marker wrapper treated as foreign" >&2; exit 1; fi
echo 'ok - linux: foreign ut-todo left alone, marker wrapper upgraded'
NODEDIR=$(dirname "$(ls /root/.ultraplan/app/runtime/node-*/bin/node)")
PATH="$NODEDIR:$PATH" ULTRAPLAN_HOME=/root/.up8 ULTRAPLAN_BIN_DIR=/root/.local/bin8 ULTRAPLAN_RELEASE_BASE="$BASE/good" \
  sh /scripts/install.sh > /tmp/lin10.log 2>&1 || { cat /tmp/lin10.log >&2; exit 1; }
grep -q "^exec \"$NODEDIR/node\"" /root/.local/bin8/ut-todo || { cat /root/.local/bin8/ut-todo >&2; echo "FAIL - wrapper does not pin the absolute node path" >&2; exit 1; }
echo 'ok - linux: wrapper pins the absolute node path'
LINUX
  docker run --rm -v "$PWD/scripts:/scripts:ro" -v "$ROOT/linux-test.sh:/linux-test.sh:ro" \
    -e BASE="$DOCKER_BASE" ubuntu:24.04 sh /linux-test.sh || fail "ubuntu:24.04 container tests"

# mcr.microsoft.com/powershell publishes no arm64 Linux image (amd64 and 32-bit arm only), so the
# PowerShell 7 tests run in a small local image: ubuntu:24.04 plus Microsoft's official tarball.
PS_VERSION=7.4.6
PWSH_IMAGE="pwsh-install-test:$PS_VERSION"
if ! docker image inspect "$PWSH_IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$PWSH_IMAGE" - >/dev/null <<DOCKERFILE || fail "cannot build the PowerShell $PS_VERSION test image"
FROM ubuntu:24.04
RUN apt-get update -qq && apt-get install -y -qq ca-certificates curl libicu74 >/dev/null \\
 && case "\$(uname -m)" in aarch64) a=arm64 ;; x86_64) a=x64 ;; *) echo "unsupported CPU \$(uname -m)" >&2; exit 1 ;; esac \\
 && curl -fsSL --retry 3 -o /tmp/ps.tgz "https://github.com/PowerShell/PowerShell/releases/download/v$PS_VERSION/powershell-$PS_VERSION-linux-\$a.tar.gz" \\
 && mkdir -p /opt/powershell && tar -xzf /tmp/ps.tgz -C /opt/powershell && chmod +x /opt/powershell/pwsh \\
 && ln -s /opt/powershell/pwsh /usr/bin/pwsh && rm /tmp/ps.tgz
DOCKERFILE
fi
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
    -e TEST_PORT="$PORT" "$PWSH_IMAGE" pwsh -NoProfile -File /ps-test.ps1 \
    || fail "PowerShell 7 (Linux) container tests"

  cat > "$ROOT/ps-unit.ps1" <<'PSUNIT'
$ErrorActionPreference = 'Stop'
$global:UltraPlanTestLibrary = $true
. /scripts/install.ps1
. Install-UltraPlan -DefineHelpersOnly
function Assert-Eq($got, $want, $what) { if ($got -ne $want) { throw "$what`n got:  $got`n want: $want" } }
# W1: shim paths relative to the shim when everything is under the tool home, absolute otherwise.
$t = Get-CmdShimText -HomeDir 'C:\Users\José\AppData\Local\UltraPlan' -BinDir 'C:\Users\José\AppData\Local\UltraPlan\bin' `
  -NodeBin 'C:\Users\José\AppData\Local\UltraPlan\app\runtime\node-22.20.0-win-x64\node.exe' `
  -BinPath 'C:\Users\José\AppData\Local\UltraPlan\app\release-0.4.1\bin\ut-todo' -NodeOnPath $false
Assert-Eq $t "@echo off`r`nREM ultraplan-installer-shim`r`n`"%~dp0..\app\runtime\node-22.20.0-win-x64\node.exe`" `"%~dp0..\app\release-0.4.1\bin\ut-todo`" %*`r`n" 'relative shim'
if ($t -match 'José') { throw 'relative shim still names the profile' }
$t = Get-CmdShimText -HomeDir 'C:\h\UP' -BinDir 'D:\tools\bin' -NodeBin 'C:\h\UP\app\n\node.exe' -BinPath 'C:\h\UP\app\release-1\bin\ut-todo' -NodeOnPath $true
Assert-Eq $t "@echo off`r`nREM ultraplan-installer-shim`r`n`"node`" `"C:\h\UP\app\release-1\bin\ut-todo`" %*`r`n" 'absolute shim for a bin dir elsewhere, node on PATH'
$t = Get-CmdShimText -HomeDir 'C:\h\UP' -BinDir 'c:/h/up/a/b' -NodeBin 'C:\Program Files\nodejs\node.exe' -BinPath 'C:\h\UP\app\release-1\bin\ut-todo' -NodeOnPath $false
Assert-Eq $t "@echo off`r`nREM ultraplan-installer-shim`r`n`"C:\Program Files\nodejs\node.exe`" `"%~dp0..\..\app\release-1\bin\ut-todo`" %*`r`n" 'nested bin dir, mixed slashes'
# W4: a relative or slash-mixed override resolves to an absolute path.
Push-Location /tmp
$r = Resolve-FullPath 'rel/../x/./y'
Pop-Location
Assert-Eq $r '/tmp/x/y' 'Resolve-FullPath'
# W7: marker handling.
$d = '/tmp/shimtest'; New-Item -ItemType Directory -Force $d | Out-Null
Set-Content "$d/ours" "#!/bin/sh`n# ultraplan-installer-shim`nexec node x"
Set-Content "$d/legacy" "#!/bin/sh`nexec `"/r/.ultraplan/app/release-0.4.0/bin/ut-todo`""
Set-Content "$d/theirs" "#!/bin/sh`necho mine"
if (-not (Test-OurShim "$d/ours")) { throw 'marker shim not recognised' }
if (-not (Test-OurShim "$d/legacy")) { throw '0.4.0 shim not recognised' }
if (Test-OurShim "$d/theirs") { throw 'foreign file taken for our shim' }
# W3: Invoke-Native captures stderr and the exit code without a terminating error.
$r = Invoke-Native -Exe 'sh' -Arguments @('-c', 'echo out; echo err >&2; exit 3')
Assert-Eq $r.Code 3 'exit code'
if ($r.Output -notmatch 'err') { throw "stderr not captured: $($r.Output)" }
Assert-Eq $ErrorActionPreference 'Stop' 'ErrorActionPreference restored'
# Path entry comparison: literal, expanded, case and trailing backslash.
$env:UP_T = 'C:\Tools'
if (-not (Test-PathEntryPresent -UserPath 'C:\a;C:\Bin\;D:\x' -BinDir 'c:\bin')) { throw 'literal entry not found' }
if (-not (Test-PathEntryPresent -UserPath 'C:\a;%UP_T%\bin' -BinDir 'C:\Tools\bin')) { throw 'expanded entry not found' }
if (Test-PathEntryPresent -UserPath 'C:\a;C:\Binary' -BinDir 'C:\Bin') { throw 'prefix matched' }
if (Test-PathEntryPresent -UserPath '' -BinDir 'C:\Bin') { throw 'empty path matched' }
Write-Host 'ok - pwsh: shim paths, path normalisation, shim marker, native capture, path entry match'
PSUNIT
  docker run --rm -v "$PWD/scripts:/scripts:ro" -v "$ROOT/ps-unit.ps1:/ps-unit.ps1:ro" \
    "$PWSH_IMAGE" pwsh -NoProfile -File /ps-unit.ps1 || fail "PowerShell 7 unit tests"

  cat > "$ROOT/ps-w4.ps1" <<'PSW4'
$ErrorActionPreference = 'Stop'
$base = "http://host.docker.internal:$env:TEST_PORT"
# Foreign file at the shim path is left alone; a relative HOME override with a second install keeps the new release.
New-Item -ItemType Directory -Force /root/w/bin | Out-Null
Set-Content /root/w/bin/ut-todo "#!/bin/sh`necho mine"
Set-Location /root/w
$env:ULTRAPLAN_HOME = './up/../up'; $env:ULTRAPLAN_BIN_DIR = 'bin'; $env:ULTRAPLAN_RELEASE_BASE = "$base/good"
$out = & pwsh -NoProfile -File /scripts/install.ps1 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "install failed: $out" }
if ($out -notmatch 'left alone') { throw "no left-alone message: $out" }
if ((Get-Content /root/w/bin/ut-todo -Raw) -notmatch 'echo mine') { throw 'foreign file was overwritten' }
$rels = @(Get-ChildItem /root/w/up/app -Directory -Filter 'release-*')
if ($rels.Count -ne 1) { throw 'relative HOME: the installed release was deleted' }
if (Get-ChildItem /root/w/up/app -Force -Filter '.staging-*') { throw 'staging folder left behind' }
if (-not (Test-Path /root/w/up/app/runtime)) { throw 'runtime missing' }
& pwsh -NoProfile -File /scripts/install.ps1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 're-run failed' }
@(Get-ChildItem /root/w/up/app -Directory -Filter 'release-*').Count | ForEach-Object { if ($_ -ne 1) { throw 'release lost on re-run' } }
Remove-Item /root/w/bin/ut-todo
& pwsh -NoProfile -File /scripts/install.ps1 | Out-Null
if ((Get-Content /root/w/bin/ut-todo -Raw) -notmatch 'ultraplan-installer-shim') { throw 'shim has no marker' }
& pwsh -NoProfile -File /scripts/install.ps1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'marker shim was not recognised as ours on re-run' }
Write-Host 'ok - pwsh: relative HOME keeps the release, foreign file left alone, marker shim upgraded, no staging left'
PSW4
  docker run --rm -v "$PWD/scripts:/scripts:ro" -v "$ROOT/ps-w4.ps1:/ps-w4.ps1:ro" \
    -e TEST_PORT="$PORT" "$PWSH_IMAGE" pwsh -NoProfile -File /ps-w4.ps1 \
    || fail "PowerShell 7 relative-path and shim-marker tests"

  cat > "$ROOT/ps-analyze.ps1" <<'PSA'
$ErrorActionPreference = 'Stop'
try {
  Install-Module PSScriptAnalyzer -Force -Scope CurrentUser
} catch {
  Write-Host "PSScriptAnalyzer skipped: $($_.Exception.Message)"
  exit 0
}
# Write-Host is intended in an interactive installer, so only errors fail the test.
$r = @(Invoke-ScriptAnalyzer -Path /scripts/install.ps1 -ExcludeRule PSAvoidUsingWriteHost)
if ($r.Count -gt 0) { $r | Format-Table -AutoSize | Out-String | Write-Host }
if (@($r | Where-Object Severity -eq 'Error').Count -gt 0) { exit 1 }
Write-Host 'ok - PSScriptAnalyzer: install.ps1 has no errors'
PSA
  docker run --rm -v "$PWD/scripts:/scripts:ro" -v "$ROOT/ps-analyze.ps1:/ps-analyze.ps1:ro" \
    "$PWSH_IMAGE" pwsh -NoProfile -File /ps-analyze.ps1 \
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