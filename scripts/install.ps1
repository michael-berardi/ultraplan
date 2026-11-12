# UltraPlan installer for Windows:  irm https://github.com/michael-berardi/ultraplan/releases/latest/download/install.ps1 | iex
# Downloads the latest release (the npm pack bundle; UltraPlan has zero runtime dependencies), checks its SHA-256, and
# puts `ut-todo` on your Path. Uses the Node 22.19+ already on this machine, or fetches the official Node into
# UltraPlan's own folder (nothing global). Re-running upgrades in place. No admin rights, no profile edits.
# Runs on Windows PowerShell 5.1 and PowerShell 7; also runs under PowerShell 7 on Linux/macOS for testing, with
# ULTRAPLAN_HOME / ULTRAPLAN_BIN_DIR overrides (defaults there: ~/.ultraplan and ~/.local/bin).
# Environment: ULTRAPLAN_HOME, ULTRAPLAN_BIN_DIR, ULTRAPLAN_VERSION (e.g. 0.3.0), ULTRAPLAN_RELEASE_BASE (tests).
function Install-UltraPlan {
  param([switch]$DefineHelpersOnly)
  # Helpers live inside this function so `irm | iex` leaves nothing behind in the user's session.
  $ShimMarker = 'ultraplan-installer-shim'

  # Run a native command and capture its output. Windows PowerShell 5.1 turns the first stderr line of a native command
  # into a terminating error under $ErrorActionPreference = 'Stop' when stderr is redirected, so relax it for the call.
  function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments = @())
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $out = & $Exe @Arguments 2>&1
      $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
    [pscustomobject]@{ Code = $code; Output = ((@($out) | ForEach-Object { "$_" }) -join "`n").Trim() }
  }

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
      $r = Invoke-Native -Exe $Exe -Arguments @('-p', 'process.versions.node')
      if ($r.Code -ne 0 -or -not $r.Output) { return $false }
      $p = $r.Output.Split('.')
      return ([int]$p[0] -gt 22) -or ([int]$p[0] -eq 22 -and [int]$p[1] -ge 19)
    } catch { return $false }
  }

  # Absolute, normalised path (no `..`, no `/` mix-ups, relative overrides resolved against the current folder).
  function Resolve-FullPath {
    param([string]$Path)
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  }

  # Path of $Path relative to $Base using backslashes, or $null when $Path is not inside $Base. Windows paths are case-insensitive.
  function Get-RelativeInside {
    param([string]$Base, [string]$Path)
    $b = ($Base -replace '/', '\').TrimEnd('\')
    $p = ($Path -replace '/', '\')
    if ($p.Length -gt $b.Length + 1 -and $p.StartsWith($b + '\', [StringComparison]::OrdinalIgnoreCase)) { return $p.Substring($b.Length + 1) }
    return $null
  }

  # Text of ut-todo.cmd. When the shim and its targets are all under the tool's own home, paths are relative to the shim
  # (%~dp0), so a non-ASCII user profile cannot break them. Otherwise absolute paths are used (the caller writes them in the OEM code page).
  function Get-CmdShimText {
    param([string]$HomeDir, [string]$BinDir, [string]$NodeBin, [string]$BinPath, [bool]$NodeOnPath)
    $binRel = Get-RelativeInside -Base $HomeDir -Path $BinDir
    $depth = if ($null -ne $binRel) { @($binRel -split '\\' | Where-Object { $_ }).Count } else { -1 }
    $up = if ($depth -ge 0) { '%~dp0' + ('..\' * $depth) } else { $null }
    $scriptRel = Get-RelativeInside -Base $HomeDir -Path $BinPath
    $nodeRel = Get-RelativeInside -Base $HomeDir -Path $NodeBin
    $scriptRef = if ($up -and $scriptRel) { "$up$scriptRel" } else { $BinPath }
    $nodeRef = if ($NodeOnPath) { 'node' } elseif ($up -and $nodeRel) { "$up$nodeRel" } else { $NodeBin }
    "@echo off`r`nREM $ShimMarker`r`n`"$nodeRef`" `"$scriptRef`" %*`r`n"
  }

  # True when the file at $Path was written by this installer (marker line, or the 0.4.0 shape without a marker).
  function Test-OurShim {
    param([string]$Path)
    try { $t = [IO.File]::ReadAllText($Path) } catch { return $false }
    return ($t.Contains($ShimMarker)) -or ($t -match '[\\/]app[\\/]release-[^\\/"]+[\\/]bin[\\/]ut-todo')
  }

  function Write-ShimFile {
    param([string]$Path, [string]$Text, [bool]$Oem)
    $enc = New-Object System.Text.UTF8Encoding $false
    if ($Oem) {
      try { $enc = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage) }
      catch { $enc = [Text.Encoding]::ASCII }
    }
    [IO.File]::WriteAllText($Path, $Text, $enc)
  }


  # True when $UserPath (the raw, unexpanded semicolon list) already holds $BinDir: an entry equals it literally, or after
  # %VAR% expansion, ignoring case and a trailing backslash.
  function Test-PathEntryPresent {
    param([string]$UserPath, [string]$BinDir)
    $want = $BinDir.TrimEnd('\')
    $hits = @($UserPath -split ';' | Where-Object {
      $_ -and (($_.TrimEnd('\') -ieq $want) -or ([Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $want))
    })
    return ($hits.Count -gt 0)
  }

  if ($DefineHelpersOnly) { return }
  $ErrorActionPreference = 'Stop'
  $PSNativeCommandUseErrorActionPreference = $false
  $ProgressPreference = 'SilentlyContinue'
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
  $homeDir = Resolve-FullPath $homeDir
  $binDir = if ($env:ULTRAPLAN_BIN_DIR) { $env:ULTRAPLAN_BIN_DIR }
            elseif ($isWin) { Join-Path $homeDir 'bin' }
            else { Join-Path $HOME '.local/bin' }
  $binDir = Resolve-FullPath $binDir
  $appDir = Join-Path $homeDir 'app'

  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    throw 'needs tar to unpack the release; Windows 10 1803 and newer ship tar.exe in System32, or install it with your package manager'
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ultraplan-install-' + [guid]::NewGuid())
  $staging = $null
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host 'Downloading UltraPlan...'
    $tgz = Join-Path $tmp 'ultraplan.tar.gz'
    $sums = Join-Path $tmp 'SHA256SUMS'
    Invoke-Download -Url "$base/ultraplan.tar.gz" -OutFile $tgz
    Invoke-Download -Url "$base/SHA256SUMS" -OutFile $sums
    Test-Checksum -File $tgz -Name 'ultraplan.tar.gz' -SumsFile $sums

    # Unpack straight into a staging folder under the tool's own home: moving a folder from %TEMP% to another drive fails on Windows PowerShell 5.1.
    $staging = Join-Path $appDir ('.staging-' + [guid]::NewGuid())
    $src = Join-Path $staging 'src'
    New-Item -ItemType Directory -Path $src -Force | Out-Null
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
        $nodeTmp = Join-Path $staging 'node'
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
      $r = Invoke-Native -Exe $nodeBin -Arguments @((Join-Path $relTmp 'bin/ut-todo'), '--help')
      if ($r.Code -ne 0 -or $r.Output -notmatch 'ut-todo') {
        Remove-Item -Recurse -Force $relTmp
        throw "the new copy does not start: $($r.Output)"
      }
      Move-Item -Path $relTmp -Destination $rel
    } else {
      Write-Host "UltraPlan $version is already unpacked; relinking."
    }

    # `ut-todo` on Path: a shim pinned to the Node that was verified above. It carries a marker line; a file at that
    # path without the marker is the user's own and is left alone.
    $binPath = Join-Path $rel 'bin/ut-todo'
    $shim = Join-Path $binDir $(if ($isWin) { 'ut-todo.cmd' } else { 'ut-todo' })
    $ours = $true
    if ((Test-Path -LiteralPath $shim) -and -not (Test-OurShim -Path $shim)) {
      $ours = $false
      Write-Host "$shim already exists and was not written by this installer; left alone."
    }
    if ($ours) {
      if ($isWin) {
        $onPath = [bool]($sysNode -and $nodeBin -eq $sysNode.Source)
        $shimText = Get-CmdShimText -HomeDir $homeDir -BinDir $binDir -NodeBin $nodeBin -BinPath $binPath -NodeOnPath $onPath
      } else {
        $shimText = "#!/bin/sh`n# $ShimMarker`nexec `"$nodeBin`" `"$binPath`" `"`$@`"`n"
      }
      Write-ShimFile -Path "$shim.tmp" -Text $shimText -Oem $isWin
      if (-not $isWin) { & chmod 755 "$shim.tmp"; if ($LASTEXITCODE -ne 0) { throw 'cannot make the ut-todo shim executable' } }
      Move-Item -Path "$shim.tmp" -Destination $shim -Force
    }

    # Only the release the shim points at is kept; older release folders are removed.
    Get-ChildItem -Path $appDir -Directory -Filter 'release-*' |
      Where-Object { $_.Name -ne "release-$version" } |
      ForEach-Object { Remove-Item -Recurse -Force -LiteralPath $_.FullName -ErrorAction SilentlyContinue }

    # Finish with the tool's own health command; a failed check fails the install.
    $r = if ($ours) { Invoke-Native -Exe $shim -Arguments @('--help') } else { Invoke-Native -Exe $nodeBin -Arguments @($binPath, '--help') }
    if ($r.Code -ne 0) { throw "the installed ut-todo does not run: $($r.Output)" }
    if ($ours) { Write-Host "UltraPlan $version installed ($shim)." }
    else { Write-Host "UltraPlan $version installed; run it with: $nodeBin $binPath" }
    Write-Host $r.Output
    if ($isWin) {
      # Add the bin folder to the USER Path only when absent. The raw value is read without expanding %VAR% entries and
      # written back with its original registry type, so a stock %USERPROFILE%\... entry keeps expanding.
      $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
      try {
        $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if (-not (Test-PathEntryPresent -UserPath $userPath -BinDir $binDir)) {
          $newPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $binDir } else { $binDir }
          $kind = if ($null -ne $envKey.GetValue('Path', $null)) { $envKey.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
          $envKey.SetValue('Path', $newPath, $kind)
          # Setting and clearing a dummy user variable broadcasts the change so new terminals pick the Path up.
          [Environment]::SetEnvironmentVariable('ULTRAPLAN_PATH_REFRESH', '1', 'User')
          [Environment]::SetEnvironmentVariable('ULTRAPLAN_PATH_REFRESH', $null, 'User')
          Write-Host "Added $binDir to your user Path; open a new terminal to use ut-todo."
        }
      } finally { if ($envKey) { $envKey.Close() } }
    } else {
      if (($env:PATH -split ':') -notcontains $binDir) {
        Write-Host "Add $binDir to your PATH:  export PATH=`"$binDir`:`$PATH`""
      }
    }
    Write-Host "Next: ut-todo init 'Inspect:read code' 'Build:ship'"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    if ($staging) { Remove-Item -Recurse -Force -LiteralPath $staging -ErrorAction SilentlyContinue }
  }
}

# Tests set the PowerShell variable $global:UltraPlanTestLibrary (an environment variable cannot) and then run
# `. Install-UltraPlan -DefineHelpersOnly` to load the helper functions without installing.
if (-not (Get-Variable -Name UltraPlanTestLibrary -Scope Global -ErrorAction SilentlyContinue)) { Install-UltraPlan }
