import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ps1 = readFileSync(`${ROOT}scripts/install.ps1`, "utf8");
const sh = readFileSync(`${ROOT}scripts/install.sh`, "utf8");

// Static guards for Windows-only behaviour that cannot run under PowerShell 7 on Linux.
describe("install.ps1 Windows guards", () => {
  it("never reads or writes the user Path through [Environment] (it expands and drops REG_EXPAND_SZ)", () => {
    expect(ps1).not.toMatch(/SetEnvironmentVariable\('Path'/i);
    expect(ps1).not.toMatch(/GetEnvironmentVariable\('Path'/i);
    expect(ps1).toMatch(/DoNotExpandEnvironmentNames/);
    expect(ps1).toMatch(/GetValueKind\('Path'\)/);
  });
  it("defines helpers inside Install-UltraPlan and has no env-var-only test hook", () => {
    expect(ps1).not.toMatch(/ULTRAPLAN_PS_TEST_LIBRARY/);
    expect(ps1).not.toMatch(/^function (?!Install-UltraPlan)/m);
    expect(ps1).not.toMatch(/\$script:/);
  });
  it("install.sh runs the fallback health check without an unquoted command", () => {
    expect(sh).not.toMatch(/\$CMD\b/);
  });
  it("never writes a shim with -Encoding Ascii", () => {
    expect(ps1).not.toMatch(/Set-Content[^\n]*-Encoding\s+Ascii/i);
  });
  it("writes the shim with the OEM code page", () => {
    expect(ps1).toMatch(/OEMCodePage/);
  });
  it("uses %~dp0-relative paths in the cmd shim", () => {
    expect(ps1).toContain("%~dp0");
  });
  it("never moves a folder out of %TEMP% (staging lives under the tool home)", () => {
    expect(ps1).not.toMatch(/Move-Item[^\n]*-Path\s+\$src\s+-Destination\s+\$rel\b/);
    expect(ps1).toMatch(/\$staging\s*=\s*Join-Path\s+\$appDir/);
    expect(ps1).not.toMatch(/Join-Path\s+\$tmp\s+'src'/);
  });
  it("redirects stderr only inside Invoke-Native, which relaxes ErrorActionPreference", () => {
    const body = ps1.match(/function Invoke-Native \{[\s\S]*?\n  \}\n/)![0];
    expect(body).toMatch(/\$ErrorActionPreference\s*=\s*'Continue'/);
    const outside = ps1.replace(body, "");
    expect(outside).not.toMatch(/2>&1|2>\$null/);
  });
  it("normalises the home and bin overrides and never compares FullName to the release path", () => {
    expect(ps1).toMatch(/\$homeDir\s*=\s*Resolve-FullPath/);
    expect(ps1).toMatch(/\$binDir\s*=\s*Resolve-FullPath/);
    expect(ps1).toMatch(/GetUnresolvedProviderPathFromPSPath/);
    expect(ps1).not.toMatch(/FullName\s+-ne\s+\$rel/);
  });
  it("wraps the body in a function, calls it last, and never exits the user's shell", () => {
    expect(ps1).toMatch(/function Install-UltraPlan \{\s*\n\s*param\(\[switch\]\$DefineHelpersOnly\)[\s\S]*?\n\s*\$ErrorActionPreference = 'Stop'\n\s*\$PSNativeCommandUseErrorActionPreference/);
    expect(ps1.trimEnd().split("\n").pop()).toMatch(/Install-UltraPlan/);
    expect(ps1).not.toMatch(/^\s*exit\b/m);
    expect(ps1.split("function Install-UltraPlan")[0]).not.toMatch(/^\$ErrorActionPreference/m);
  });
  it("opts in to TLS 1.2 and silences the progress bar", () => {
    expect(ps1).toMatch(/SecurityProtocolType\]::Tls12/);
    expect(ps1).toMatch(/\$ProgressPreference\s*=\s*'SilentlyContinue'/);
  });
  it("marks its shim and checks the marker before overwriting", () => {
    expect(ps1).toMatch(/ultraplan-installer-shim/);
    expect(ps1).toMatch(/Test-OurShim/);
  });
});

describe("install.sh", () => {
  it("pins the Node it found on PATH to an absolute path", () => {
    expect(sh).toMatch(/NODE_BIN=\$\(command -v node\)/);
    expect(sh).not.toMatch(/^\s*NODE_BIN=node\s*$/m);
  });
  it("marks its wrapper and leaves a foreign file alone", () => {
    expect(sh).toMatch(/ultraplan-installer-shim/);
    expect(sh).toMatch(/left alone/);
  });
});
