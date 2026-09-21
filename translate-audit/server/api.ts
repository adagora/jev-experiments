import { performance } from "node:perf_hooks";
import type { Corpus, Entry, EntryJudgment, Finding, GlossaryEntry, Lang } from "../src/types.ts";
import { compose, summarise, totalCoverage } from "../src/compose.ts";
import { DEFAULT_POLICY, loadProfile, type Policy, type Profile } from "../src/config/profile.ts";
import { loadCache, type RunCache } from "../src/cache.ts";
import {
  applyArbitration,
  decide,
  enforceable,
  glossaryStats,
  loadGlossary,
  manualTerm,
  saveGlossary,
  termKey,
  type GlossaryRecord,
  type TermPatch,
} from "../src/glossary/store.ts";
import {
  changes,
  decisionKey,
  decisionStats,
  loadDecisions,
  saveDecisions,
  type DecisionRecord,
  type Verdict,
} from "../src/review/decisions.ts";
import { JevClient, asChoice, asNoul, noul } from "../src/jev/client.ts";
import { arbitrationQuestions, arbitrationState, langName, CONTEXT_DEPENDENT } from "../src/jev/questions.ts";
import { fold, norm } from "../src/util/text.ts";
import { renderReason, type RuleId } from "../src/policy/rules.ts";
import { TermIndex, indexByTerm } from "../src/glossary/match.ts";
import type { TermConflict } from "../src/types.ts";

export type SessionPaths = { cache: string; glossary: string; decisions: string };

export type ReviewRow = Omit<Finding, "reasons"> & {
  /** Rendered for display. `rules` is what to filter or group on. */
  reasons: string[];
  rules: RuleId[];
  verdict: Verdict | null;
  decidedText: string | null;
  decidedBy: string | null;
  siblings: { text: string; count: number }[];
};

export class Session {
  private paths: SessionPaths;
  private profile: Profile;
  private cache: RunCache;
  private corpus: Corpus;
  private entries: Map<string, Entry>;
  private glossary: GlossaryRecord[];
  private decisions: Map<string, DecisionRecord>;
  private judgments: Map<string, EntryJudgment>;
  private findings: Finding[] = [];
  private policy: Policy = DEFAULT_POLICY;
  private client: JevClient | null;
  private siblingIndex = new Map<string, { text: string; count: number }[]>();

  constructor(paths: SessionPaths, client: JevClient | null, profile: Profile = loadProfile()) {
    this.paths = paths;
    this.profile = profile;
    this.policy = profile.policy;
    this.cache = loadCache(paths.cache);
    this.corpus = this.cache.corpus;
    this.entries = new Map(this.corpus.entries.map((e) => [e.id, e]));
    this.glossary = loadGlossary(paths.glossary);
    this.decisions = loadDecisions(paths.decisions);
    this.judgments = new Map(this.cache.judgments);
    this.client = client;

    if (this.glossary.length === 0 && this.cache.glossary.length > 0) {
      this.glossary = applyArbitration(
        this.cache.glossary.map((g) => ({
          key: termKey(g.term, g.lang),
          term: g.term,
          display: this.displayFor(g.term),
          lang: g.lang,
          canonical: null,
          status: "proposed" as const,
          source: "jev" as const,
          confidence: 0,
          severity: null,
          doNotTranslate: null,
          covered: null,
          variants: g.variants,
          entryIds: g.entryIds,
          guidance: "",
          note: "",
          decidedBy: null,
          decidedAt: null,
          firstSeen: new Date().toISOString(),
        })),
        this.cache.glossary,
      );
      saveGlossary(this.paths.glossary, this.glossary);
    }

    this.buildSiblings();
    this.recompose();
  }

  private displayFor(term: string): string {
    for (const e of this.corpus.entries) if (fold(e.source) === term) return norm(e.source);
    return term;
  }

  private buildSiblings(): void {
    const bySource = new Map<string, Entry[]>();
    for (const e of this.corpus.entries) {
      const k = fold(e.source);
      const list = bySource.get(k);
      if (list) list.push(e);
      else bySource.set(k, [e]);
    }
    for (const [src, group] of bySource) {
      if (group.length < 2) continue;
      for (const lang of this.corpus.langs) {
        const counts = new Map<string, number>();
        for (const e of group) {
          const v = norm(e.tr[lang] ?? "");
          if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        if (counts.size > 1) {
          this.siblingIndex.set(
            `${src}\u0000${lang}`,
            [...counts.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count),
          );
        }
      }
    }
  }

  recompose(): void {
    this.findings = compose({
      corpus: this.corpus,
      lintIssues: this.cache.lintIssues,
      judgments: this.judgments,
      glossary: this.currentGlossary(),
      registerNorms: new Map(this.cache.registerNorms),
      policy: this.policy,
      unjudged: this.cache.unjudged,
    });

    const subs = new Map(this.cache.substitutions.map((x) => [decisionKey(x.entryId, x.lang), x]));
    for (const f of this.findings) {
      const hit = subs.get(decisionKey(f.entryId, f.lang));
      if (!hit) continue;
      f.suggested = hit.suggested;
      f.substitutionOk = hit.check;
      if (hit.note && !f.reasons.some((r) => r.rule === hit.note!.rule)) f.reasons.push(hit.note);
    }
    for (const f of this.findings) {
      if (f.action !== "auto-fix" || f.suggested) continue;
      f.action = "needs human";
    }
  }

  private currentGlossary(): GlossaryEntry[] {
    return this.glossary.length ? enforceable(this.glossary) : this.cache.glossary;
  }

  meta() {
    return {
      origin: this.corpus.origin,
      sourceLang: this.corpus.sourceLang,
      langs: this.corpus.langs.filter((l) => l !== this.corpus.sourceLang),
      keys: this.corpus.entries.length,
      savedAt: this.cache.savedAt,
      stages: this.cache.stages,
      policy: this.policy,
      live: this.client !== null,
    };
  }

  stats() {
    return {
      coverage: totalCoverage(this.cache.stages),
      summary: summarise(this.findings, this.corpus),
      glossary: glossaryStats(this.glossary),
      decisions: decisionStats(this.decisions),
    };
  }

  rows(opts: {
    lang?: string;
    category?: string;
    minSeverity?: number;
    project?: string;
    undecidedOnly?: boolean;
    q?: string;
    offset?: number;
    limit?: number;
  }): { total: number; rows: ReviewRow[] } {
    const q = opts.q?.trim().toLowerCase();
    let list = this.findings.filter((f) => {
      if (opts.lang && f.lang !== opts.lang) return false;
      if (opts.category && f.category !== opts.category) return false;
      if (opts.project && f.project !== opts.project) return false;
      if (opts.minSeverity !== undefined && f.severity < opts.minSeverity) return false;
      if (opts.undecidedOnly && this.decisions.has(decisionKey(f.entryId, f.lang))) return false;
      if (q && !(f.source.toLowerCase().includes(q) || f.current.toLowerCase().includes(q) || f.keyName.toLowerCase().includes(q))) {
        return false;
      }
      return true;
    });

    list = list.slice().sort((a, b) => {
      const da = this.decisions.has(decisionKey(a.entryId, a.lang)) ? 1 : 0;
      const db = this.decisions.has(decisionKey(b.entryId, b.lang)) ? 1 : 0;
      return da - db || b.severity - a.severity || b.confidence - a.confidence;
    });

    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 200;
    const rows = list.slice(offset, offset + limit).map((f) => this.toRow(f));
    return { total: list.length, rows };
  }

  private toRow(f: Finding): ReviewRow {
    const d = this.decisions.get(decisionKey(f.entryId, f.lang));
    const e = this.entries.get(f.entryId);
    return {
      ...f,
      reasons: f.reasons.map(renderReason),
      rules: f.reasons.map((r) => r.rule),
      verdict: d?.verdict ?? null,
      decidedText: d?.text ?? null,
      decidedBy: d?.who ?? null,
      siblings: e ? (this.siblingIndex.get(`${fold(e.source)}\u0000${f.lang}`) ?? []) : [],
    };
  }

  entry(entryId: string) {
    const e = this.entries.get(entryId);
    if (!e) return null;
    const judgment = this.judgments.get(entryId);
    return {
      id: e.id,
      project: e.project,
      keyName: e.keyName,
      source: norm(e.source),
      description: e.description,
      context: e.context,
      translations: this.corpus.langs
        .filter((l) => l !== this.corpus.sourceLang)
        .map((lang) => ({
          lang,
          langName: langName(lang),
          value: norm(e.tr[lang] ?? ""),
          meaning: judgment?.meaning[lang] ?? null,
          adheres: judgment?.adheres[lang] ?? null,
          register: judgment?.register[lang] ?? null,
          decided: this.decisions.get(decisionKey(e.id, lang))?.text ?? null,
        })),
      isUiString: judgment?.isUiString ?? null,
    };
  }

  glossaryRows(opts: { lang?: string; status?: string; q?: string; offset?: number; limit?: number }) {
    const q = opts.q?.trim().toLowerCase();
    let list = this.glossary.filter((r) => {
      if (opts.lang && r.lang !== opts.lang) return false;
      if (opts.status && r.status !== opts.status) return false;
      if (q && !(r.display.toLowerCase().includes(q) || (r.canonical ?? "").toLowerCase().includes(q))) return false;
      return true;
    });
    list = list.slice().sort((a, b) => {
      const da = a.decidedAt ? 1 : 0;
      const db = b.decidedAt ? 1 : 0;
      return da - db || (b.severity || 0) - (a.severity || 0) || b.entryIds.length - a.entryIds.length;
    });
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 200;
    return { total: list.length, rows: list.slice(offset, offset + limit) };
  }

  putDecision(input: {
    entryId: string;
    lang: Lang;
    verdict: Verdict;
    text?: string;
    who: string;
    note?: string;
    check?: DecisionRecord["check"];
  }): DecisionRecord | null {
    const f = this.findings.find((x) => x.entryId === input.entryId && x.lang === input.lang);
    const e = this.entries.get(input.entryId);
    if (!e) return null;
    const was = e.tr[input.lang] ?? "";
    const text =
      input.verdict === "accept"
        ? (input.text ?? f?.suggested ?? was)
        : input.verdict === "edited"
          ? (input.text ?? was)
          : was;

    const rec: DecisionRecord = {
      key: decisionKey(input.entryId, input.lang),
      entryId: input.entryId,
      lang: input.lang,
      verdict: input.verdict,
      text: norm(text),
      was,
      who: input.who,
      at: new Date().toISOString(),
      check: input.check ?? null,
      note: input.note ?? "",
    };
    this.decisions.set(rec.key, rec);
    saveDecisions(this.paths.decisions, this.decisions);
    return rec;
  }

  clearDecision(entryId: string, lang: Lang): void {
    this.decisions.delete(decisionKey(entryId, lang));
    saveDecisions(this.paths.decisions, this.decisions);
  }

  patchTerm(key: string, patch: TermPatch, who: string): GlossaryRecord | null {
    const i = this.glossary.findIndex((r) => r.key === key);
    if (i < 0) return null;
    this.glossary[i] = decide(this.glossary[i], patch, who);
    saveGlossary(this.paths.glossary, this.glossary);
    this.recompose();
    return this.glossary[i];
  }

  addTerm(input: { term: string; lang: Lang; canonical: string; guidance?: string; who: string }): GlossaryRecord {
    const rec = manualTerm(input.term, input.lang, input.canonical, input.who, input.guidance ?? "");
    const existing = this.glossary.findIndex((r) => r.key === rec.key);
    const index = new TermIndex<null>([[rec.term, null]]);
    rec.entryIds = this.corpus.entries.filter((e) => index.matches(e.source).length > 0).map((e) => e.id);
    if (existing >= 0) this.glossary[existing] = { ...this.glossary[existing], ...rec };
    else this.glossary.push(rec);
    saveGlossary(this.paths.glossary, this.glossary);
    this.recompose();
    return rec;
  }

  setPolicy(patch: Partial<Policy>): Policy {
    this.policy = { ...this.policy, ...patch };
    this.recompose();
    return this.policy;
  }

  async checkEdit(input: { entryId: string; lang: Lang; text: string }) {
    if (!this.client) throw new Error("no TYPESAFE_API_KEY — live checks are disabled");
    const e = this.entries.get(input.entryId);
    if (!e) throw new Error("no such key");
    const name = langName(input.lang);
    const t0 = performance.now();
    const { response } = await this.client.one(
      {
        source_language: langName(this.corpus.sourceLang),
        source: norm(e.source),
        developer_note: norm(e.description || e.context),
        proposed: norm(input.text),
        glossary: this.glossaryFor(e, input.lang),
      },
      {
        meaning: noul(
          `Does \`proposed\` state the same thing as \`source\`, including every negation, number, condition and obligation it contains?`,
        ),
        grammatical: noul(`Is \`proposed\` well-formed, natural ${name} that a native speaker would write?`),
        glossaryOk: noul(
          `Does \`proposed\` use the canonical rendering given in \`glossary\` for every term it contains, allowing for normal inflection?`,
        ),
      },
    );
    return {
      meaning: asNoul(response.answers.meaning),
      grammatical: asNoul(response.answers.grammatical),
      glossaryOk: asNoul(response.answers.glossaryOk),
      ms: Math.round(performance.now() - t0),
    };
  }

  private glossaryFor(e: Entry, lang: Lang): { term: string; canonical: string; guidance?: string }[] {
    const index = indexByTerm(
      this.glossary.filter((r) => r.lang === lang && r.canonical),
      (r) => r.term,
    );
    return index
      .matches(e.source)
      .flatMap((m) => m.value)
      .map((r) => ({ term: r.display, canonical: r.canonical!, ...(r.guidance ? { guidance: r.guidance } : {}) }));
  }

  async arbitrateTerm(key: string) {
    if (!this.client) throw new Error("no TYPESAFE_API_KEY — live checks are disabled");
    const rec = this.glossary.find((r) => r.key === key);
    if (!rec) throw new Error("no such term");
    const conflict: TermConflict = {
      term: rec.term,
      lang: rec.lang,
      variants: rec.variants,
      entryIds: rec.entryIds,
      origin: "duplicate-source",
      trivial: false,
    };
    const state = arbitrationState(conflict, this.entries, this.corpus.sourceLang, this.profile.domain);
    const t0 = performance.now();
    const { response } = await this.client.one(state, arbitrationQuestions(conflict));
    const pick = asChoice(response.answers.canonical);
    return {
      canonical: pick && pick.choice !== CONTEXT_DEPENDENT ? pick.choice : null,
      contextDependent: pick?.choice === CONTEXT_DEPENDENT,
      confidence: pick?.confidence ?? 0,
      probabilities: pick?.probabilities ?? {},
      doNotTranslate: asNoul(response.answers.doNotTranslate),
      ms: Math.round(performance.now() - t0),
    };
  }

  exportChanges() {
    return changes(this.decisions.values()).map((d) => ({
      entryId: d.entryId,
      keyName: this.entries.get(d.entryId)?.keyName ?? "",
      lang: d.lang,
      before: d.was,
      after: d.text,
    }));
  }

  get glossaryRecords(): GlossaryRecord[] {
    return this.glossary;
  }
}
