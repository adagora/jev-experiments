import type { Corpus, Entry, EntryJudgment, GlossaryEntry, Lang, LintIssue, StageStats, Unjudged } from "./types.ts";
import { asChoice, asNoul, type JevClient, type JevRequest } from "./jev/client.ts";
import {
  REGISTER_FORMAL,
  REGISTER_INFORMAL,
  auditQuestions,
  auditState,
  type AuditPlan,
} from "./jev/questions.ts";
import { containsTerm, fold, norm, wordCount } from "./util/text.ts";

const REGISTER_MIN_WORDS = 4;

export type AuditOptions = {
  register: boolean;
  only?: Set<string>;
  guidance?: Map<string, { lang: Lang; guidance: string }[]>;
};

export type AuditResult = {
  judgments: Map<string, EntryJudgment>;
  stats: StageStats;
  planned: number;
  /** Keys the audit asked about and did not get an answer for. */
  unjudged: Unjudged[];
};

export type AuditRequest = JevRequest<{ entry: Entry; plan: AuditPlan }>;

/**
 * Exactly the requests `audit` would send, without sending them.
 *
 * `plan` fingerprints these against the evidence store to say what a run would cost
 * before it costs it — which is what turns an irreversible spend into a proposal.
 */
export function auditRequests(
  corpus: Corpus,
  glossary: GlossaryEntry[],
  lintIssues: LintIssue[],
  opts: AuditOptions,
): { requests: AuditRequest[]; considered: number } {
  const targets = corpus.langs.filter((l) => l !== corpus.sourceLang);

  const lintByEntry = new Map<string, Map<Lang, string[]>>();
  for (const i of lintIssues) {
    let byLang = lintByEntry.get(i.entryId);
    if (!byLang) lintByEntry.set(i.entryId, (byLang = new Map()));
    const list = byLang.get(i.lang);
    const msg = `${i.code}: ${i.detail}`;
    if (list) list.push(msg);
    else byLang.set(i.lang, [msg]);
  }

  const glossaryByTerm = new Map<string, GlossaryEntry[]>();
  for (const g of glossary) {
    if (!g.canonical) continue;
    const list = glossaryByTerm.get(g.term);
    if (list) list.push(g);
    else glossaryByTerm.set(g.term, [g]);
  }
  const terms = [...glossaryByTerm.keys()];

  const entries = opts.only ? corpus.entries.filter((e) => opts.only!.has(e.id)) : corpus.entries;

  const requests: AuditRequest[] = [];
  for (const entry of entries) {
    const folded = fold(entry.source);
    const applicable: GlossaryEntry[] = [];
    for (const t of terms) {
      if (containsTerm(folded, t)) applicable.push(...glossaryByTerm.get(t)!);
    }

    const present = targets.filter((l) => norm(entry.tr[l] ?? "") !== "");
    if (present.length === 0) continue;

    const adherenceLangs = present.filter((l) => applicable.some((g) => g.lang === l));
    const isProse = wordCount(entry.source) >= REGISTER_MIN_WORDS;
    const plan: AuditPlan = {
      meaning: present,
      adherence: adherenceLangs,
      register: opts.register && isProse ? present : [],
    };

    requests.push({
      tag: { entry, plan },
      unit: `key:${entry.id}`,
      state: auditState(
        entry,
        corpus.langs,
        corpus.sourceLang,
        lintByEntry.get(entry.id) ?? new Map(),
        applicable,
        opts.guidance,
      ),
      questions: auditQuestions(plan, corpus.sourceLang),
    });
  }

  return { requests, considered: entries.length };
}

export async function audit(
  client: JevClient,
  corpus: Corpus,
  glossary: GlossaryEntry[],
  lintIssues: LintIssue[],
  opts: AuditOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<AuditResult> {
  const { requests, considered } = auditRequests(corpus, glossary, lintIssues, opts);

  const judgments = new Map<string, EntryJudgment>();
  const unjudged: Unjudged[] = [];
  const stats = await client.run(
    "audit",
    requests,
    (r) => {
      const { entry, plan } = r.tag;
      if ("error" in r) {
        // Recorded rather than dropped: an unjudged key must not read as a clean one.
        unjudged.push({ stage: "audit", entryId: entry.id, error: r.error, status: r.status });
        return;
      }
      const j: EntryJudgment = {
        entryId: entry.id,
        isUiString: asNoul(r.answers.uiString) ?? null,
        meaning: {},
        adheres: {},
        register: {},
        ms: r.ms,
      };
      for (const l of plan.meaning) {
        const v = asNoul(r.answers[`meaning:${l}`]);
        if (v !== null) j.meaning[l] = v;
      }
      for (const l of plan.adherence) {
        const v = asNoul(r.answers[`adheres:${l}`]);
        if (v !== null) j.adheres[l] = v;
      }
      for (const l of plan.register) {
        const a = asChoice(r.answers[`register:${l}`]);
        if (!a) continue;
        const form = a.choice === REGISTER_FORMAL ? "formal" : a.choice === REGISTER_INFORMAL ? "informal" : "none";
        j.register[l] = { form, confidence: a.confidence };
      }
      judgments.set(entry.id, j);
    },
    onProgress,
  );

  stats.skipped = considered - requests.length;
  return { judgments, stats, planned: requests.length, unjudged };
}

export function registerNorm(judgments: Map<string, EntryJudgment>, langs: Lang[]): Map<Lang, { formalShare: number; n: number }> {
  const out = new Map<Lang, { formalShare: number; n: number }>();
  for (const lang of langs) {
    let n = 0;
    let formal = 0;
    for (const j of judgments.values()) {
      const r = j.register[lang];
      if (!r || r.form === "none") continue;
      n++;
      if (r.form === "formal") formal++;
    }
    if (n > 0) out.set(lang, { formalShare: formal / n, n });
  }
  return out;
}
