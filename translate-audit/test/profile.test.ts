import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_DOMAIN,
  DEFAULT_GATES,
  DEFAULT_POLICY,
  loadProfile,
  policyNote,
} from "../src/config/profile.ts";
import { flagBool, parseArgs } from "../src/config/args.ts";
import { arbitrationState, questionsFingerprint } from "../src/jev/questions.ts";
import type { Entry, TermConflict } from "../src/types.ts";

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "profile-"));
  dirs.push(d);
  return d;
};

const envKeys = ["JEV_MODEL", "TYPESAFE_BASE_URL", "JEV_PRICE_IN", "JEV_PRICE_OUT", "JEV_CONCURRENCY", "TRANSLATE_AUDIT_DOMAIN"];
const savedEnv = new Map(envKeys.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the profile is the only configuration", () => {
  it("defaults to the shipped values", () => {
    const d = tempDir();
    for (const k of envKeys) delete process.env[k];
    const p = loadProfile(undefined, d);
    expect(p.domain).toBe(DEFAULT_DOMAIN);
    expect(p.policy).toEqual(DEFAULT_POLICY);
    expect(p.gates).toEqual(DEFAULT_GATES);
    expect(p.sources).toEqual([]);
  });

  it("layers file under environment under flags, and names every layer that spoke", () => {
    const d = tempDir();
    for (const k of envKeys) delete process.env[k];
    writeFileSync(
      join(d, CONFIG_FILE),
      JSON.stringify({ domain: "from the file", model: "file-model", policy: { meaningBad: 0.1 } }),
      "utf8",
    );

    const fromFile = loadProfile(undefined, d);
    expect(fromFile.domain).toBe("from the file");
    expect(fromFile.model).toBe("file-model");
    expect(fromFile.policy.meaningBad).toBe(0.1);
    // a partial policy in the file leaves the rest at their defaults
    expect(fromFile.policy.adherenceBad).toBe(DEFAULT_POLICY.adherenceBad);
    expect(fromFile.sources).toEqual([CONFIG_FILE]);

    process.env.JEV_MODEL = "env-model";
    const withEnv = loadProfile(undefined, d);
    expect(withEnv.model).toBe("env-model");
    expect(withEnv.domain).toBe("from the file");
    expect(withEnv.sources).toEqual([CONFIG_FILE, "environment"]);

    const withFlags = loadProfile(parseArgs(["run", "--domain", "from a flag", "--meaning-bad", "0.9"]), d);
    expect(withFlags.domain).toBe("from a flag");
    expect(withFlags.policy.meaningBad).toBe(0.9);
    expect(withFlags.model).toBe("env-model");
    expect(withFlags.sources).toEqual([CONFIG_FILE, "environment", "flags"]);
  });

  it("refuses a malformed config file rather than silently shipping defaults", () => {
    const d = tempDir();
    writeFileSync(join(d, CONFIG_FILE), "{ not json", "utf8");
    expect(() => loadProfile(undefined, d)).toThrow(/not valid JSON/);
  });
});

describe("boolean flags", () => {
  it("understands the --no- form, which is the one people type", () => {
    // `--no-fix` was parsed into a flag called `no-fix` that nothing read, so the
    // documented way to skip the substitution stage spent the requests anyway.
    expect(flagBool(parseArgs(["run", "--no-fix"]), "fix", true)).toBe(false);
    expect(flagBool(parseArgs(["run", "--no-cache"]), "cache", true)).toBe(false);
    expect(flagBool(parseArgs(["run", "--fix", "false"]), "fix", true)).toBe(false);
    expect(flagBool(parseArgs(["run", "--fix"]), "fix", true)).toBe(true);
    expect(flagBool(parseArgs(["run"]), "fix", true)).toBe(true);
    expect(flagBool(parseArgs(["run"]), "dry-run", false)).toBe(false);
    expect(flagBool(parseArgs(["run", "--dry-run"]), "dry-run", false)).toBe(true);
  });
});

describe("one domain, so what is measured is what ships", () => {
  const conflict: TermConflict = {
    term: "usun",
    lang: "de",
    variants: [
      { text: "Löschen", count: 9, examples: ["a"] },
      { text: "Entfernen", count: 2, examples: ["b"] },
    ],
    entryIds: ["a", "b"],
    origin: "duplicate-source",
    trivial: false,
  };
  const entry = (id: string, source: string): Entry => ({
    id,
    project: "p",
    keyName: source,
    source,
    description: "",
    context: "",
    tags: [],
    tr: {},
    status: {},
  });
  const entries = new Map([
    ["a", entry("a", "Usuń")],
    ["b", entry("b", "Usuń")],
  ]);

  it("builds the same arbitration state whichever command asks for it", () => {
    const d = tempDir();
    for (const k of envKeys) delete process.env[k];
    // `run` and `score` each call loadProfile independently; the states must not differ.
    const forRun = arbitrationState(conflict, entries, "pl", loadProfile(parseArgs(["run"]), d).domain);
    const forScore = arbitrationState(conflict, entries, "pl", loadProfile(parseArgs(["score"]), d).domain);
    expect(forScore).toEqual(forRun);
    expect(forRun.domain).toBe(DEFAULT_DOMAIN);
  });

  it("is written down exactly once in the tree", () => {
    const root = resolve(import.meta.dirname, "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (name === "node_modules" || name === ".git" || name.startsWith("web-dist")) return [];
        if (statSync(full).isDirectory()) return walk(full);
        return /\.tsx?$/.test(name) ? [full] : [];
      });

    // assembled, so this assertion is not itself an occurrence
    const marker = ["building", "joinery"].join(" ");
    const hits = walk(root).filter((f) => readFileSync(f, "utf8").includes(marker));
    expect(hits.map((f) => f.slice(root.length + 1))).toEqual(["src/config/profile.ts"]);
  });
});

describe("policyNote states the gates it was given", () => {
  it("moves when the gates move, rather than reciting 0.70 / 0.80 / 0.60", () => {
    const strict = policyNote(DEFAULT_POLICY, { grammatical: 0.95, preserved: 0.99, improved: 0.9 });
    expect(strict).toContain("grammar 0.95");
    expect(strict).toContain("meaning 0.99");
    expect(strict).toContain("improvement 0.90");
    expect(policyNote(DEFAULT_POLICY, DEFAULT_GATES)).toContain("grammar 0.70");
  });
});

describe("the question set can identify itself", () => {
  it("is deterministic", () => {
    expect(questionsFingerprint()).toBe(questionsFingerprint());
    expect(questionsFingerprint()).toMatch(/^[0-9a-f]{12}$/);
  });

  // A canary, not a constraint. Changing a question SHOULD break this.
  it("is the value saved runs will carry", () => {
    expect(
      questionsFingerprint(),
      "A question changed. That is fine — update this value, then run `probe` and re-run " +
        "`score` with the seed you used before, so the difference in the numbers is attributable.",
    ).toBe("4442fb6c0164");
  });
});
