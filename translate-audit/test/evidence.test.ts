import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidencePathFor, fingerprint } from "../src/evidence/store.ts";
import { JevClient, choice, noul, type Question } from "../src/jev/client.ts";
import { audit } from "../src/audit.ts";
import { lintCorpus } from "../src/lint.ts";
import { generateSynthetic } from "../src/sources/synthetic.ts";

const dirs: string[] = [];
const tempFile = (name = "evidence.jsonl"): string => {
  const d = mkdtempSync(join(tmpdir(), "evidence-"));
  dirs.push(d);
  return join(d, name);
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Counts every call so a test can say exactly how many requests were made. */
function countingFetch(opts: { failFor?: (unit: string) => boolean } = {}) {
  const calls: string[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state: { key_name?: string }; questions: Record<string, Question> };
    const unit = body.state.key_name ?? "";
    calls.push(unit);
    if (opts.failFor?.(unit)) return new Response("no", { status: 400 });
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(body.questions)) {
      if (q.type === "noul") answers[name] = { type: "noul", noul: 0.9 };
      else if (q.type === "choice") {
        const first = Object.keys(q.criteria)[0];
        answers[name] = { type: "choice", choice: first, probabilities: { [first]: 0.9 }, confidence: 0.9 };
      } else answers[name] = { type: "score", score: 1, legend: {}, probabilities: {}, confidence: 0.9 };
    }
    return new Response(JSON.stringify({ model: "stub", answers, usage: { input_tokens: 100, output_tokens: 20 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const corpusOf = (keys: number) =>
  generateSynthetic({ keys, langs: ["de", "uk"], seed: 20250920, defectRate: 0.1 }).corpus;

describe("a judgment is addressed by what it depends on", () => {
  const questions: Record<string, Question> = { a: noul("does it?"), b: choice("which?", ["x", "y"]) };

  it("is stable however the state object was built", () => {
    const one = { alpha: 1, beta: { deep: [1, 2], other: "s" } };
    const other = { beta: { other: "s", deep: [1, 2] }, alpha: 1 };
    expect(fingerprint("m", one, questions)).toBe(fingerprint("m", other, questions));
  });

  it("changes with the model, so an answer is never served for a different one", () => {
    expect(fingerprint("m1", { a: 1 }, questions)).not.toBe(fingerprint("m2", { a: 1 }, questions));
  });

  it("changes when a question's wording changes", () => {
    const reworded: Record<string, Question> = { ...questions, a: noul("does it, really?") };
    expect(fingerprint("m", { a: 1 }, reworded)).not.toBe(fingerprint("m", { a: 1 }, questions));
  });

  it("changes when the options are reordered, because a Choice is presented in order", () => {
    // `probe` asks the same question twice with the options reversed. Treating those two
    // as one address would hand the second ask the first one's answer and destroy the
    // measurement — so option order is part of the address on purpose.
    const reversed: Record<string, Question> = { ...questions, b: choice("which?", ["y", "x"]) };
    expect(fingerprint("m", { a: 1 }, reversed)).not.toBe(fingerprint("m", { a: 1 }, questions));
  });

  it("keeps array order, which is data", () => {
    expect(fingerprint("m", { xs: [1, 2] }, questions)).not.toBe(fingerprint("m", { xs: [2, 1] }, questions));
  });
});

describe("the store", () => {
  it("survives a truncated final line rather than refusing to open", () => {
    const path = tempFile();
    const good = { fp: "abc", model: "m", stage: "s", unit: "u", answers: {}, usage: { input_tokens: 1, output_tokens: 1 }, ms: 1, at: "now" };
    writeFileSync(path, JSON.stringify(good) + "\n" + '{"fp":"def","answ', "utf8");
    const store = EvidenceStore.open(path);
    expect(store.size).toBe(1);
    expect(store.damaged).toBe(1);
    expect(store.has("abc")).toBe(true);
  });

  it("keeps the state only when asked to", () => {
    const rec = { fp: "x", model: "m", stage: "s", unit: "u", answers: {}, usage: { input_tokens: 1, output_tokens: 1 }, ms: 1, at: "now" };
    const plain = tempFile();
    EvidenceStore.open(plain).append(rec, { secret: "big state" });
    expect(readFileSync(plain, "utf8")).not.toContain("big state");

    const kept = tempFile();
    EvidenceStore.open(kept, { keepState: true }).append(rec, { secret: "big state" });
    expect(readFileSync(kept, "utf8")).toContain("big state");
  });

  it("names the evidence file after whatever the run is called", () => {
    expect(evidencePathFor("audit.xlsx")).toBe("audit.evidence.jsonl");
    expect(evidencePathFor("audit.run.json")).toBe("audit.evidence.jsonl");
  });
});

describe("what the keystone buys", () => {
  it("re-running identical inputs makes no requests at all", async () => {
    const corpus = corpusOf(40);
    const lint = lintCorpus(corpus).issues;
    const path = tempFile();

    const first = countingFetch();
    const cold = new JevClient({
      apiKey: "x",
      fetchImpl: first.impl,
      concurrency: 4,
      evidence: EvidenceStore.open(path),
    });
    const a = await audit(cold, corpus, [], lint, { register: false });
    expect(first.calls.length).toBe(a.stats.requests);
    expect(a.stats.reused).toBe(0);

    const second = countingFetch();
    const warm = new JevClient({
      apiKey: "x",
      fetchImpl: second.impl,
      concurrency: 4,
      evidence: EvidenceStore.open(path),
    });
    const b = await audit(warm, corpus, [], lint, { register: false });

    expect(second.calls).toEqual([]);
    expect(b.stats.reused).toBe(b.stats.requests);
    expect(b.stats.inputTokens).toBe(0);
    expect(b.stats.outputTokens).toBe(0);
    // and the answers are the same ones, not absent ones
    expect(b.judgments.size).toBe(a.judgments.size);
  });

  it("a run that died resumes by asking exactly what it never got", async () => {
    const corpus = corpusOf(40);
    const lint = lintCorpus(corpus).issues;
    const path = tempFile();

    // every third key fails, so its judgment is never written
    const doomed = (keyName: string) => Number(keyName.split(".").at(-1)) % 3 === 0;
    const partial = countingFetch({ failFor: doomed });
    const wounded = new JevClient({
      apiKey: "x",
      fetchImpl: partial.impl,
      concurrency: 4,
      maxAttempts: 1,
      evidence: EvidenceStore.open(path),
    });
    const a = await audit(wounded, corpus, [], lint, { register: false });
    expect(a.stats.errors).toBeGreaterThan(0);

    const retry = countingFetch();
    const healed = new JevClient({
      apiKey: "x",
      fetchImpl: retry.impl,
      concurrency: 4,
      evidence: EvidenceStore.open(path),
    });
    const b = await audit(healed, corpus, [], lint, { register: false });

    expect(retry.calls.length).toBe(a.stats.errors);
    expect(b.stats.reused).toBe(b.stats.requests - a.stats.errors);
    expect(b.stats.errors).toBe(0);
  });

  it("changing a question re-asks only the keys that ask it", async () => {
    const corpus = corpusOf(40);
    const lint = lintCorpus(corpus).issues;
    const path = tempFile();

    const cold = countingFetch();
    await audit(
      new JevClient({ apiKey: "x", fetchImpl: cold.impl, concurrency: 4, evidence: EvidenceStore.open(path) }),
      corpus,
      [],
      lint,
      { register: false },
    );

    // `register` adds a question to the keys long enough to carry one, and leaves the
    // rest of the corpus untouched.
    const warm = countingFetch();
    const res = await audit(
      new JevClient({ apiKey: "x", fetchImpl: warm.impl, concurrency: 4, evidence: EvidenceStore.open(path) }),
      corpus,
      [],
      lint,
      { register: true },
    );

    expect(warm.calls.length).toBeGreaterThan(0);
    expect(warm.calls.length).toBeLessThan(res.stats.requests);
    expect(res.stats.reused).toBe(res.stats.requests - warm.calls.length);
  });

  it("without a store, nothing is remembered", async () => {
    const corpus = corpusOf(20);
    const lint = lintCorpus(corpus).issues;
    const first = countingFetch();
    const a = await audit(
      new JevClient({ apiKey: "x", fetchImpl: first.impl, concurrency: 4 }),
      corpus,
      [],
      lint,
      { register: false },
    );
    const second = countingFetch();
    await audit(new JevClient({ apiKey: "x", fetchImpl: second.impl, concurrency: 4 }), corpus, [], lint, {
      register: false,
    });
    expect(second.calls.length).toBe(a.stats.requests);
  });
});
