import { describe, expect, it } from "vitest";
import { JevClient, type Question } from "../src/jev/client.ts";
import { audit } from "../src/audit.ts";
import { compose, completeness, coverageOf, totalCoverage } from "../src/compose.ts";
import { lintCorpus } from "../src/lint.ts";
import { generateSynthetic } from "../src/sources/synthetic.ts";
import type { StageStats } from "../src/types.ts";

/**
 * An unjudged key produces only lint findings, which looks exactly like a key that
 * passed. These tests fail requests on purpose and check that the run says so.
 *
 * They are also the only tests that exercise `JevClient` at all — the `fetchImpl` seam
 * existed and nothing used it, so the retry ladder and every error path ran only
 * against production.
 */
type Body = { state: { key_name?: string }; questions: Record<string, Question> };

function stubFetch(opts: { failFor?: (keyName: string) => boolean; failStatus?: number } = {}) {
  const calls: { keyName: string; status: number }[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const keyName = body.state.key_name ?? "";
    if (opts.failFor?.(keyName)) {
      const status = opts.failStatus ?? 400;
      calls.push({ keyName, status });
      return new Response("stub refused", { status });
    }
    calls.push({ keyName, status: 200 });

    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(body.questions)) {
      if (q.type === "noul") answers[name] = { type: "noul", noul: 0.9 };
      else if (q.type === "choice") {
        const first = Object.keys(q.criteria)[0];
        answers[name] = { type: "choice", choice: first, probabilities: { [first]: 0.9 }, confidence: 0.9 };
      } else {
        answers[name] = { type: "score", score: 1, legend: {}, probabilities: {}, confidence: 0.9 };
      }
    }
    return new Response(
      JSON.stringify({ model: "stub", answers, usage: { input_tokens: 100, output_tokens: 20 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const corpusOf = (keys: number) =>
  generateSynthetic({ keys, langs: ["de", "uk"], seed: 20250920, defectRate: 0.1 }).corpus;

describe("a failed request is a blind spot, not a clean bill", () => {
  it("reports coverage below 100% and names every key it could not judge", async () => {
    const corpus = corpusOf(60);
    // every tenth key, by its own name: deterministic and independent of lane order
    const doomed = (keyName: string) => Number(keyName.split(".").at(-1)) % 10 === 0;
    const { impl } = stubFetch({ failFor: doomed, failStatus: 400 });
    const client = new JevClient({ apiKey: "x", fetchImpl: impl, concurrency: 4, maxAttempts: 1 });

    const res = await audit(client, corpus, [], lintCorpus(corpus).issues, { register: false });

    expect(res.stats.errors).toBeGreaterThan(0);
    expect(res.unjudged).toHaveLength(res.stats.errors);
    expect(res.judgments.size).toBe(res.stats.requests - res.stats.errors);
    for (const u of res.unjudged) {
      expect(u.stage).toBe("audit");
      expect(u.status).toBe(400);
      expect(res.judgments.has(u.entryId)).toBe(false);
    }

    const cov = coverageOf([res.stats]).get("audit")!;
    expect(cov.attempted).toBe(res.stats.requests);
    expect(cov.answered).toBe(res.stats.requests - res.stats.errors);
    expect(cov.failed).toBe(res.stats.errors);
    expect(completeness(cov)).toBeLessThan(1);
  });

  it("marks the findings on an unjudged key rather than letting them read as judged", async () => {
    const corpus = corpusOf(40);
    const doomed = (keyName: string) => Number(keyName.split(".").at(-1)) % 10 === 0;
    const { impl } = stubFetch({ failFor: doomed, failStatus: 400 });
    const client = new JevClient({ apiKey: "x", fetchImpl: impl, concurrency: 4, maxAttempts: 1 });

    const lint = lintCorpus(corpus);
    const res = await audit(client, corpus, [], lint.issues, { register: false });
    expect(res.unjudged.length).toBeGreaterThan(0);

    const blind = new Set(res.unjudged.map((u) => u.entryId));
    const findings = compose({
      corpus,
      lintIssues: lint.issues,
      judgments: res.judgments,
      glossary: [],
      registerNorms: new Map(),
      unjudged: res.unjudged,
    });

    const onBlindKeys = findings.filter((f) => blind.has(f.entryId));
    expect(onBlindKeys.length).toBeGreaterThan(0);
    for (const f of onBlindKeys) {
      expect(f.judged).toBe(false);
      expect(f.reasons.map((r) => r.rule)).toContain("not-judged");
    }
    for (const f of findings.filter((f) => !blind.has(f.entryId))) {
      expect(f.judged).toBe(true);
      expect(f.reasons.map((r) => r.rule)).not.toContain("not-judged");
    }
  });

  it("is 100% when nothing fails, and says so without qualification", async () => {
    const corpus = corpusOf(30);
    const { impl } = stubFetch();
    const client = new JevClient({ apiKey: "x", fetchImpl: impl, concurrency: 4 });

    const res = await audit(client, corpus, [], lintCorpus(corpus).issues, { register: false });
    expect(res.stats.errors).toBe(0);
    expect(res.unjudged).toEqual([]);
    expect(completeness(totalCoverage([res.stats]))).toBe(1);
  });

  it("counts keys it never asked about as skipped, not as answered", async () => {
    const corpus = corpusOf(40);
    const { impl } = stubFetch();
    const client = new JevClient({ apiKey: "x", fetchImpl: impl, concurrency: 4 });

    const only = new Set(corpus.entries.slice(0, 10).map((e) => e.id));
    const res = await audit(client, corpus, [], lintCorpus(corpus).issues, { register: false, only });

    expect(res.stats.requests).toBeLessThanOrEqual(10);
    expect(res.stats.skipped).toBe(10 - res.stats.requests);
    const cov = totalCoverage([res.stats]);
    expect(cov.attempted + cov.skipped).toBe(10);
  });
});

describe("the client's error paths", () => {
  it("retries a 429 and counts the retry", async () => {
    let seen = 0;
    const impl = (async () => {
      seen++;
      if (seen === 1) return new Response("slow down", { status: 429 });
      return new Response(JSON.stringify({ model: "stub", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new JevClient({ apiKey: "x", fetchImpl: impl, concurrency: 1 });
    let stats!: StageStats;
    stats = await client.run("t", [{ tag: 1, state: {}, questions: {} }], () => {});
    expect(seen).toBe(2);
    expect(stats.errors).toBe(0);
    expect(stats.retries).toBe(1);
  });

  it("gives up on a 400 without retrying, and reports it as an error", async () => {
    let seen = 0;
    const impl = (async () => {
      seen++;
      return new Response("no", { status: 400 });
    }) as unknown as typeof fetch;

    const client = new JevClient({ apiKey: "x", fetchImpl: impl, concurrency: 1 });
    const results: unknown[] = [];
    const stats = await client.run("t", [{ tag: 1, state: {}, questions: {} }], (r) => results.push(r));
    expect(seen).toBe(1);
    expect(stats.errors).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 400 });
  });
});
