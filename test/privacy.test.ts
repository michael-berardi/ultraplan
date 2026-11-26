import { execFile } from "node:child_process";
import { existsSync, promises as fs, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Privacy contract: the only network code in shipped runtime files is the
 * update module (docs/updates.md), and it talks only to GitHub; no telemetry
 * library or endpoint ships anywhere; the installers only download from their
 * two documented hosts with checksums; the default CLI store works with all
 * network APIs disabled and private permissions; the README Privacy section
 * stays short and PRIVACY.md carries the detail.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "bin", "ut-todo");
const GUARD = fileURLToPath(new URL("fixtures/no-network.mjs", import.meta.url));
const UPDATE_MODULE = path.join(ROOT, "src", "update.js");
const UPDATE_TYPES = path.join(ROOT, "src", "update.d.ts");
const run = promisify(execFile);

const NETWORK =
  /(?:\bfetch\s*\(|\bglobalThis\.fetch\b|https?\.(?:get|request|createServer)\s*\(|\bXMLHttpRequest|\bWebSocket|\bnet\.connect|\bdns\.(?:lookup|resolve)|\bdgram\b|\baxios\b|\bundici\b|\bnode-fetch\b|from\s+["']node:(?:http|https|net|dns|dgram|tls)["'])/i;
const TELEMETRY =
  /(?:@sentry\/|\bposthog\b|\bsegment\.io\b|\bmixpanel\b|\bamplitude\b|\bdatadog\b|\bopentelemetry\b|\bopen-telemetry\b|\banalytics\b|\btelemetry\b)/i;

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

function scan(files: string[], pattern: RegExp): string[] {
  return files.flatMap((file) =>
    readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
      pattern.test(line) ? [`${path.relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 100)}`] : [],
    ),
  );
}

function section(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2} /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== "");
}

describe("no telemetry, and network code only in the update module", () => {
  it("catches what it guards", () => {
    for (const sample of [
      "await fetch('https://example.invalid')",
      "fetchImpl = globalThis.fetch",
      "https.request(options)",
      'import http from "node:http";',
      "new WebSocket(url)",
    ]) expect(sample).toMatch(NETWORK);
    for (const sample of [
      "import * as Sentry from '@sentry/node'",
      "const client = posthog.init(key)",
      "telemetry.capture(event)",
    ]) expect(sample).toMatch(TELEMETRY);
  });

  it("scans a non-empty shipped runtime set that includes the update module", () => {
    expect(runtimeFiles().length).toBeGreaterThan(5);
    expect(runtimeFiles()).toContain(UPDATE_MODULE);
  });

  it("finds no telemetry package or endpoint in any shipped file", () => {
    expect(scan(runtimeFiles(), TELEMETRY)).toEqual([]);
  });

  it("finds no network API outside the update module", () => {
    expect(scan(runtimeFiles().filter((file) => file !== UPDATE_MODULE && file !== UPDATE_TYPES), NETWORK)).toEqual([]);
    expect(scan([UPDATE_MODULE], NETWORK).length).toBeGreaterThan(0);
  });

  it("lets the update module reach only GitHub, with a fixed User-Agent", () => {
    const text = readFileSync(UPDATE_MODULE, "utf8");
    const hosts = [...text.matchAll(/https?:\/\/([^\s"'`$)/]+)/g)].map((match) => match[1]);
    expect(hosts.length).toBeGreaterThan(0);
    expect([...new Set(hosts)].sort()).toEqual(["api.github.com", "github.com"]);
    expect(text).toMatch(/const USER_AGENT = "ut-todo-update-check"/);
    for (const call of text.match(/fetchImpl\(url, \{[^}]*\}/g) ?? []) {
      expect(call).toMatch(/headers: \{ "User-Agent": USER_AGENT(?:, Accept: "application\/vnd\.github\+json")? \}/);
    }
  });

  it("declares no telemetry or analytics dependency", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(lock.packages).map((key) => key.split("node_modules/").pop() ?? key),
    ];
    const banned = /^(@sentry\/|@segment\/|@datadog\/|@opentelemetry\/exporter|posthog|mixpanel|amplitude|analytics)/i;
    expect(banned.test("posthog-node")).toBe(true);
    expect(names.filter((name) => banned.test(name))).toEqual([]);
  });
});

describe("privacy documentation", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const privacy = readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");

  it("keeps the README Privacy section to six lines that link PRIVACY.md", () => {
    const lines = section(readme, "## Privacy");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(6);
    const text = lines.join("\n");
    expect(text).toMatch(/\]\(PRIVACY\.md\)/);
    expect(text).toMatch(/update check/i);
    expect(text).toMatch(/UT_TODO_NO_UPDATE_CHECK=1/);
    expect(text).toMatch(/no telemetry/i);
    expect(text).toMatch(/\.steak-pi\/todo/);
  });

  it("describes the anonymous daily update check truthfully everywhere", () => {
    for (const text of [readme, privacy]) {
      expect(text).not.toMatch(/\bno\b[^.\n]*\bupdate checks?\b/i);
      expect(text).not.toMatch(/(?:ut-todo|CLI)[^.\n]*makes? no network calls/i);
    }
  });

  it("keeps the storage, installer and network detail in PRIVACY.md", () => {
    for (const fact of [
      /no telemetry/i,
      /0700/, /0600/,
      /rm -rf \.steak-pi\/todo/,
      /no logs or transcripts/,
      /once a day/, /anonymous GET/, /ut-todo-update-check/,
      /UT_TODO_NO_UPDATE_CHECK=1/, /--auto-check off/, /off in CI/,
      /nodejs\.org/, /SHA-256/, /DO_NOT_TRACK=1/,
      /update\.log[^.]*256 KB/, /7 days/,
      /does not contact any\s+provider/,
      /docs\/updates\.md/,
    ]) expect(privacy).toMatch(fact);
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
  delete clean.UT_TODO_NO_UPDATE_CHECK;
  delete clean.CI;
  return run(process.execPath, ["--import", GUARD, BIN, ...args], {
    cwd,
    // The update check stays on; a non-terminal run must neither reach the network nor write update state.
    env: { ...clean, UT_PRIVACY_MARKER: marker, ULTRAPLAN_CACHE_DIR: path.join(cwd, "update-cache") },
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
    expect(existsSync(path.join(cwd, "update-cache"))).toBe(false);
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
