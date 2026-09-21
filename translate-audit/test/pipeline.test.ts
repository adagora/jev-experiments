import { describe, expect, it } from "vitest";
import type { Corpus, Entry, EntryJudgment, GlossaryEntry } from "../src/types.ts";
import { lintCorpus } from "../src/lint.ts";
import { mineGlossary } from "../src/mine.ts";
import { compose } from "../src/compose.ts";
import { proposeSubstitutions } from "../src/substitute.ts";
import { auditQuestions, arbitrationQuestions, CONTEXT_DEPENDENT } from "../src/jev/questions.ts";
import { generateSynthetic } from "../src/sources/synthetic.ts";
import { parseDelimited, sniffDelimiter, decodeBuffer } from "../src/sources/csv.ts";

const entry = (id: string, source: string, tr: Record<string, string>): Entry => ({
  id,
  project: "t",
  keyName: id,
  source,
  description: "",
  context: "",
  tags: [],
  tr: { pl: source, ...tr },
  status: {},
});

const corpusOf = (entries: Entry[], langs = ["pl", "de", "en"]): Corpus => ({
  sourceLang: "pl",
  langs,
  entries,
  origin: "test",
});

describe("lint", () => {
  it("catches a dropped placeholder but not a reordered one", () => {
    const c = corpusOf([
      entry("a", "Cena {0} i {1}", { de: "Preis {1} und {0}" }),
      entry("b", "Cena {0} i {1}", { de: "Preis {0}" }),
    ]);
    const codes = lintCorpus(c).issues.filter((i) => i.code === "placeholder-mismatch");
    expect(codes.map((i) => i.entryId)).toEqual(["b"]);
    expect(codes[0].detail).toBe("{1}: 1→0");
  });

  it("separates a spacing variant from a real terminology divergence", () => {
    const c = corpusOf([
      entry("a", "VAT", { de: "MwSt. (%)" }),
      entry("b", "VAT", { de: "MwSt (%)" }),
      entry("c", "Usuń", { de: "Löschen" }),
      entry("d", "Usuń", { de: "Entfernen" }),
    ]);
    const issues = lintCorpus(c).issues;
    expect(issues.filter((i) => i.code === "spacing-variant").map((i) => i.entryId).sort()).toEqual(["a", "b"]);
    expect(issues.filter((i) => i.code === "duplicate-source-divergent").map((i) => i.entryId).sort()).toEqual(["c", "d"]);
  });

  it("flags an empty translation and skips its other checks", () => {
    const c = corpusOf([entry("a", "Cena {0}", { de: "" })]);
    const forDe = lintCorpus(c).issues.filter((i) => i.lang === "de");
    expect(forDe.map((i) => i.code)).toEqual(["empty-translation"]);
  });

  it("does not call a short label an untranslated copy", () => {
    const c = corpusOf([entry("a", "ADMINISTRATOR", { de: "ADMINISTRATOR" }), entry("b", "Numer zamówienia klienta", { de: "Numer zamówienia klienta" })]);
    const copies = lintCorpus(c).issues.filter((i) => i.code === "untranslated-copy");
    expect(copies.map((i) => i.entryId)).toEqual(["b"]);
  });
});

describe("mine", () => {
  const c = corpusOf([
    entry("a", "Usuń", { de: "Löschen", en: "Delete" }),
    entry("b", "Usuń", { de: "Entfernen", en: "Delete" }),
    entry("c", "VAT", { de: "MwSt. (%)", en: "VAT (%)" }),
    entry("d", "VAT", { de: "MwSt (%)", en: "VAT(%)" }),
    entry("f", "VAT", { de: "MwSt. (%)", en: "VAT (%)" }),
    entry("e", "Wyślij", { de: "Senden", en: "Send" }),
  ]);
  const mined = mineGlossary(c);

  it("raises only genuinely contested terms for arbitration", () => {
    expect(mined.conflicts.map((x) => `${x.term}/${x.lang}`)).toEqual(["usun/de"]);
  });

  it("resolves spacing-only variants in code, by majority", () => {
    const de = mined.resolved.find((g) => g.term === "vat" && g.lang === "de");
    expect(de?.canonical).toBe("MwSt. (%)");
    expect(de?.confidence).toBe(1);
    expect(de?.origin).toBe("spacing-or-case");
    expect(de?.variants.map((v) => v.count)).toEqual([2, 1]);
  });

  it("records terms everyone already agrees on without asking anything", () => {
    expect(mined.agreed.get("usun\u0000en")).toBe("Delete");
    expect(mined.agreed.get("wyslij\u0000de")).toBe("Senden");
  });

  it("does not extract an identifier as a term", () => {
    const withId = corpusOf([entry("x", "ktm_b2100", { de: "BR-100" }), entry("y", "ktm_b2100", { de: "BR100" })]);
    expect(mineGlossary(withId).conflicts).toEqual([]);
    expect(mineGlossary(withId).resolved).toEqual([]);
  });

  it("pulls in long strings that use a losing rendering", () => {
    const long = corpusOf([
      entry("a", "Usuń", { de: "Löschen" }),
      entry("b", "Usuń", { de: "Entfernen" }),
      entry("c", "Czy na pewno chcesz usuń pozycję z koszyka", { de: "Möchten Sie die Position wirklich entfernen" }),
    ]);
    const conflict = mineGlossary(long).conflicts.find((x) => x.term === "usun" && x.lang === "de");
    expect(conflict?.entryIds).toContain("c");
  });
});

describe("questions", () => {
  it("offers a no-match outcome so a context-dependent term is not forced", () => {
    const conflict = mineGlossary(
      corpusOf([entry("a", "Usuń", { de: "Löschen" }), entry("b", "Usuń", { de: "Entfernen" })]),
    ).conflicts[0];
    const q = arbitrationQuestions(conflict);
    expect(q.canonical.type).toBe("choice");
    const criteria = (q.canonical as { criteria: Record<string, unknown> }).criteria;
    expect(Object.keys(criteria)).toContain(CONTEXT_DEPENDENT);
    expect(Object.keys(criteria)).toContain("Löschen");
    expect(Object.keys(criteria)).toContain("Entfernen");
  });

  it("asks nothing about a language with no translation", () => {
    const q = auditQuestions({ meaning: ["de"], adherence: [], register: [] }, "pl");
    expect(Object.keys(q).sort()).toEqual(["meaning:de", "uiString"]);
  });

  it("fans out one question per language per dimension", () => {
    const q = auditQuestions({ meaning: ["de", "uk", "fr"], adherence: ["de"], register: ["de", "uk", "fr"] }, "pl");
    expect(Object.keys(q)).toHaveLength(1 + 3 + 1 + 3);
  });
});

describe("compose", () => {
  const c = corpusOf([entry("a", "Cena {0} nie została wyliczona", { de: "Der Preis wurde berechnet" })]);
  const lint = lintCorpus(c);

  const judge = (meaning: number, isUi = 1): Map<string, EntryJudgment> =>
    new Map([["a", { entryId: "a", isUiString: isUi, meaning: { de: meaning }, adheres: {}, register: {}, ms: 1 }]]);

  it("escalates a reversed meaning to the top severity", () => {
    const f = compose({ corpus: c, lintIssues: lint.issues, judgments: judge(0.04), glossary: [], registerNorms: new Map() });
    const de = f.find((x) => x.lang === "de")!;
    expect(de.severity).toBe(3);
    expect(de.action).toBe("needs human");
    expect(de.reasons.map((r) => r.rule)).toContain("meaning-not-preserved");
  });

  it("files a completeness gap apart from a terminology one", () => {
    const missing = corpusOf([entry("m", "Zapisz zmiany", { de: "" })]);
    const f = compose({ corpus: missing, lintIssues: lintCorpus(missing).issues, judgments: new Map(), glossary: [], registerNorms: new Map() });
    expect(f.find((x) => x.lang === "de")?.category).toBe("completeness");
  });

  it("calls a reversed meaning a meaning problem, not a style one", () => {
    const f = compose({ corpus: c, lintIssues: [], judgments: judge(0.04), glossary: [], registerNorms: new Map() });
    expect(f[0].category).toBe("meaning");
  });

  it("ranks integrity above everything else it is mixed with", () => {
    const f = compose({ corpus: c, lintIssues: lint.issues, judgments: judge(0.04), glossary: [], registerNorms: new Map() });
    expect(f[0].category).toBe("integrity");
  });

  it("keeps the exact placeholder defect regardless of the judgment", () => {
    const f = compose({ corpus: c, lintIssues: lint.issues, judgments: judge(0.99), glossary: [], registerNorms: new Map() });
    expect(f[0].reasons).toContainEqual({ rule: "lint", code: "placeholder-mismatch", detail: expect.any(String) });
  });

  it("suppresses semantic findings on strings that are not user-facing", () => {
    const f = compose({ corpus: c, lintIssues: lint.issues, judgments: judge(0.02, 0.01), glossary: [], registerNorms: new Map() });
    expect(f[0].reasons.map((r) => r.rule)).not.toContain("meaning-not-preserved");
  });

  it("ignores a string that addresses nobody when measuring formality drift", () => {
    const judgments = new Map([
      ["a", { entryId: "a", isUiString: 1, meaning: { de: 0.99 }, adheres: {}, register: { de: { form: "none" as const, confidence: 0.9 } }, ms: 1 }],
    ]);
    const norms = new Map([["de", { formalShare: 0.95, n: 100 }]]);
    expect(compose({ corpus: c, lintIssues: [], judgments, glossary: [], registerNorms: norms })).toHaveLength(0);
  });

  it("raises drift only against a dominant house register", () => {
    const informal = (n: number, formalShare: number) =>
      compose({
        corpus: c,
        lintIssues: [],
        judgments: new Map([
          ["a", { entryId: "a", isUiString: 1, meaning: { de: 0.99 }, adheres: {}, register: { de: { form: "informal" as const, confidence: 0.9 } }, ms: 1 }],
        ]),
        glossary: [],
        registerNorms: new Map([["de", { formalShare, n }]]),
      });
    expect(informal(100, 0.95)).toHaveLength(1);
    expect(informal(100, 0.55)).toHaveLength(0);
    expect(informal(5, 0.95)).toHaveLength(0);
  });

  it("changing the policy needs no new judgments", () => {
    const judgments = judge(0.5);
    const strict = compose({ corpus: c, lintIssues: [], judgments, glossary: [], registerNorms: new Map(), policy: { ...POLICY_FOR_TEST, meaningBad: 0.6 } });
    const loose = compose({ corpus: c, lintIssues: [], judgments, glossary: [], registerNorms: new Map(), policy: { ...POLICY_FOR_TEST, meaningBad: 0.1, meaningDoubtful: 0.2 } });
    expect(strict[0].severity).toBe(3);
    expect(loose).toHaveLength(0);
  });
});

const POLICY_FOR_TEST = {
  meaningBad: 0.35,
  meaningDoubtful: 0.7,
  adherenceBad: 0.4,
  uiStringMin: 0.25,
  registerMinSample: 25,
  registerMinDominance: 0.8,
  registerMinConfidence: 0.6,
  canonicalConfidence: 0.6,
};

describe("substitutions", () => {
  const glossary: GlossaryEntry[] = [
    {
      term: "usun",
      lang: "de",
      canonical: "Löschen",
      confidence: 0.9,
      interchangeable: 0.8,
      doNotTranslate: 0.01,
      covered: 0.95,
      severity: 1.5,
      variants: [
        { text: "Löschen", count: 9, examples: [] },
        { text: "Entfernen", count: 2, examples: [] },
      ],
      entryIds: ["a"],
      origin: "duplicate-source",
    },
  ];

  const finding = (current: string) => ({
    entryId: "a",
    project: "t",
    keyName: "a",
    lang: "de",
    source: "Usuń",
    current,
    suggested: null,
    reasons: [{ rule: "canonical-not-used" as const, p: 0.2, threshold: 0.4, terms: [] }],
    category: "consistency" as const,
    severity: 1,
    action: "auto-fix" as const,
    confidence: 0.8,
    substitutionOk: null,
    judged: true,
  });

  it("proposes an edit only when a losing rendering is literally present", () => {
    expect(proposeSubstitutions([finding("Entfernen")], glossary)).toHaveLength(1);
    expect(proposeSubstitutions([finding("Löschen")], glossary)).toHaveLength(0);
    expect(proposeSubstitutions([finding("Etwas anderes")], glossary)).toHaveLength(0);
  });

  it("produces the edited string, not instructions to edit", () => {
    const [p] = proposeSubstitutions([finding("Entfernen")], glossary);
    expect(p.after).toBe("Löschen");
    expect(p.from).toBe("Entfernen");
  });

  it("refuses to touch a term marked do-not-translate", () => {
    const brand = [{ ...glossary[0], doNotTranslate: 0.95 }];
    expect(proposeSubstitutions([finding("Entfernen")], brand)).toHaveLength(0);
  });

  it("refuses a canonical the model was unsure about", () => {
    const unsure = [{ ...glossary[0], confidence: 0.3 }];
    expect(proposeSubstitutions([finding("Entfernen")], unsure)).toHaveLength(0);
  });
});

describe("synthetic corpus", () => {
  it("is reproducible for a given seed", () => {
    const a = generateSynthetic({ keys: 50, langs: ["de", "uk"], seed: 7 });
    const b = generateSynthetic({ keys: 50, langs: ["de", "uk"], seed: 7 });
    expect(a.corpus.entries).toEqual(b.corpus.entries);
    expect(a.truth).toEqual(b.truth);
  });

  it("records every defect it injects", () => {
    const { corpus, truth } = generateSynthetic({ keys: 200, langs: ["de"], seed: 3, defectRate: 0.5 });
    expect(truth.length).toBeGreaterThan(20);
    for (const t of truth) {
      const e = corpus.entries.find((x) => x.id === t.entryId)!;
      expect(e.tr[t.lang]).toBe(t.injected);
    }
  });

  it("injected placeholder drops are caught by lint alone", () => {
    const { corpus, truth } = generateSynthetic({ keys: 300, langs: ["de", "uk"], seed: 11, defectRate: 0.4 });
    const dropped = new Set(truth.filter((t) => t.defect === "placeholder-dropped").map((t) => `${t.entryId}\u0000${t.lang}`));
    const caught = new Set(
      lintCorpus(corpus).issues.filter((i) => i.code === "placeholder-mismatch").map((i) => `${i.entryId}\u0000${i.lang}`),
    );
    expect(dropped.size).toBeGreaterThan(0);
    for (const k of dropped) expect(caught.has(k)).toBe(true);
  });
});

describe("csv", () => {
  it("sniffs the delimiter and keeps quoted separators", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(parseDelimited('a;b\n"x;y";z\n', ";")).toEqual([["a", "b"], ["x;y", "z"]]);
  });

  it("falls back to CP1250 when UTF-8 decoding breaks, and counts prior loss", () => {
    const cp1250 = Buffer.from([0x57, 0x49, 0x3f, 0x4e, 0x49, 0x4f, 0x57, 0x53, 0x4b, 0x49, 0x20, 0x73, 0x6b, 0x72, 0xf3, 0x74]);
    const { text, encoding, lossy } = decodeBuffer(cp1250);
    expect(encoding).toBe("windows-1250");
    expect(text).toContain("skrót");
    expect(lossy).toBeGreaterThan(0);
  });
});
