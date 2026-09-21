import { describe, expect, it } from "vitest";
import { buildCasebook, casebookStats, RECALL_NOTE } from "../src/review/casebook.ts";
import { decisionKey, type DecisionRecord, type Verdict } from "../src/review/decisions.ts";
import type { Corpus, Entry, EntryJudgment, Finding } from "../src/types.ts";
import type { RunCache } from "../src/cache.ts";

/**
 * Every verdict a translator enters is a label, and they were all already on disk.
 * These tests pin what each one means, because getting that mapping wrong would produce
 * a confident measurement of the opposite of the truth.
 */
const entry = (id: string, source: string): Entry => ({
  id, project: "p", keyName: id, source, description: "", context: "", tags: [], tr: { de: "x" }, status: {},
});

const corpus: Corpus = {
  sourceLang: "pl",
  langs: ["pl", "de"],
  entries: [entry("k1", "Usuń"), entry("k2", "Zapisz"), entry("k3", "Anuluj")],
  origin: "t",
};

const judgment = (id: string, meaning: number): [string, EntryJudgment] => [
  id,
  { entryId: id, isUiString: 1, meaning: { de: meaning }, adheres: { de: 0.9 }, register: {}, ms: 1 },
];

const cache = {
  version: 2, savedAt: "", corpus, lintIssues: [], glossary: [],
  judgments: [judgment("k1", 0.04), judgment("k2", 0.95), judgment("k3", 0.2)],
  registerNorms: [], stages: [], unjudged: [], substitutions: [],
} as unknown as RunCache;

const finding = (id: string, severity: number, suggested: string | null = null): Finding => ({
  entryId: id, project: "p", keyName: id, lang: "de",
  source: corpus.entries.find((e) => e.id === id)!.source,
  current: "x", suggested,
  reasons: [{ rule: "meaning-not-preserved", p: 0.04, threshold: 0.35 }],
  category: "meaning", severity, action: "needs human", confidence: 0.9, substitutionOk: null, judged: true,
});

const decide = (id: string, verdict: Verdict, text: string, was = "x"): DecisionRecord => ({
  key: decisionKey(id, "de"), entryId: id, lang: "de", verdict, text, was,
  who: "ada", at: `2026-09-2${id.slice(-1)}T10:00:00Z`, check: null, note: "",
});

const book = (findings: Finding[], decisions: DecisionRecord[]) =>
  buildCasebook(cache, findings, new Map(decisions.map((d) => [d.key, d])));

describe("a verdict is a label", () => {
  it("reject on a finding is a false positive, with the judgment that caused it", () => {
    const cases = book([finding("k1", 3)], [decide("k1", "reject", "x")]);
    expect(cases).toHaveLength(1);
    expect(cases[0].label).toBe("false-positive");
    expect(cases[0].severity).toBe(3);
    expect(cases[0].meaning).toBe(0.04);
    expect(cases[0].adheres).toBe(0.9);
    expect(cases[0].rules).toEqual(["meaning-not-preserved"]);
    expect(cases[0].who).toBe("ada");
  });

  it("accept on a finding is a true positive", () => {
    const cases = book([finding("k1", 3)], [decide("k1", "accept", "Löschen")]);
    expect(cases.map((c) => c.label)).toEqual(["true-positive"]);
  });

  it("an edit on a row nothing flagged is a miss", () => {
    const cases = book([], [decide("k2", "edited", "Speichern", "Sparen")]);
    expect(cases.map((c) => c.label)).toEqual(["missed"]);
    expect(cases[0].was).toBe("Sparen");
    expect(cases[0].became).toBe("Speichern");
  });

  it("an edit that changed nothing is not a miss", () => {
    expect(book([], [decide("k2", "edited", "same", "same")])).toEqual([]);
  });

  it("defer says nothing, so it is not a label", () => {
    expect(book([finding("k1", 3)], [decide("k1", "defer", "x")])).toEqual([]);
  });

  it("grades the substitution separately from the finding", () => {
    const taken = book([finding("k1", 2, "Löschen")], [decide("k1", "accept", "Löschen")]);
    expect(taken.map((c) => c.label)).toEqual(["true-positive", "substitution-taken"]);

    const rewritten = book([finding("k1", 2, "Löschen")], [decide("k1", "edited", "Etwas anderes")]);
    expect(rewritten.map((c) => c.label)).toEqual(["true-positive", "substitution-rewritten"]);
  });

  it("does not grade a substitution that was never offered", () => {
    const cases = book([finding("k1", 2, null)], [decide("k1", "accept", "whatever")]);
    expect(cases.map((c) => c.label)).toEqual(["true-positive"]);
  });

  it("ignores a decision about a key the run does not contain", () => {
    expect(book([], [decide("gone", "reject", "x")])).toEqual([]);
  });
});

describe("what the case book measures", () => {
  const cases = book(
    [finding("k1", 3), finding("k2", 3), finding("k3", 1, "Storno")],
    [
      decide("k1", "reject", "x"),
      decide("k2", "accept", "Löschen"),
      decide("k3", "accept", "Storno"),
    ],
  );
  const stats = casebookStats(cases);

  it("measures precision on rows a human actually ruled on", () => {
    // k2 and k3 agreed, k1 disagreed
    expect(stats.precision).toBeCloseTo(2 / 3, 3);
  });

  it("measures the must-fix queue separately, because that is the trust number", () => {
    // at severity >= 2: k1 rejected, k2 accepted
    expect(stats.precisionAtSeverity2).toBeCloseTo(0.5, 3);
  });

  it("measures whether a proposed edit was taken as written", () => {
    expect(stats.substitutionPrecision).toBe(1);
  });

  it("ranks the rules a human ruled against, which is what to go and look at", () => {
    expect(stats.falsePositivesByRule).toEqual([["meaning-not-preserved", 1]]);
  });

  it("counts reviewers, so one person's opinion is not read as consensus", () => {
    expect(stats.reviewers).toBe(1);
  });

  it("returns null rather than 0 or NaN when nothing has been reviewed", () => {
    const empty = casebookStats([]);
    expect(empty.precision).toBeNull();
    expect(empty.precisionAtSeverity2).toBeNull();
    expect(empty.substitutionPrecision).toBeNull();
    expect(empty.cases).toBe(0);
  });

  it("says out loud that recall is not measurable here", () => {
    // a reviewer only ever sees rows the audit flagged, so the cells a missed defect
    // lives in are exactly the ones nobody was shown
    expect(RECALL_NOTE).toContain("recall is not");
    expect(RECALL_NOTE).toContain("floor");
  });
});
