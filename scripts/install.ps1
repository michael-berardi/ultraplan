# UltraPlan installer for Windows:  irm https://github.com/michael-berardi/ultraplan/releases/latest/download/install.ps1 | iex
# Downloads the latest release (the npm pack bundle; UltraPlan has zero runtime dependencies), checks its SHA-256, and
# puts `ut-todo` on your Path. Uses the Node 22.19+ already on this machine, or fetches the official Node into
# UltraPlan's own folder (nothing global). Re-running upgrades in place. No admin rights, no profile edits.
# Runs on Windows PowerShell 5.1 and PowerShell 7; also runs under PowerShell 7 on Linux/macOS for testing, with
# ULTRAPLAN_HOME / ULTRAPLAN_BIN_DIR overrides (defaults there: ~/.ultraplan and ~/.local/bin).
# Environment: ULTRAPLAN_HOME, ULTRAPLAN_BIN_DIR, ULTRAPLAN_VERSION (e.g. 0.3.0), ULTRAPLAN_RELEASE_BASE (tests).
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repo = 'michael-berardi/ultraplan'
# Windows PowerShell 5.1 has no $IsWindows; its absence means Windows.
$isWin = (-not (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue)) -or $IsWindows
if ($isWin -and $PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$base = if ($env:ULTRAPLAN_RELEASE_BASE) { $env:ULTRAPLAN_RELEASE_BASE }
        elseif ($env:ULTRAPLAN_VERSION) { "https://github.com/$repo/releases/download/v$($env:ULTRAPLAN_VERSION.TrimStart('v'))" }
        else { "https://github.com/$repo/releases/latest/download" }
$homeDir = if ($env:ULTRAPLAN_HOME) { $env:ULTRAPLAN_HOME }
           elseif ($isWin) { Join-Path $env:LOCALAPPDATA 'UltraPlan' }
           else { Join-Path $HOME '.ultraplan' }
$binDir = if ($env:ULTRAPLAN_BIN_DIR) { $env:ULTRAPLAN_BIN_DIR }
          elseif ($isWin) { Join-Path $homeDir 'bin' }
          else { Join-Path $HOME '.local/bin' }
$appDir = Join-Path $homeDir 'app'

function Invoke-Download {
  param([string]$Url, [string]$OutFile)
  try { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing }
  catch { throw "download failed: $Url ($($_.Exception.Message))" }
}

function Get-Sha256 {
  param([string]$File)
  (Get-FileHash -Path $File -Algorithm SHA256).Hash.ToLower()
}

function Test-Checksum {
  param([string]$File, [string]$Name, [string]$SumsFile)
  $line = Get-Content -Path $SumsFile | Where-Object { $_ -match "\s$([regex]::Escape($Name))$" } | Select-Object -First 1
  if (-not $line) { throw "no checksum for $Name in $(Split-Path -Leaf $SumsFile)" }
  $want = ($line -split '\s+')[0].ToLower()
  if ((Get-Sha256 -File $File) -ne $want) { throw "checksum mismatch for $Name; nothing was installed" }
}

function Test-NodeOk {
  param([string]$Exe)
  try {
    $v = & $Exe -p 'process.versions.node' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $v) { return $false }
    $p = "$v".Trim().Split('.')
    return ([int]$p[0] -gt 22) -or ([int]$p[0] -eq 22 -and [int]$p[1] -ge 19)
  } catch { return $false }
}

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  throw 'needs tar to unpack the release; Windows 10 1803 and newer ship tar.exe in System32, or install it with your package manager'
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('ultraplan-install-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host 'Downloading UltraPlan...'
  $tgz = Join-Path $tmp 'ultraplan.tar.gz'
  $sums = Join-Path $tmp 'SHA256SUMS'
  Invoke-Download -Url "$base/ultraplan.tar.gz" -OutFile $tgz
  Invoke-Download -Url "$base/SHA256SUMS" -OutFile $sums
  Test-Checksum -File $tgz -Name 'ultraplan.tar.gz' -SumsFile $sums

  $src = Join-Path $tmp 'src'
  New-Item -ItemType Directory -Path $src | Out-Null
  & tar -xzf $tgz -C $src --strip-components=1
  if ($LASTEXITCODE -ne 0) { throw 'cannot unpack the download' }
  if (-not (Test-Path (Join-Path $src 'package.json')) -or -not (Test-Path (Join-Path $src 'bin/ut-todo'))) {
    throw 'the download is not an UltraPlan release'
  }
  $version = (Get-Content -Raw -Path (Join-Path $src 'package.json') | ConvertFrom-Json).version
  if (-not $version) { throw 'cannot read the release version' }
  $rel = Join-Path $appDir "release-$version"

  # Node: the one on Path when it is new enough, else the official build, kept inside UltraPlan's own folder.
  $nodeBin = $null
  $sysNode = Get-Command node -ErrorAction SilentlyContinue
  if ($sysNode -and (Test-NodeOk -Exe $sysNode.Source)) { $nodeBin = $sysNode.Source }
  if (-not $nodeBin) {
    if ($isWin) {
      $os = 'win'
      $arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { $null } }
    } else {
      $os = if ($IsMacOS) { 'darwin' } else { 'linux' }
      $arch = switch ((& uname -m).Trim()) { 'x86_64' { 'x64' } 'amd64' { 'x64' } 'arm64' { 'arm64' } 'aarch64' { 'arm64' } default { $null } }
    }
    if (-not $arch) { throw "unsupported CPU; cannot fetch an official Node build for this machine" }
    Write-Host "Node 22.19 or newer not found; fetching the official Node 22 LTS for $os-$arch..."
    $nbase = 'https://nodejs.org/dist/latest-v22.x'
    $nsums = Join-Path $tmp 'NODESUMS'
    Invoke-Download -Url "$nbase/SHASUMS256.txt" -OutFile $nsums
    $ext = if ($isWin) { 'zip' } else { 'tar.gz' }
    $nname = (Get-Content -Path $nsums | ForEach-Object { ($_ -split '\s+')[1] } |
              Where-Object { $_ -like "*-$os-$arch.$ext" } | Select-Object -First 1)
    if (-not $nname) { throw "no official Node build for $os-$arch" }
    $nfile = Join-Path $tmp $nname
    Invoke-Download -Url "$nbase/$nname" -OutFile $nfile
    Test-Checksum -File $nfile -Name $nname -SumsFile $nsums
    $nver = ($nname -replace '^node-v', '' -replace '-.*$', '')
    $runtime = Join-Path $appDir 'runtime'
    $nodeDir = Join-Path $runtime "node-$nver-$os-$arch"
    $nodeExe = if ($isWin) { Join-Path $nodeDir 'node.exe' } else { Join-Path $nodeDir 'bin/node' }
    if (-not (Test-Path $nodeExe)) {
      New-Item -ItemType Directory -Path $runtime -Force | Out-Null
      $nodeTmp = "$nodeDir.tmp"
      if (Test-Path $nodeTmp) { Remove-Item -Recurse -Force $nodeTmp }
      New-Item -ItemType Directory -Path $nodeTmp -Force | Out-Null
      if ($isWin) {
        Expand-Archive -Path $nfile -DestinationPath $nodeTmp
        $inner = Join-Path $nodeTmp ($nname -replace '\.zip$', '')
      } else {
        & tar -xzf $nfile -C $nodeTmp --strip-components=1
        if ($LASTEXITCODE -ne 0) { throw 'cannot unpack Node' }
        $inner = $nodeTmp
      }
      if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
      Move-Item -Path $inner -Destination $nodeDir
      if (Test-Path $nodeTmp) { Remove-Item -Recurse -Force $nodeTmp }
    }
    $nodeBin = $nodeExe
    if (-not (Test-NodeOk -Exe $nodeBin)) { throw 'the downloaded Node does not run on this machine' }
  }

  New-Item -ItemType Directory -Path $appDir, $binDir -Force | Out-Null
  if (-not (Test-Path $rel)) {
    Write-Host "Installing UltraPlan $version..."
    $relTmp = "$rel.tmp"
    if (Test-Path $relTmp) { Remove-Item -Recurse -Force $relTmp }
    Move-Item -Path $src -Destination $relTmp
    # Zero runtime dependencies: the npm pack bundle runs as unpacked, no npm install step.
    $got = & $nodeBin (Join-Path $relTmp 'bin/ut-todo') --help 2>&1
    if ($LASTEXITCODE -ne 0 -or "$got" -notmatch 'ut-todo') {
      Remove-Item -Recurse -Force $relTmp
      throw "the new copy does not start: $got"
    }
    Move-Item -Path $relTmp -Destination $rel
  } else {
    Write-Host "UltraPlan $version is already unpacked; relinking."
  }

  # `ut-todo` on Path: a shim pinned to the Node that was verified above.
  $binPath = Join-Path $rel 'bin/ut-todo'
  if ($isWin) {
    $shim = Join-Path $binDir 'ut-todo.cmd'
    $nodeRef = if ($sysNode -and $nodeBin -eq $sysNode.Source) { 'node' } else { "`"$nodeBin`"" }
    $shimText = "@echo off`r`n$nodeRef `"$binPath`" %*`r`n"
  } else {
    $shim = Join-Path $binDir 'ut-todo'
    $shimText = "#!/bin/sh`nexec `"$nodeBin`" `"$binPath`" `"`$@`"`n"
  }
  Set-Content -Path "$shim.tmp" -Value $shimText -NoNewline -Encoding Ascii
  if (-not $isWin) { & chmod 755 "$shim.tmp"; if ($LASTEXITCODE -ne 0) { throw 'cannot make the ut-todo shim executable' } }
  Move-Item -Path "$shim.tmp" -Destination $shim -Force

  # Only the release the shim points at is kept; older release folders are removed.
  Get-ChildItem -Path $appDir -Directory -Filter 'release-*' |
    Where-Object { $_.FullName -ne $rel } |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

  # Finish with the tool's own health command; a failed check fails the install.
  $got = & $shim --help 2>&1
  if ($LASTEXITCODE -ne 0) { throw "the installed ut-todo does not run: $got" }
  Write-Host "UltraPlan $version installed ($shim)."
  Write-Host "$got"
  if ($isWin) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -notcontains $binDir) {
      [Environment]::SetEnvironmentVariable('Path', (($parts + $binDir) -join ';'), 'User')
      Write-Host "Added $binDir to your user Path; open a new terminal to use ut-todo."
    }
  } else {
    if (($env:PATH -split ':') -notcontains $binDir) {
      Write-Host "Add $binDir to your PATH:  export PATH=`"$binDir`:`$PATH`""
    }
  }
  Write-Host "Next: ut-todo init 'Inspect:read code' 'Build:ship'"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}