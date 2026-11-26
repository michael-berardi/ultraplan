import { execFile } from "node:child_process";
import { existsSync, promises as fs, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Privacy contract: no runtime code contains a network client or telemetry
 * library, the installers only download from their two documented hosts with
 * checksums, and the default CLI store works with all network APIs disabled
 * and private permissions.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "bin", "ut-todo");
const GUARD = fileURLToPath(new URL("fixtures/no-network.mjs", import.meta.url));
const run = promisify(execFile);

const NETWORK_OR_TELEMETRY =
  /(?:\bfetch\s*\(|https?\.(?:get|request|createServer)\s*\(|\bXMLHttpRequest|\bWebSocket|\bnet\.connect|\bdns\.(?:lookup|resolve)|\bdgram\b|\baxios\b|\bundici\b|\bnode-fetch\b|@sentry\/|\bposthog\b|\bsegment\.io\b|\bmixpanel\b|\bamplitude\b|\bdatadog\b|\bopentelemetry\b|\bopen-telemetry\b|\banalytics\b|\btelemetry\b)/i;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
}

function runtimeFiles(): string[] {
  return [
    path.join(ROOT, "bin", "ut-todo"),
    ...walk(path.join(ROOT, "src")),
    ...walk(path.join(ROOT, "pi")),
    ...walk(path.join(ROOT, "integrations")),
  ];
}

describe("no telemetry or network client ships in runtime code", () => {
  it("catches what it guards", () => {
    for (const sample of [
      "await fetch('https://example.invalid')",
      "https.request(options)",
      "import * as Sentry from '@sentry/node'",
      "const client = posthog.init(key)",
      "new WebSocket(url)",
      "telemetry.capture(event)",
    ]) expect(sample).toMatch(NETWORK_OR_TELEMETRY);
  });

  it("scans a non-empty shipped runtime set", () => {
    expect(runtimeFiles().length).toBeGreaterThan(5);
  });

  it("finds no telemetry package, endpoint or network API in shipped code", () => {
    const hits = runtimeFiles().flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
        NETWORK_OR_TELEMETRY.test(line)
          ? [`${path.relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 100)}`]
          : [],
      ),
    );
    expect(hits).toEqual([]);
  });

  it("declares no telemetry or analytics dependency and keeps a Privacy section", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(lock.packages),
    ];
    const banned = /^(@sentry\/|@segment\/|@datadog\/|@opentelemetry\/exporter|posthog|mixpanel|amplitude|analytics)/i;
    expect(names.filter((name) => banned.test(name))).toEqual([]);
    expect(readFileSync(path.join(ROOT, "README.md"), "utf8")).toMatch(/^## Privacy$/m);
  });
});

describe("installers only download the release and Node, with checksums", () => {
  const sh = readFileSync(path.join(ROOT, "scripts", "install.sh"), "utf8");
  const ps1 = readFileSync(path.join(ROOT, "scripts", "install.ps1"), "utf8");

  for (const [name, text] of [["install.sh", sh], ["install.ps1", ps1]] as const) {
    it(`${name} uses only GitHub and nodejs.org and verifies checksums`, () => {
      const hosts = [...text.matchAll(/https?:\/\/([^\s"'`$)]+)/g)].map((match) => match[1].split("/")[0]);
      expect(hosts.length).toBeGreaterThan(0);
      expect(hosts.every((host) => host === "github.com" || host === "nodejs.org")).toBe(true);
      expect(text).toMatch(/SHA256SUMS/);
      expect(text).toMatch(name === "install.sh" ? /expect / : /Test-Checksum/);
    });
    it(`${name} disables dependency telemetry`, () => {
      expect(text).toMatch(/DO_NOT_TRACK=1|DO_NOT_TRACK = '1'/);
    });
  }
});

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "ultraplan-privacy-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function runOffline(cwd: string, args: string[], marker: string) {
  const clean = { ...process.env } as Record<string, string | undefined>;
  delete clean.CLAUDE_CODE_SESSION_ID;
  delete clean.UT_TODO_SESSION;
  return run(process.execPath, ["--import", GUARD, BIN, ...args], {
    cwd,
    env: { ...clean, UT_PRIVACY_MARKER: marker },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function expectPrivateStore(cwd: string, store: string) {
  for (const dir of [
    path.join(cwd, ".steak-pi"),
    path.join(cwd, ".steak-pi", "todo"),
    store,
  ]) {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  }
  for (const file of [path.join(store, "todo.json"), path.join(store, "TODO.md")]) {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
}

describe("default CLI store", () => {
  it("runs with every network API disabled and creates private files", async () => {
    const cwd = await tempDir();
    const marker = path.join(cwd, "guard.marker");
    const init = await runOffline(cwd, ["init", "Private:secret task"], marker);
    expect(init.stderr).toBe("");
    expect(init.stdout).toContain("1. Private (0/1)");
    expect(existsSync(marker)).toBe(true);
    const stores = await fs.readdir(path.join(cwd, ".steak-pi", "todo"));
    expect(stores).toHaveLength(1);
    const store = path.join(cwd, ".steak-pi", "todo", stores[0]);
    expectPrivateStore(cwd, store);

    const done = await runOffline(cwd, ["done", "secret"], marker);
    expect(done.stderr).toBe("");
    expect(done.stdout).toContain("Overall: 1/1 done.");
    expectPrivateStore(cwd, store);
  });

  it("tightens a store written with loose permissions", async () => {
    const cwd = await tempDir();
    const marker = path.join(cwd, "guard.marker");
    await runOffline(cwd, ["init", "Old:a"], marker);
    const root = path.join(cwd, ".steak-pi");
    const todoRoot = path.join(root, "todo");
    const store = path.join(todoRoot, (await fs.readdir(todoRoot))[0]);
    for (const dir of [root, todoRoot, store]) await fs.chmod(dir, 0o755);
    for (const file of ["todo.json", "TODO.md"]) await fs.chmod(path.join(store, file), 0o644);
    const result = await runOffline(cwd, ["done", "a"], marker);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Overall: 1/1 done.");
    expectPrivateStore(cwd, store);
  });
});
