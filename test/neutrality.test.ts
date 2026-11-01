import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UltraPlan is a neutral tool. What it ships names no model, provider or
 * fallback choice and no person's or client's names: those belong to the
 * operator. This test keeps it that way, modelled on Carl's neutrality test.
 *
 * Not scanned, by design:
 * - LICENSE, and the author, repository, homepage and bugs fields of
 *   package.json: legal attribution and registry metadata, not product text.
 *   The rest of package.json is scanned.
 * - package-lock.json (generated) and test/ (synthetic fixtures).
 *
 * Steak Pi, Pi and UltraTerm stay named on purpose: they are the hosts
 * UltraPlan works with, and `.steak-pi/todo/` is the store it shares with
 * Steak Pi, so renaming it would orphan every existing plan.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIPPED_DIRS = ["src", "bin", "pi", "integrations"];
const SHIPPED_FILES = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md"];
const PACKAGE_METADATA = ["author", "repository", "homepage", "bugs"];

// Concrete model ids and provider routes that only an operator should choose.
// Agent names in compatibility lists (Claude Code, Codex, Gemini CLI,
// OpenCode) are not model choices.
const MODEL_CHOICE =
  /\b(?:gpt-\d[\w.-]*|o[134]-(?:mini|pro|preview)\b|claude-(?:opus|sonnet|haiku|fable|instant|\d)[\w.-]*|(?:opus|sonnet|haiku|fable) ?\d(?:[.-]\d)?\b|gemini-\d[\w.-]*|deepseek[\w.-]*|qwen-?\d[\w.-]*|kimi-k\d[\w.-]*|glm-\d[\w.-]*|mimo-v\d[\w.-]*|llama-?\d[\w.-]*|grok-\d[\w.-]*)|(?<![\w./])(?:openrouter|anthropic|openai|opencode-go|x-ai|mistralai)\/[\w.-]+|:exacto\b/i;
// Names of the people and organisations UltraPlan was first built for, and
// private home paths. Case-insensitive so a lowercase handle in a URL cannot
// slip through.
const PERSONAL =
  /\b(?:Mike|Michael|Berardi|Dana|Felix|acme|acme|Mouseia|Liberty ?Design|acme)\b|libertydesign|\/Users\/[a-z]/i;

// Documented exceptions: [file, text the line contains, why it may stay].
// Empty today: the CHANGELOG's history reads the same with the neutral
// `your-github-username` placeholder, so no entry needs the original handle.
const ALLOWED: ReadonlyArray<readonly [file: string, contains: string, reason: string]> = [];

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

/** Every scanned text as [relative path, content]; package.json without its metadata fields. */
function shipped(): Array<[string, string]> {
  const files = [
    ...SHIPPED_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))),
    ...SHIPPED_FILES.map((name) => path.join(ROOT, name)),
  ];
  const texts = files.map((file): [string, string] => [path.relative(ROOT, file), readFileSync(file, "utf8")]);
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const key of PACKAGE_METADATA) delete manifest[key];
  return [...texts, ["package.json", JSON.stringify(manifest, null, 2)]];
}

function hits(pattern: RegExp): string[] {
  return shipped().flatMap(([file, text]) =>
    text.split("\n").flatMap((line, i) =>
      pattern.test(line) && !ALLOWED.some(([f, contains]) => f === file && line.includes(contains))
        ? [`${file}:${i + 1}: ${line.trim().slice(0, 120)}`]
        : [],
    ),
  );
}

describe("neutrality", () => {
  it("scans the shipped tree, not an empty set", () => {
    const scanned = shipped();
    const files = scanned.map(([file]) => file);
    for (const expected of [
      "src/core.ts",
      "src/render.ts",
      "bin/ut-todo",
      "pi/extension.ts",
      "integrations/claude-code/.claude-plugin/plugin.json",
      "integrations/claude-code/skills/ut-todo/SKILL.md",
      "README.md",
      "package.json",
    ]) {
      expect(files).toContain(expected);
    }
    expect(scanned.reduce((n, [, text]) => n + text.split("\n").length, 0)).toBeGreaterThan(1000);
  });

  it("catches what it guards and spares neutral placeholders", () => {
    for (const sample of ["claude-opus-5-5", "gpt-5.1", "openrouter/deepseek/deepseek-v4", "Sonnet 5.5", "glm-4.6"]) {
      expect(sample).toMatch(MODEL_CHOICE);
    }
    for (const sample of ["https://github.com/michael-berardi/ultraplan", "Michael Berardi", "/Users/someone/dev"]) {
      expect(sample).toMatch(PERSONAL);
    }
    for (const sample of ["provider-a/model-name", "claude --plugin-dir", "Gemini CLI", "OpenCode", ".steak-pi/todo/"]) {
      expect(sample).not.toMatch(MODEL_CHOICE);
    }
    for (const sample of ["https://github.com/your-github-username/ultraplan", "Alex", "Steak Pi", "UltraTerm"]) {
      expect(sample).not.toMatch(PERSONAL);
    }
  });

  it("ships no concrete model id or provider preference", () => {
    expect(hits(MODEL_CHOICE)).toEqual([]);
  });

  it("names no person or client", () => {
    expect(hits(PERSONAL)).toEqual([]);
  });
});
