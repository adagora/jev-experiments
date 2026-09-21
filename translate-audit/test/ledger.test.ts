import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLedger,
  diffEntries,
  entryFrom,
  findEntry,
  readLedger,
  type LedgerEntry,
} from "../src/ledger/ledger.ts";
import { loadProfile } from "../src/config/profile.ts";
import { envelope } from "../src/report/envelope.ts";

const dirs: string[] = [];
const tempPath = (name = "ledger.jsonl"): string => {
  const d = mkdtempSync(join(tmpdir(), "ledger-"));
  dirs.push(d);
  return join(d, "runs", name);
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const profile = loadProfile();

const scoreEnvelope = (questions: string) =>
  envelope("score", {
    inputs: { corpus: "synthetic (400 keys)", seed: 20250920, keys: 400, questions },
    coverage: { attempted: 420, answered: 420, failed: 0, skipped: 0 },
    counts: { "injected defects": 157 },
    cost: { requests: 420, judgments: 5200, errors: 0, retries: 0, usd: 0.55, wallMs: 15000, p50Ms: 300, p95Ms: 450 },
  });

describe("the ledger records what a run produced", () => {
  it("is built from the envelope, so it cannot say something different", () => {
    const e = scoreEnvelope("abc123");
    const entry = entryFrom(e, profile, { corpus: "synthetic", keys: 400, measurements: { recall: 1 } });
    expect(entry.command).toBe("score");
    expect(entry.questions).toBe("abc123");
    expect(entry.coverage).toEqual(e.coverage);
    expect(entry.cost?.usd).toBe(0.55);
    expect(entry.policy).toEqual(profile.policy);
    expect(entry.measurements).toEqual({ recall: 1 });
  });

  it("appends without rewriting, and survives a truncated line", () => {
    const path = tempPath();
    const a = entryFrom(scoreEnvelope("q1"), profile, { corpus: "c", keys: 1 });
    const b = entryFrom(scoreEnvelope("q2"), profile, { corpus: "c", keys: 1 });
    appendLedger(path, a);
    appendLedger(path, b);
    expect(readLedger(path).map((r) => r.questions)).toEqual(["q1", "q2"]);

    writeFileSync(path, readLedger(path).map((r) => JSON.stringify(r)).join("\n") + '\n{"id":"trunc', "utf8");
    expect(readLedger(path)).toHaveLength(2);
  });

  it("finds an entry by id or by index from the end", () => {
    const path = tempPath();
    const a = entryFrom(scoreEnvelope("q1"), profile, { corpus: "c", keys: 1 });
    const b = entryFrom(scoreEnvelope("q2"), profile, { corpus: "c", keys: 1 });
    appendLedger(path, a);
    appendLedger(path, b);
    const rows = readLedger(path);
    expect(findEntry(rows, a.id)?.questions).toBe("q1");
    expect(findEntry(rows, "-1")?.questions).toBe("q2");
    expect(findEntry(rows, "nope")).toBeUndefined();
  });

  it("reads an empty or missing ledger as no entries, not as an error", () => {
    expect(readLedger(tempPath())).toEqual([]);
  });
});

describe('"did that change help?" is a diff of two rows', () => {
  const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
    ...entryFrom(scoreEnvelope("q"), profile, { corpus: "synthetic (400 keys)", keys: 400 }),
    ...over,
  });

  it("states the measurement delta without re-measuring anything", () => {
    const before = entry({
      policy: { ...profile.policy, meaningBad: 0.35 },
      measurements: { recall: 1.0, precision: 0.674, precisionAtSeverity2: 1.0 },
    });
    const after = entry({
      policy: { ...profile.policy, meaningBad: 0.2 },
      measurements: { recall: 0.93, precision: 0.81, precisionAtSeverity2: 1.0 },
    });

    const d = diffEntries(before, after);
    const m = Object.fromEntries(d.measurements.map(([k, , , delta]) => [k, delta]));
    expect(m.precision).toBeCloseTo(0.136, 3);
    expect(m.recall).toBeCloseTo(-0.07, 3);
    expect(m.precisionAtSeverity2).toBe(0);
  });

  it("names only what actually changed, so a result is attributable to one thing", () => {
    const before = entry({ policy: { ...profile.policy, meaningBad: 0.35 }, measurements: { recall: 1 } });
    const after = entry({ policy: { ...profile.policy, meaningBad: 0.2 }, measurements: { recall: 0.93 } });
    const d = diffEntries(before, after);
    expect(d.configChanged).toEqual([["policy.meaningBad", "0.35", "0.2"]]);
  });

  it("reports nothing changed when nothing did — so a moved number is noise", () => {
    const a = entry({ measurements: { recall: 1.0 } });
    const b = entry({ measurements: { recall: 0.94 } });
    expect(diffEntries(a, b).configChanged).toEqual([]);
    expect(diffEntries(a, b).measurements[0][3]).toBeCloseTo(-0.06, 3);
  });

  it("notices a changed question set, which moves numbers on its own", () => {
    const a = entry({ questions: "aaaaaaaaaaaa", measurements: { recall: 1 } });
    const b = entry({ questions: "bbbbbbbbbbbb", measurements: { recall: 0.8 } });
    expect(diffEntries(a, b).configChanged.map(([k]) => k)).toContain("questions");
  });

  it("carries a measurement only one side has, rather than inventing a delta", () => {
    const a = entry({ measurements: { recall: 1 } });
    const b = entry({ measurements: { recall: 1, ece: 0.09 } });
    const ece = diffEntries(a, b).measurements.find(([k]) => k === "ece")!;
    expect(ece[1]).toBeUndefined();
    expect(ece[2]).toBe(0.09);
    expect(ece[3]).toBeUndefined();
  });
});
