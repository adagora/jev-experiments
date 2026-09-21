import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffRuns, explain, inspect, planRun, status } from "../src/commands/observe.ts";
import { DEFAULT_POLICY, loadProfile } from "../src/config/profile.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { JevClient, type Question } from "../src/jev/client.ts";
import { audit } from "../src/audit.ts";
import { compose } from "../src/compose.ts";
import { lintCorpus } from "../src/lint.ts";
import { saveCache } from "../src/cache.ts";
import { loadCache } from "../src/cache.ts";
import { generateSynthetic } from "../src/sources/synthetic.ts";
import type { Finding } from "../src/types.ts";

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "observe-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const profile = loadProfile();
const corpusOf = (keys: number) =>
  generateSynthetic({ keys, langs: ["de", "uk"], seed: 20250920, defectRate: 0.1 }).corpus;

function stubFetch() {
  const calls: string[] = [];
  const impl = (async (_u: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state: { key_name?: string }; questions: Record<string, Question> };
    calls.push(body.state.key_name ?? "");
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(body.questions)) {
      if (q.type === "noul") answers[name] = { type: "noul", noul: 0.2 };
      else if (q.type === "choice") {
        const first = Object.keys(q.criteria)[0];
        answers[name] = { type: "choice", choice: first, probabilities: { [first]: 0.9 }, confidence: 0.9 };
      } else answers[name] = { type: "score", score: 2, legend: {}, probabilities: {}, confidence: 0.9 };
    }
    return new Response(JSON.stringify({ model: "stub", answers, usage: { input_tokens: 500, output_tokens: 90 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("plan says what a run would cost, before it costs it", () => {
  it("predicts the audit's request count exactly", async () => {
    const corpus = corpusOf(50);
    const path = join(tempDir(), "e.jsonl");
    const before = planRun({ corpus, profile, store: EvidenceStore.open(path), register: false });
    const audited = before.stages.find((s) => s.stage === "audit")!;

    const { impl, calls } = stubFetch();
    const res = await audit(
      new JevClient({ apiKey: "x", fetchImpl: impl, concurrency: 4, evidence: EvidenceStore.open(path) }),
      corpus,
      [],
      lintCorpus(corpus).issues,
      { register: false },
    );

    expect(audited.units).toBe(res.stats.requests);
    expect(audited.toAsk).toBe(calls.length);
  });

  it("counts what the store already holds as bought, and asks for nothing more", async () => {
    const corpus = corpusOf(50);
    const path = join(tempDir(), "e.jsonl");
    const { impl } = stubFetch();
    await audit(
      new JevClient({ apiKey: "x", fetchImpl: impl, concurrency: 4, evidence: EvidenceStore.open(path) }),
      corpus,
      [],
      lintCorpus(corpus).issues,
      { register: false },
    );

    const after = planRun({ corpus, profile, store: EvidenceStore.open(path), register: false });
    const audited = after.stages.find((s) => s.stage === "audit")!;
    expect(audited.cached).toBe(audited.units);
    expect(audited.toAsk).toBe(0);
    expect(audited.estUsd).toBe(0);
  });

  it("says plainly when its token estimates are assumptions rather than measurements", () => {
    const plan = planRun({ corpus: corpusOf(20), profile, store: null, register: false });
    expect(plan.learned).toBe(false);
    expect(plan.estUsd).toBeGreaterThan(0);
  });

  it("does not pretend to predict the substitution stage", () => {
    const plan = planRun({ corpus: corpusOf(20), profile, store: null, fix: true });
    expect(plan.unpredictable.join(" ")).toContain("substitute");
    expect(planRun({ corpus: corpusOf(20), profile, store: null, fix: false }).unpredictable).toEqual([]);
  });
});

describe("explain gives the derivation, not a restatement", () => {
  const finding: Finding = {
    entryId: "k", project: "p", keyName: "k", lang: "de",
    source: "Anuluj", current: "Klonen", suggested: null,
    reasons: [
      { rule: "meaning-not-preserved", p: 0.01, threshold: 0.35 },
      { rule: "canonical-not-used", p: 0.02, threshold: 0.4, terms: [{ term: "anuluj", canonical: "stornieren" }] },
      { rule: "lint", code: "case-inconsistent", detail: "source is lower, translation is title" },
    ],
    category: "meaning", severity: 3, action: "needs human", confidence: 0.99, substitutionOk: null, judged: true,
  };

  it("names the evidence, the threshold and what each rule contributed", () => {
    const rows = explain(finding, profile);
    expect(rows.map((r) => r.rule)).toEqual([
      "meaning-not-preserved",
      "canonical-not-used",
      "lint/case-inconsistent",
    ]);
    expect(rows[0].evidence).toBe("meaning p=0.01");
    expect(rows[0].compared).toBe(`< meaningBad ${DEFAULT_POLICY.meaningBad}`);
    expect(rows[2].compared).toContain("no model was involved");
  });

  it("says what value would flip the answer", () => {
    const rows = explain(finding, profile);
    expect(rows[0].flipsAt).toContain("meaningBad <= 0.01");
    expect(rows[1].flipsAt).toContain("adherenceBad <= 0.02");
    // an exact check has no threshold to move
    expect(rows[2].flipsAt).toBeUndefined();
  });

  it("explains a blind cell as a blind cell", () => {
    const blind: Finding = { ...finding, judged: false, reasons: [{ rule: "not-judged", stage: "audit" }] };
    const [row] = explain(blind, profile);
    expect(row.contributed).toContain("nothing here rules out a meaning defect");
    expect(row.flipsAt).toContain("re-run");
  });
});

describe("inspect finds a key however you name it", () => {
  const corpus = corpusOf(30);
  const cache = {
    version: 2, savedAt: new Date().toISOString(),
    corpus, lintIssues: lintCorpus(corpus).issues, glossary: [],
    judgments: [] as never[], registerNorms: [] as never[], stages: [], unjudged: [], substitutions: [],
  };
  const findings = compose({
    corpus, lintIssues: cache.lintIssues, judgments: new Map(), glossary: [], registerNorms: new Map(),
  });
  const target = corpus.entries[3];

  it("by id, by key name, and by source text", () => {
    for (const q of [target.id, target.keyName, target.source]) {
      const found = inspect(cache as never, findings, q);
      expect(found.found, `looking up ${JSON.stringify(q)}`).toBe(true);
      expect((found.entry as { id: string }).id).toBe(target.id);
    }
  });

  it("says so rather than guessing when nothing matches", () => {
    expect(inspect(cache as never, findings, "no such key anywhere").found).toBe(false);
  });

  it("returns one row per target language, including the ones with no translation", () => {
    const found = inspect(cache as never, findings, target.id);
    expect(found.translations).toHaveLength(corpus.langs.filter((l) => l !== corpus.sourceLang).length);
  });
});

describe("status reads a directory rather than being told about it", () => {
  it("names each artifact and what is in it", () => {
    const d = tempDir();
    const corpus = corpusOf(10);
    saveCache(join(d, "a.run.json"), {
      corpus, lintIssues: [], glossary: [], judgments: [], registerNorms: [], stages: [], unjudged: [], substitutions: [],
    });
    writeFileSync(join(d, "a.glossary.json"), JSON.stringify({ version: 1, updatedAt: "", terms: [] }), "utf8");

    const { artifacts } = status(d);
    expect(artifacts.map((a) => a.kind).sort()).toEqual(["glossary", "run"]);
    expect(artifacts.find((a) => a.kind === "run")!.detail).toContain("10 keys");
  });

  it("reports an unreadable artifact instead of throwing", () => {
    const d = tempDir();
    writeFileSync(join(d, "broken.run.json"), "{ not json", "utf8");
    const { artifacts, warnings } = status(d);
    expect(artifacts[0].detail).toBe("unreadable");
    expect(warnings.some((w) => w.code === "unreadable")).toBe(true);
  });
});

describe("diff attributes a change", () => {
  const write = (dir: string, name: string, meaning: number): string => {
    const corpus = corpusOf(20);
    const path = join(dir, name);
    saveCache(path, {
      corpus,
      lintIssues: [],
      glossary: [],
      judgments: corpus.entries.map((e) => [
        e.id,
        { entryId: e.id, isUiString: 1, meaning: { de: meaning }, adheres: {}, register: {}, ms: 1 },
      ]),
      registerNorms: [],
      stages: [],
      unjudged: [],
      substitutions: [],
    });
    return path;
  };

  it("is empty between a run and itself", () => {
    const d = tempDir();
    const a = write(d, "a.run.json", 0.05);
    const diff = diffRuns(a, a, profile);
    expect(diff.counts.added).toBe(0);
    expect(diff.counts.gone).toBe(0);
    expect(diff.byRule).toEqual([]);
  });

  it("counts what appeared and what went, by rule", () => {
    const d = tempDir();
    const clean = write(d, "clean.run.json", 0.99);
    const broken = write(d, "broken.run.json", 0.05);
    const diff = diffRuns(clean, broken, profile);

    expect(Number(diff.counts.added)).toBeGreaterThan(0);
    expect(diff.counts.gone).toBe(0);
    expect(Object.fromEntries(diff.byRule)["meaning-not-preserved"]).toBeGreaterThan(0);
    expect(Object.fromEntries(diff.bySeverity)["severity 3"]).toBeGreaterThan(0);
  });

  it("warns when the two runs did not ask the same questions", () => {
    const d = tempDir();
    const a = write(d, "a.run.json", 0.05);
    const b = write(d, "b.run.json", 0.05);
    const withProv = loadCache(a);
    saveCache(a, {
      ...withProv,
      provenance: {
        questions: "aaaaaaaaaaaa", model: "m", domain: "d",
        policy: DEFAULT_POLICY, gates: profile.gates, configuredBy: [],
      },
    });
    expect(diffRuns(a, b, profile).counts["questions left"]).toBe("aaaaaaaaaaaa");
    expect(diffRuns(a, b, profile).counts["questions right"]).toBe("unknown");
  });
});
