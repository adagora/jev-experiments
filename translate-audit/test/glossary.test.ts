import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlossaryEntry, TermConflict, Variant } from "../src/types.ts";
import {
  applyArbitration,
  decide,
  enforceable,
  glossaryStats,
  guidanceByTerm,
  isDecided,
  loadGlossary,
  manualTerm,
  mergeMined,
  saveGlossary,
  termKey,
  type GlossaryRecord,
} from "../src/glossary/store.ts";
import {
  changes,
  decisionKey,
  decisionStats,
  loadDecisions,
  saveDecisions,
  type DecisionRecord,
} from "../src/review/decisions.ts";

const dir = mkdtempSync(join(tmpdir(), "ta-glossary-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const v = (text: string, count: number): Variant => ({ text, count, examples: [] });

const conflict = (term: string, lang: string, variants: Variant[], entryIds: string[] = ["k1"]): TermConflict => ({
  term,
  lang,
  variants,
  entryIds,
  origin: "duplicate-source",
  trivial: false,
});

const answer = (term: string, lang: string, canonical: string | null, confidence = 0.9): GlossaryEntry => ({
  term,
  lang,
  canonical,
  confidence,
  interchangeable: 0.5,
  doNotTranslate: 0.02,
  covered: 0.9,
  severity: 2.1,
  variants: [],
  entryIds: [],
  origin: "duplicate-source",
});

const display = (t: string) => t;

describe("merging a run into a saved glossary", () => {
  it("asks about a term nobody has decided", () => {
    const m = mergeMined([], [conflict("usun", "de", [v("Löschen", 9), v("Entfernen", 2)])], [], display);
    expect(m.needArbitration).toHaveLength(1);
    expect(m.fresh).toBe(1);
    expect(m.records[0].status).toBe("proposed");
  });

  it("never re-asks about a term a person decided", () => {
    const saved = [decide(mergeMined([], [conflict("usun", "de", [v("Löschen", 9)])], [], display).records[0], { canonical: "Löschen" }, "reviewer-a")];
    const m = mergeMined(saved, [conflict("usun", "de", [v("Löschen", 9), v("Entfernen", 2)])], [], display);
    expect(m.needArbitration).toHaveLength(0);
    expect(m.reused).toBe(1);
    expect(m.records[0].canonical).toBe("Löschen");
    expect(m.records[0].decidedBy).toBe("reviewer-a");
  });

  it("refreshes what the corpus now contains even for a decided term", () => {
    const saved = [decide(mergeMined([], [conflict("usun", "de", [v("Löschen", 9)])], [], display).records[0], { canonical: "Löschen" }, "reviewer-a")];
    const m = mergeMined(saved, [conflict("usun", "de", [v("Löschen", 9), v("Entfernen", 2)], ["k1", "k2"])], [], display);
    expect(m.records[0].variants.map((x) => x.text)).toEqual(["Löschen", "Entfernen"]);
    expect(m.records[0].entryIds).toEqual(["k1", "k2"]);
  });

  it("reports a decided term the corpus has drifted away from", () => {
    const saved = [decide(mergeMined([], [conflict("usun", "de", [v("Löschen", 9)])], [], display).records[0], { canonical: "Löschen" }, "reviewer-a")];
    const m = mergeMined(saved, [conflict("usun", "de", [v("Löschen", 9), v("Entfernen", 2)])], [], display);
    expect(m.drifted.map((d) => d.key)).toEqual([termKey("usun", "de")]);
  });

  it("does not call an undecided term drifted", () => {
    const first = mergeMined([], [conflict("usun", "de", [v("Löschen", 9)])], [], display);
    const m = mergeMined(first.records, [conflict("usun", "de", [v("Löschen", 9), v("Entfernen", 2)])], [], display);
    expect(m.drifted).toHaveLength(0);
  });

  it("arbitration never overwrites a human", () => {
    const saved = [decide(mergeMined([], [conflict("usun", "de", [v("Löschen", 9)])], [], display).records[0], { canonical: "Löschen" }, "reviewer-a")];
    const after = applyArbitration(saved, [answer("usun", "de", "Entfernen")]);
    expect(after[0].canonical).toBe("Löschen");
    expect(after[0].source).toBe("human");
  });

  it("arbitration does fill in a proposal", () => {
    const m = mergeMined([], [conflict("usun", "de", [v("Löschen", 9), v("Entfernen", 2)])], [], display);
    const after = applyArbitration(m.records, [answer("usun", "de", "Löschen")]);
    expect(after[0].canonical).toBe("Löschen");
    expect(after[0].source).toBe("jev");
    expect(after[0].status).toBe("proposed");
  });
});

describe("deciding", () => {
  const base = (): GlossaryRecord => mergeMined([], [conflict("brama", "de", [v("Tor", 5), v("Schranke", 1)])], [], display).records[0];

  it("typing a canonical is itself the approval", () => {
    const r = decide(base(), { canonical: "Tor" }, "reviewer-a");
    expect(r.status).toBe("approved");
    expect(r.source).toBe("human");
    expect(r.confidence).toBe(1);
    expect(r.decidedBy).toBe("reviewer-a");
    expect(isDecided(r.status)).toBe(true);
  });

  it("context-dependent and rejected clear the canonical", () => {
    expect(decide(base(), { status: "context-dependent" }, "b").canonical).toBeNull();
    expect(decide(base(), { status: "rejected" }, "b").canonical).toBeNull();
  });

  it("do-not-translate pins the source spelling", () => {
    const r = decide({ ...base(), display: "GARDIA" }, { status: "do-not-translate" }, "b");
    expect(r.canonical).toBe("GARDIA");
  });

  it("writing only a rule is not a decision", () => {
    const r = decide(base(), { guidance: "Tor for a fence gate." }, "reviewer-a");
    expect(r.guidance).toBe("Tor for a fence gate.");
    expect(r.status).toBe("proposed");
    expect(r.decidedBy).toBeNull();
  });
});

describe("what the audit is allowed to enforce", () => {
  const records = [
    decide(mergeMined([], [conflict("a", "de", [v("A", 2)])], [], display).records[0], { canonical: "A" }, "b"),
    decide(mergeMined([], [conflict("b", "de", [v("B", 2)])], [], display).records[0], { status: "context-dependent" }, "b"),
    decide(mergeMined([], [conflict("c", "de", [v("C", 2)])], [], display).records[0], { status: "rejected" }, "b"),
    decide({ ...mergeMined([], [conflict("d", "de", [v("D", 2)])], [], display).records[0], display: "GARDIA" }, { status: "do-not-translate" }, "b"),
  ];

  it("enforces approved and do-not-translate, and nothing else", () => {
    expect(enforceable(records).map((g) => g.term).sort()).toEqual(["a", "d"]);
  });

  it("a context-dependent term produces no rule at all", () => {
    expect(enforceable(records).find((g) => g.term === "b")).toBeUndefined();
  });

  it("marks do-not-translate so substitution refuses to touch it", () => {
    expect(enforceable(records).find((g) => g.term === "d")?.doNotTranslate).toBe(1);
  });

  it("collects the rules translators wrote", () => {
    const withRule = [decide(records[0], { guidance: "always A" }, "b")];
    expect(guidanceByTerm(withRule).get("a")).toEqual([{ lang: "de", guidance: "always A" }]);
    expect(guidanceByTerm(records).size).toBe(0);
  });
});

describe("persistence", () => {
  it("survives a save and load", () => {
    const path = join(dir, "g.json");
    const records = [decide(mergeMined([], [conflict("usun", "de", [v("Löschen", 9)])], [], display).records[0], { canonical: "Löschen", guidance: "never Entfernen" }, "reviewer-a")];
    saveGlossary(path, records);
    const back = loadGlossary(path);
    expect(back).toEqual(records);
  });

  it("returns an empty glossary rather than failing when there is none", () => {
    expect(loadGlossary(join(dir, "missing.json"))).toEqual([]);
  });

  it("refuses a file written by a different version", () => {
    const path = join(dir, "bad.json");
    saveGlossary(path, []);
    const raw = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
    raw.version = 99;
    require("node:fs").writeFileSync(path, JSON.stringify(raw));
    expect(() => loadGlossary(path)).toThrow(/version 99/);
  });
});

describe("hand-written terms", () => {
  it("are approved on arrival and fold the source term", () => {
    const t = manualTerm("Wyślij", "de", "Senden", "reviewer-a", "imperative, not infinitive");
    expect(t.term).toBe("wyslij");
    expect(t.display).toBe("Wyślij");
    expect(t.status).toBe("approved");
    expect(t.source).toBe("human");
    expect(t.guidance).toBe("imperative, not infinitive");
    expect(enforceable([t])).toHaveLength(1);
  });
});

describe("glossary stats", () => {
  it("counts what is left to do", () => {
    const proposed = mergeMined([], [conflict("a", "de", [v("A", 1)]), conflict("b", "de", [v("B", 1)])], [], display).records;
    const s = glossaryStats([decide(proposed[0], { canonical: "A", guidance: "x" }, "b"), proposed[1]]);
    expect(s.total).toBe(2);
    expect(s.decided).toBe(1);
    expect(s.proposed).toBe(1);
    expect(s.withGuidance).toBe(1);
  });
});

describe("decisions", () => {
  const rec = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
    key: decisionKey("k1", "de"),
    entryId: "k1",
    lang: "de",
    verdict: "accept",
    text: "Löschen",
    was: "Entfernen",
    who: "reviewer-a",
    at: "2026-09-20T10:00:00Z",
    check: null,
    note: "",
    ...over,
  });

  it("only counts a change when the text really changed", () => {
    expect(changes([rec()])).toHaveLength(1);
    expect(changes([rec({ text: "Entfernen" })])).toHaveLength(0);
    expect(changes([rec({ verdict: "reject" })])).toHaveLength(0);
    expect(changes([rec({ verdict: "defer" })])).toHaveLength(0);
    expect(changes([rec({ verdict: "edited", text: "Etwas" })])).toHaveLength(1);
  });

  it("ignores whitespace-only differences", () => {
    expect(changes([rec({ text: "  Entfernen  " })])).toHaveLength(0);
  });

  it("round-trips through disk", () => {
    const path = join(dir, "d.json");
    const m = new Map([[rec().key, rec()]]);
    saveDecisions(path, m);
    expect(loadDecisions(path)).toEqual(m);
  });

  it("tracks who did the work", () => {
    const m = new Map([
      ["a", rec({ key: "a", who: "reviewer-a" })],
      ["b", rec({ key: "b", who: "reviewer-b", verdict: "reject" })],
    ]);
    const s = decisionStats(m);
    expect(s.total).toBe(2);
    expect(s.changed).toBe(1);
    expect(s.byWho).toEqual([
      ["reviewer-a", 1],
      ["reviewer-b", 1],
    ]);
  });
});
