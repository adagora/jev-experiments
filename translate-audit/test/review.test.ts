import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Session, type SessionPaths } from "../server/api.ts";
import { createServer } from "../server/index.ts";
import { saveCache } from "../src/cache.ts";
import { saveGlossary, termKey, type GlossaryRecord, type TermStatus } from "../src/glossary/store.ts";
import { DEFAULT_POLICY, loadProfile, type Profile } from "../src/config/profile.ts";
import { JevClient, type Question } from "../src/jev/client.ts";
import type { Corpus, Entry, EntryJudgment } from "../src/types.ts";

/**
 * The review app, pinned.
 *
 * `TESTING.md` §5 lists four things to check by hand, in order of how quietly each one
 * breaks. The first of them — the glossary governing the queue rather than decorating it —
 * broke twice: once when findings were keyed off the saved judgment, and again in stage 9a
 * when a suspended term lost the canonical that made restoring it an undo. Both times a
 * human found it, and both times months late.
 *
 * The expensive-looking part is cheap: a `Session` is a temp directory and a `null` client,
 * and the whole queue re-composes in memory. Only §5.3's *discrimination* needs a live
 * endpoint; the plumbing behind it — that the state reaches the request at all, which is
 * the half that fails silently — is checked here against a stub.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const profile: Profile = { ...loadProfile(), policy: { ...DEFAULT_POLICY } };

const entry = (id: string, source: string, de: string): Entry => ({
  id,
  project: "p",
  keyName: `key.${id}`,
  source,
  description: "",
  context: "",
  tags: [],
  tr: { pl: source, de },
  status: {},
});

const corpus: Corpus = {
  sourceLang: "pl",
  langs: ["pl", "de"],
  entries: [
    entry("k1", "Usuń zamówienie", "Entfernen Sie die Bestellung"),
    entry("k2", "Zapisz zmiany", "Kaufen Sie ein Auto"),
    entry("k3", "Anuluj", "Abbrechen"),
  ],
  origin: "test",
};

const judged = (id: string, meaning: number, adheres: number): [string, EntryJudgment] => [
  id,
  { entryId: id, isUiString: 1, meaning: { de: meaning }, adheres: { de: adheres }, register: {}, ms: 1 },
];

/** `Usuń` is settled on `Löschen`; k1 says `Entfernen`, and the audit agrees it does not adhere. */
const USUN = termKey("usun", "de");

const term = (status: TermStatus, canonical: string | null = "Löschen"): GlossaryRecord => ({
  key: USUN,
  term: "usun",
  display: "Usuń",
  lang: "de",
  canonical,
  status,
  source: "jev",
  confidence: 0.9,
  severity: 2,
  interchangeable: 0.2,
  doNotTranslate: 0,
  covered: 0.9,
  variants: [
    { text: "Löschen", count: 9, examples: ["k9"] },
    { text: "Entfernen", count: 2, examples: ["k1"] },
  ],
  entryIds: ["k1"],
  origin: "duplicate-source",
  guidance: "",
  note: "",
  decidedBy: null,
  decidedAt: null,
  firstSeen: "2026-09-21T10:00:00Z",
});

function fixture(records: GlossaryRecord[] = [term("proposed")]): SessionPaths {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
  dirs.push(dir);
  const paths: SessionPaths = {
    cache: join(dir, "audit.run.json"),
    glossary: join(dir, "audit.glossary.json"),
    decisions: join(dir, "audit.decisions.json"),
  };
  saveCache(paths.cache, {
    corpus,
    lintIssues: [],
    glossary: [],
    judgments: [judged("k1", 0.95, 0.05), judged("k2", 0.02, 0.99), judged("k3", 0.99, 0.99)],
    registerNorms: [],
    stages: [],
    unjudged: [],
    substitutions: [],
  });
  saveGlossary(paths.glossary, records);
  writeFileSync(paths.decisions, JSON.stringify({ version: 1, updatedAt: "", decisions: [] }), "utf8");
  return paths;
}

const rulesIn = (s: Session): string[] => s.rows({ limit: 100 }).rows.flatMap((r) => r.rules);
const idsIn = (s: Session): string[] => s.rows({ limit: 100 }).rows.map((r) => `${r.entryId}/${r.lang}`);

describe("§5.2 — the glossary governs the queue", () => {
  let paths: SessionPaths;
  beforeEach(() => {
    paths = fixture();
  });

  it("raises adherence findings only for terms it may enforce", () => {
    const s = new Session(paths, null, profile);
    expect(rulesIn(s)).toContain("canonical-not-used");
    expect(idsIn(s)).toContain("k1/de");
  });

  it("drops them the moment a term is suspended, and restores them when it is put back", () => {
    const s = new Session(paths, null, profile);
    const before = rulesIn(s).filter((r) => r === "canonical-not-used").length;
    expect(before).toBeGreaterThan(0);

    s.patchTerm(USUN, { status: "context-dependent" }, "ada");
    expect(rulesIn(s)).not.toContain("canonical-not-used");
    expect(idsIn(s)).not.toContain("k1/de");

    // Putting the status back is an undo, not a re-arbitration: the canonical survived
    // being suspended, so the findings come back as they were. (Stage 9a.)
    const back = s.patchTerm(USUN, { status: "approved" }, "ada");
    expect(back?.canonical).toBe("Löschen");
    expect(rulesIn(s).filter((r) => r === "canonical-not-used").length).toBe(before);
  });

  it("enforces a canonical a human typed, against keys nobody arbitrated", () => {
    const s = new Session(fixture([]), null, profile);
    expect(rulesIn(s)).not.toContain("canonical-not-used");

    s.addTerm({ term: "Usuń", lang: "de", canonical: "Löschen", who: "ada" });
    expect(rulesIn(s)).toContain("canonical-not-used");
    expect(s.glossaryRecords.find((r) => r.key === USUN)?.entryIds).toEqual(["k1"]);
  });

  it("does not raise one for a term with no canonical to compare against", () => {
    const s = new Session(fixture([term("proposed", null)]), null, profile);
    expect(rulesIn(s)).not.toContain("canonical-not-used");
  });
});

describe("§5.1 — a decision survives a restart", () => {
  it("comes back with the text and the name against it", () => {
    const paths = fixture();
    const first = new Session(paths, null, profile);
    first.putDecision({
      entryId: "k2",
      lang: "de",
      verdict: "edited",
      text: "Änderungen speichern",
      who: "ada",
    });

    const restarted = new Session(paths, null, profile);
    const row = restarted.rows({ limit: 100 }).rows.find((r) => r.entryId === "k2");
    expect(row).toMatchObject({ verdict: "edited", decidedBy: "ada", decidedText: "Änderungen speichern" });
    // and what it was is kept, so the re-import can say what it changed
    expect(restarted.exportChanges()).toEqual([
      { entryId: "k2", keyName: "key.k2", lang: "de", before: "Kaufen Sie ein Auto", after: "Änderungen speichern" },
    ]);
  });

  it("is written through on every change, not on exit", () => {
    const paths = fixture();
    const s = new Session(paths, null, profile);
    s.putDecision({ entryId: "k1", lang: "de", verdict: "reject", who: "bo" });
    // nothing was closed, stopped or flushed — a second reader sees it already
    expect(new Session(paths, null, profile).stats().decisions.total).toBe(1);

    s.clearDecision("k1", "de");
    expect(new Session(paths, null, profile).stats().decisions.total).toBe(0);
  });
});

describe("§5.4 — decided rows sort last and the queue empties", () => {
  it("moves a row to the back the moment it is decided", () => {
    const s = new Session(fixture(), null, profile);
    expect(idsIn(s)).toEqual(["k2/de", "k1/de"]); // severity 3 before severity 2

    s.putDecision({ entryId: "k2", lang: "de", verdict: "accept", text: "Änderungen speichern", who: "ada" });
    expect(idsIn(s)).toEqual(["k1/de", "k2/de"]);
  });

  it("empties `unreviewed only` as the work proceeds", () => {
    const s = new Session(fixture(), null, profile);
    const undecided = () => s.rows({ undecidedOnly: true, limit: 100 }).total;
    expect(undecided()).toBe(2);

    s.putDecision({ entryId: "k2", lang: "de", verdict: "reject", who: "ada" });
    expect(undecided()).toBe(1);

    s.putDecision({ entryId: "k1", lang: "de", verdict: "accept", text: "Löschen Sie die Bestellung", who: "ada" });
    expect(undecided()).toBe(0);
    expect(s.rows({ limit: 100 }).total).toBe(2); // decided, not gone
  });
});

describe("§5.3 — the live check, minus the endpoint", () => {
  /** Answers everything with 0.9 and keeps what it was sent. */
  function stub() {
    const sent: { state: Record<string, unknown>; questions: Record<string, Question> }[] = [];
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as (typeof sent)[number];
      sent.push(body);
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((name) => [name, { type: "noul", noul: 0.9 }]),
      );
      return new Response(JSON.stringify({ model: "stub", answers, usage: { input_tokens: 9, output_tokens: 3 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { sent, client: new JevClient({ apiKey: "x", fetchImpl: impl, concurrency: 1 }) };
  }

  it("puts the source, the proposed text and the glossary into the request", async () => {
    const { sent, client } = stub();
    const s = new Session(fixture([term("approved")]), client, profile);

    const r = await s.checkEdit({ entryId: "k1", lang: "de", text: "Entfernen Sie die Bestellung" });
    expect(r.meaning).toBe(0.9);
    expect(sent).toHaveLength(1);
    // If any of these is missing, every edit comes back ~0.9 and the check is decorative.
    expect(sent[0].state).toMatchObject({
      source: "Usuń zamówienie",
      proposed: "Entfernen Sie die Bestellung",
      source_language: "Polish",
      glossary: [{ term: "Usuń", canonical: "Löschen" }],
    });
  });

  it("carries a suspended term into no request at all", async () => {
    const { sent, client } = stub();
    const s = new Session(fixture([term("context-dependent")]), client, profile);
    await s.checkEdit({ entryId: "k1", lang: "de", text: "Entfernen Sie die Bestellung" });
    expect(sent[0].state.glossary).toEqual([]);
  });

  it("says so rather than faking an answer when there is no key", async () => {
    const s = new Session(fixture(), null, profile);
    expect(s.meta().live).toBe(false);
    await expect(s.checkEdit({ entryId: "k1", lang: "de", text: "x" })).rejects.toThrow(/TYPESAFE_API_KEY/);
  });
});

describe("the HTTP surface", () => {
  async function serve(paths: SessionPaths) {
    const { server, session } = createServer({ paths, port: 0, profile });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (path: string) => (await fetch(base + path)).json();
    const post = async (path: string, body: unknown) =>
      (await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    return { session, get, post, close: () => new Promise<void>((done) => server.close(() => done())) };
  }

  it("sends `rules` beside `reasons`, so a filter never matches on prose", async () => {
    const s = await serve(fixture());
    try {
      const body = (await s.get("/api/rows?limit=20000")) as {
        rows: { entryId: string; reasons: string[]; rules: string[] }[];
      };
      const row = body.rows.find((r) => r.entryId === "k1")!;
      expect(row.rules).toContain("canonical-not-used");
      expect(row.reasons.length).toBe(row.rules.length);
      // the rendered half is prose, and the id is nowhere in it — which is why the
      // documented check counts `rules` rather than grepping sentences
      expect(row.reasons.join(" ")).toContain("Löschen");
      expect(row.reasons.join(" ")).not.toContain("canonical-not-used");
    } finally {
      await s.close();
    }
  });

  it("re-composes the queue when a term is decided over the wire", async () => {
    const s = await serve(fixture());
    try {
      const count = async () => {
        const body = (await s.get("/api/rows?limit=20000")) as { rows: { rules: string[] }[] };
        return body.rows.filter((r) => r.rules.includes("canonical-not-used")).length;
      };
      expect(await count()).toBe(1);

      await s.post(`/api/glossary/${encodeURIComponent(USUN)}`, { status: "context-dependent", who: "ada" });
      expect(await count()).toBe(0);

      await s.post(`/api/glossary/${encodeURIComponent(USUN)}`, { status: "approved", who: "ada" });
      expect(await count()).toBe(1);
    } finally {
      await s.close();
    }
  });

  it("exports what was decided, and only what changed", async () => {
    const s = await serve(fixture());
    try {
      await s.post("/api/decision", { entryId: "k2", lang: "de", verdict: "edited", text: "Änderungen speichern", who: "ada" });
      await s.post("/api/decision", { entryId: "k1", lang: "de", verdict: "reject", who: "ada" });
      expect(s.session.exportChanges().map((c) => c.entryId)).toEqual(["k2"]);
    } finally {
      await s.close();
    }
  });

  it("checks a string the corpus has never contained, over the wire and for free", async () => {
    const s = await serve(fixture([term("approved")]));
    try {
      const bad = (await s.post("/api/consistency", {
        source: "Usuń zamówienie natychmiast",
        lang: "de",
        text: "Entfernen Sie die Bestellung sofort",
        semantic: false,
      })) as { violations: { used: string; canonical: string; suggested: string }[]; judged: null };
      expect(bad.violations).toHaveLength(1);
      expect(bad.violations[0]).toMatchObject({ used: "Entfernen", canonical: "Löschen" });
      expect(bad.violations[0].suggested).toContain("Löschen");
      expect(bad.judged).toBeNull(); // no key here, and none needed

      const good = (await s.post("/api/consistency", {
        source: "Usuń zamówienie natychmiast",
        lang: "de",
        text: "Löschen Sie die Bestellung sofort",
        semantic: false,
      })) as { violations: unknown[]; glossary: unknown[] };
      expect(good.violations).toEqual([]);
      expect(good.glossary).toHaveLength(1); // the rule is shown even when it is followed

      expect(await s.post("/api/consistency", { lang: "de", text: "x" })).toEqual({
        error: "source and lang are required",
      });
    } finally {
      await s.close();
    }
  });

  it("answers 404 for a route that does not exist rather than the app shell", async () => {
    const s = await serve(fixture());
    try {
      expect(await s.get("/api/nope")).toEqual({ error: "no such route" });
    } finally {
      await s.close();
    }
  });
});
