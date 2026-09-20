import { afterAll, describe, expect, it } from "vitest";
import type { Corpus, Entry, GlossaryEntry, Variant } from "../src/types.ts";
import { TermIndex, indexByTerm, tokensOf } from "../src/glossary/match.ts";
import { containsTerm, fold } from "../src/util/text.ts";
import { asGlossaryEntries, decide, enforceable, mergeMined } from "../src/glossary/store.ts";
import { changes, type DecisionRecord } from "../src/review/decisions.ts";
import { orderStats, type OrderProbe } from "../src/calibrate.ts";
import { scopeStats, type ScopeProbe } from "../src/commands/probe.ts";
import { loadCache, saveCache } from "../src/cache.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const v = (text: string, count: number): Variant => ({ text, count, examples: [] });
const display = (t: string) => t;

describe("TermIndex agrees with containsTerm", () => {
  const terms = ["adres", "kod pocztowy", "brama", "usun", "zamowienie", "on"];
  const sources = [
    "Podaj adres dostawy",
    "Kod adresowy klienta",
    "Adres",
    "Wpisz kod pocztowy odbiorcy",
    "kod-pocztowy",
    "Brama dwuskrzydlowa",
    "bramami",
    "Numer zamowienia klienta",
    "kontrahent",
    "",
    "on",
    "ON/OFF",
  ];

  const index = new TermIndex(terms.map((t) => [t, t] as const));

  it("matches exactly what a full scan would match", () => {
    for (const src of sources) {
      const folded = fold(src);
      const byScan = terms.filter((t) => containsTerm(folded, t)).sort();
      const byIndex = index.matchingTerms(src).sort();
      expect(byIndex, `source ${JSON.stringify(src)}`).toEqual(byScan);
    }
  });

  it("still respects word boundaries", () => {
    expect(index.matchingTerms("Kod adresowy klienta")).toEqual([]);
    expect(index.matchingTerms("kontrahent")).toEqual([]);
    expect(index.matchingTerms("Podaj adres dostawy")).toEqual(["adres"]);
  });

  it("tokenises on the same rule the boundaries use", () => {
    expect(tokensOf(fold("Kod-pocztowy, {0}!"))).toEqual(["kod", "pocztowy", "0"]);
  });

  it("returns each term once even when its first word repeats", () => {
    expect(new TermIndex([["adres", 1] as const]).matchingTerms("adres i adres")).toEqual(["adres"]);
  });
});

describe("a glossary report keeps the terms the audit cannot enforce", () => {
  const records = [
    decide(mergeMined([], [], [], display).records[0] ?? seed("a", "de"), { canonical: "A" }, "b"),
    decide(seed("b", "de"), { status: "context-dependent" }, "b"),
    decide(seed("c", "de"), { status: "rejected" }, "b"),
  ];

  function seed(term: string, lang: string) {
    return mergeMined([], [{ term, lang, variants: [v("X", 2), v("Y", 1)], entryIds: ["k"], origin: "duplicate-source" as const, trivial: false }], [], display)
      .records[0];
  }

  it("the audit enforces only what has a canonical", () => {
    expect(enforceable(records).map((g) => g.term)).toEqual(["a"]);
  });

  it("the report still lists every term — dropping them hid real findings", () => {
    expect(asGlossaryEntries(records).map((g) => g.term).sort()).toEqual(["a", "b", "c"]);
  });

  it("passing the full list where the audit expects enforceable changes nothing", () => {
    const full = asGlossaryEntries(records).filter((g: GlossaryEntry) => g.canonical);
    expect(full.map((g) => g.term)).toEqual(enforceable(records).map((g) => g.term));
  });
});

describe("clearing a canonical un-decides the term", () => {
  const base = () =>
    mergeMined([], [{ term: "brama", lang: "de", variants: [v("Tor", 5)], entryIds: ["k"], origin: "duplicate-source" as const, trivial: false }], [], display)
      .records[0];

  it("an empty string is not a decision", () => {
    const r = decide(base(), { canonical: "  " }, "reviewer-a");
    expect(r.canonical).toBeNull();
    expect(r.status).toBe("proposed");
    expect(r.decidedBy).toBeNull();
  });

  it("clearing an approved term does not leave it approved with nothing", () => {
    const approved = decide(base(), { canonical: "Tor" }, "reviewer-a");
    expect(approved.status).toBe("approved");
    const cleared = decide(approved, { canonical: null }, "reviewer-b");
    expect(cleared.canonical).toBeNull();
    expect(cleared.status).toBe("proposed");
    expect(enforceable([cleared])).toHaveLength(0);
  });
});

describe("what counts as a changed translation", () => {
  const rec = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
    key: "k\u0000de",
    entryId: "k",
    lang: "de",
    verdict: "accept",
    text: "Industrial segments",
    was: "Industrial  segments",
    who: "b",
    at: "2026-09-20T10:00:00Z",
    check: null,
    note: "",
    ...over,
  });

  it("a whitespace-only difference is not a change", () => {
    expect(changes([rec()])).toHaveLength(0);
  });

  it("a real edit still counts", () => {
    expect(changes([rec({ text: "Industrial sections" })])).toHaveLength(1);
  });
});

describe("probe statistics do not count missing answers as results", () => {
  const order = (over: Partial<OrderProbe> = {}): OrderProbe => ({
    id: "t/de",
    first: "A",
    second: "A",
    agree: true,
    confidenceFirst: 0.9,
    confidenceSecond: 0.9,
    maxDrift: 0.01,
    ...over,
  });

  it("two answers that never arrived are not an agreement", () => {
    const real = [order(), order({ id: "b", first: "A", second: "B", agree: false })];
    expect(orderStats(real).agreementRate).toBe(0.5);
  });

  const scope = (over: Partial<ScopeProbe> = {}): ScopeProbe => ({
    id: "t/de",
    tookNoMatch: false,
    chose: "A",
    confidence: 0.5,
    presence: 0.2,
    ...over,
  });

  it("one missing confidence does not erase the mean", () => {
    const st = scopeStats([scope({ confidence: 0.4 }), scope({ confidence: 0.6 }), scope({ confidence: NaN })]);
    expect(st.meanConfidenceWhenWrong).toBeCloseTo(0.5, 6);
  });

  it("the presence question is scored over the probes that answered it", () => {
    const st = scopeStats([scope({ presence: 0.1 }), scope({ presence: 0.2 }), scope({ presence: NaN })]);
    expect(st.presenceN).toBe(2);
    expect(st.presenceRate).toBe(1);
  });

  it("a probe that declined is not counted as confidently wrong", () => {
    const st = scopeStats([scope({ tookNoMatch: true, confidence: 0.95 })]);
    expect(st.confidentlyWrong).toBe(0);
    expect(st.caughtRate).toBe(1);
  });
});

describe("indexByTerm groups payloads", () => {
  it("returns every entry sharing a term", () => {
    const index = indexByTerm(
      [
        { term: "brama", lang: "de" },
        { term: "brama", lang: "fr" },
        { term: "adres", lang: "de" },
      ],
      (g) => g.term,
    );
    const hit = index.matches("Brama i adres").flatMap((m) => m.value);
    expect(hit).toHaveLength(3);
    expect(hit.filter((g) => g.term === "brama")).toHaveLength(2);
  });
});

describe("compose is unaffected by index vs scan", () => {
  const entries: Entry[] = [
    { id: "1", project: "p", keyName: "k1", source: "Podaj adres dostawy", description: "", context: "", tags: [], tr: { pl: "x", de: "y" }, status: {} },
    { id: "2", project: "p", keyName: "k2", source: "Kod adresowy klienta", description: "", context: "", tags: [], tr: { pl: "x", de: "y" }, status: {} },
  ];
  const corpus: Corpus = { sourceLang: "pl", langs: ["pl", "de"], entries, origin: "t" };
  const glossary: GlossaryEntry[] = [
    { term: "adres", lang: "de", canonical: "Adresse", confidence: 0.9, interchangeable: NaN, doNotTranslate: 0, covered: 0.9, severity: 1, variants: [], entryIds: [], origin: "duplicate-source" },
  ];

  it("selects the boundary-respecting entry only", () => {
    const index = indexByTerm(glossary, (g) => g.term);
    expect(corpus.entries.filter((e) => index.matches(e.source).length > 0).map((e) => e.id)).toEqual(["1"]);
  });
});

describe("the cache repairs NaN on the way back in", () => {
  const dir = mkdtempSync(join(tmpdir(), "ta-cache-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const path = join(dir, "run.json");

  it("brings unknown numbers back as NaN, not null", () => {
    saveCache(path, {
      corpus: { sourceLang: "pl", langs: ["pl", "de"], entries: [], origin: "t" },
      lintIssues: [],
      glossary: [
        {
          term: "a",
          lang: "de",
          canonical: null,
          confidence: 0,
          interchangeable: NaN,
          doNotTranslate: NaN,
          covered: NaN,
          severity: NaN,
          variants: [],
          entryIds: [],
          origin: "duplicate-source",
        },
      ],
      judgments: [["k", { entryId: "k", isUiString: NaN, meaning: {}, adheres: {}, register: {}, ms: 1 }]],
      registerNorms: [],
      stages: [],
      substitutions: [{ entryId: "k", lang: "de", suggested: "x", check: NaN, note: "" }],
    });

    const back = loadCache(path);
    expect(Number.isNaN(back.glossary[0].severity)).toBe(true);
    expect(Number.isNaN(back.glossary[0].covered)).toBe(true);
    expect(Number.isNaN(back.glossary[0].doNotTranslate)).toBe(true);
    expect(Number.isNaN(back.judgments[0][1].isUiString)).toBe(true);
    expect(Number.isNaN(back.substitutions[0].check)).toBe(true);
  });

  it("leaves real numbers alone", () => {
    const back = loadCache(path);
    expect(back.glossary[0].confidence).toBe(0);
  });
});
