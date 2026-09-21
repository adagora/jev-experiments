import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../server/api.ts";
import { saveCache } from "../src/cache.ts";
import { saveGlossary, type GlossaryRecord, type TermStatus } from "../src/glossary/store.ts";
import { termKey } from "../src/glossary/store.ts";
import type { Corpus, Entry } from "../src/types.ts";
import { JevClient } from "../src/jev/client.ts";

/**
 * Consistency at the moment a string is written, rather than in the audit that follows.
 *
 * These run with no client at all, which is the point: whether a translation uses the term
 * the glossary settled on is a fact about the text (L1), so it is established by matching.
 * A translator gets the answer without a key, without a request and without an audit having
 * ever looked at the key they are working on.
 */
const dir = mkdtempSync(join(tmpdir(), "consistency-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (id: string, source: string): Entry => ({
  id, project: "p", keyName: id, source, description: "", context: "", tags: [], tr: {}, status: {},
});

const corpus: Corpus = {
  sourceLang: "pl",
  langs: ["pl", "de"],
  entries: [entry("k1", "Usuń zamówienie")],
  origin: "t",
};

const term = (status: TermStatus, canonical: string | null = "Löschen"): GlossaryRecord => ({
  key: termKey("usun", "de"),
  term: "usun",
  display: "Usuń",
  lang: "de",
  canonical,
  status,
  source: "human",
  confidence: 1,
  severity: 2,
  interchangeable: null,
  doNotTranslate: null,
  covered: null,
  variants: [
    { text: "Löschen", count: 9, examples: [] },
    { text: "Entfernen", count: 2, examples: [] },
  ],
  entryIds: ["k1"],
  origin: "duplicate-source",
  guidance: "",
  note: "",
  decidedBy: "ada",
  decidedAt: "2026-09-21T10:00:00Z",
  firstSeen: "2026-09-21T10:00:00Z",
});

function session(records: GlossaryRecord[], client: JevClient | null = null): Session {
  const paths = {
    cache: join(dir, "r.run.json"),
    glossary: join(dir, "g.json"),
    decisions: join(dir, "d.json"),
  };
  saveCache(paths.cache, {
    corpus, lintIssues: [], glossary: [], judgments: [],
    registerNorms: [], stages: [], unjudged: [], substitutions: [],
  });
  saveGlossary(paths.glossary, records);
  writeFileSync(paths.decisions, JSON.stringify({ version: 1, updatedAt: "", decisions: [] }), "utf8");
  return new Session(paths, client);
}

/** A client that answers anything, and counts how often it was asked. */
function stub() {
  const calls: unknown[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state: unknown; questions: Record<string, unknown> };
    calls.push(body.state);
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((name) => [name, { type: "noul", noul: 0.42 }]),
    );
    return new Response(JSON.stringify({ model: "stub", answers, usage: { input_tokens: 5, output_tokens: 2 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, client: new JevClient({ apiKey: "x", fetchImpl: impl, concurrency: 1 }) };
}

describe("checking a string as it is written", () => {
  it("catches a rejected rendering in a key the corpus has never contained", async () => {
    const r = await session([term("approved")]).checkText({
      source: "Usuń zamówienie natychmiast",
      lang: "de",
      text: "Entfernen Sie die Bestellung sofort",
    });

    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ used: "Entfernen", canonical: "Löschen" });
    expect(r.violations[0].suggested).toContain("Löschen");
  });

  it("says nothing when the settled term was used", async () => {
    const r = await session([term("approved")]).checkText({
      source: "Usuń zamówienie natychmiast",
      lang: "de",
      text: "Löschen Sie die Bestellung sofort",
    });
    expect(r.violations).toEqual([]);
    expect(r.glossary.map((g) => g.canonical)).toEqual(["Löschen"]);
  });

  it("costs nothing and needs no key — the glossary half is a fact, not a judgment", async () => {
    const r = await session([term("approved")]).checkText({
      source: "Usuń zamówienie",
      lang: "de",
      text: "Entfernen",
    });
    expect(r.judged).toBeNull();
    expect(r.violations).toHaveLength(1);
  });

  it("enforces nothing for a term a human suspended", async () => {
    for (const status of ["context-dependent", "rejected"] as const) {
      const r = await session([term(status)]).checkText({
        source: "Usuń zamówienie",
        lang: "de",
        text: "Entfernen",
      });
      expect(r.glossary).toEqual([]);
      expect(r.violations).toEqual([]);
    }
  });

  it("asks nothing while a translator types, and answers anyway", async () => {
    // What an editor calls on every keystroke. The glossary answer is a fact about the
    // text, so it comes back with no request made — which is what makes the panel free
    // for a translator who is right.
    const { calls, client } = stub();
    const r = await session([term("approved")], client).checkText({
      source: "Usuń zamówienie",
      lang: "de",
      text: "Entfernen Sie es",
      semantic: false,
    });
    expect(calls).toEqual([]);
    expect(r.judged).toBeNull();
    expect(r.violations).toHaveLength(1);
    expect(r.glossary).toEqual([{ term: "Usuń", canonical: "Löschen" }]);
  });

  it("asks once when the meaning is what is being asked about", async () => {
    const { calls, client } = stub();
    const r = await session([term("approved")], client).checkText({
      source: "Usuń zamówienie",
      lang: "de",
      text: "Entfernen Sie es",
    });
    expect(calls).toHaveLength(1);
    expect(r.judged).toEqual({ meaning: 0.42, grammatical: 0.42, glossaryOk: 0.42 });
    // and the request carried what it is judging, glossary included
    expect(calls[0]).toMatchObject({
      source: "Usuń zamówienie",
      proposed: "Entfernen Sie es",
      glossary: [{ term: "Usuń", canonical: "Löschen" }],
    });
  });

  it("holds its tongue about a language the glossary has not settled", async () => {
    const r = await session([term("approved")]).checkText({
      source: "Usuń zamówienie",
      lang: "fr",
      text: "Entfernen",
    });
    expect(r.glossary).toEqual([]);
  });
});
