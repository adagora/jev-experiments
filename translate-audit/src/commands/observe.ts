import { readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Corpus, Finding, Lang, StageStats } from "../types.ts";
import type { Profile } from "../config/profile.ts";
import { compose, totalCoverage } from "../compose.ts";
import { renderReason, type Reason } from "../policy/rules.ts";
import { loadCache, type RunCache } from "../cache.ts";
import { loadGlossary } from "../glossary/store.ts";
import { loadDecisions } from "../review/decisions.ts";
import { EvidenceStore, fingerprint } from "../evidence/store.ts";
import { auditRequests } from "../audit.ts";
import { arbitrationRequests } from "../arbitrate.ts";
import { mineGlossary } from "../mine.ts";
import { lintCorpus } from "../lint.ts";
import { langName, questionsFingerprint } from "../jev/questions.ts";
import { norm } from "../util/text.ts";
import type { Table } from "../report/envelope.ts";

/**
 * Observations: free, write nothing, idempotent.
 *
 * Every action has one of these in front of it, so the only way to find out what
 * something costs is never to pay for it.
 */

// ---------------------------------------------------------------- status

export type Artifact = {
  kind: "run" | "glossary" | "decisions" | "evidence" | "workbook";
  path: string;
  modified: string;
  detail: string;
};

const KINDS: [RegExp, Artifact["kind"]][] = [
  [/\.run\.json$/, "run"],
  [/\.glossary\.json$/, "glossary"],
  [/\.decisions\.json$/, "decisions"],
  [/\.evidence\.jsonl$/, "evidence"],
  [/\.xlsx$/, "workbook"],
];

export function status(dir = process.cwd()): { artifacts: Artifact[]; warnings: { code: string; detail: string }[] } {
  const artifacts: Artifact[] = [];
  const warnings: { code: string; detail: string }[] = [];

  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith("~$")) continue;
    const kind = KINDS.find(([re]) => re.test(name))?.[1];
    if (!kind) continue;
    const path = resolve(dir, name);
    const modified = statSync(path).mtime.toISOString().slice(0, 19).replace("T", " ");
    artifacts.push({ kind, path: name, modified, detail: describe(kind, path, warnings) });
  }

  // Sibling files share a base name. One that is older than the run it belongs to was
  // written against different judgments.
  const byBase = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    const base = a.path.replace(/\.(run\.json|glossary\.json|decisions\.json|evidence\.jsonl|xlsx)$/, "");
    const list = byBase.get(base);
    if (list) list.push(a);
    else byBase.set(base, [a]);
  }
  for (const [base, group] of byBase) {
    const run = group.find((a) => a.kind === "run");
    const book = group.find((a) => a.kind === "workbook");
    if (run && book && book.modified < run.modified) {
      warnings.push({
        code: "stale-workbook",
        detail: `${book.path} is older than ${run.path} — re-render it with "translate-audit report ${base}.run.json"`,
      });
    }
  }

  return { artifacts, warnings };
}

function describe(kind: Artifact["kind"], path: string, warnings: { code: string; detail: string }[]): string {
  try {
    if (kind === "run") {
      const cache = loadCache(path);
      const cov = totalCoverage(cache.stages);
      const prov = cache.provenance;
      if (prov && prov.questions !== questionsFingerprint()) {
        warnings.push({
          code: "questions-changed",
          detail: `${basename(path)} was asked by questions ${prov.questions}; this build asks ${questionsFingerprint()}`,
        });
      }
      return (
        `${cache.corpus.entries.length} keys · ${cache.judgments.length} judgments · ` +
        `coverage ${cov.answered}/${cov.attempted}` +
        (prov ? ` · questions ${prov.questions} · ${prov.model}` : " · no provenance")
      );
    }
    if (kind === "glossary") {
      const terms = loadGlossary(path);
      const decided = terms.filter((t) => t.decidedAt).length;
      return `${terms.length} terms · ${decided} decided by a human`;
    }
    if (kind === "decisions") {
      const d = loadDecisions(path);
      return `${d.size} row decisions`;
    }
    if (kind === "evidence") {
      const store = EvidenceStore.open(path);
      return `${store.size} judgments already bought${store.damaged ? ` · ${store.damaged} unreadable lines` : ""}`;
    }
    return "";
  } catch (e) {
    warnings.push({ code: "unreadable", detail: `${basename(path)}: ${e instanceof Error ? e.message : String(e)}` });
    return "unreadable";
  }
}

// ---------------------------------------------------------------- plan

export type StagePlan = {
  stage: string;
  units: number;
  cached: number;
  toAsk: number;
  estInputTokens: number;
  estOutputTokens: number;
  estUsd: number;
};

/** Per-request token usage, learned from evidence already bought, or assumed. */
function usageModel(store: EvidenceStore | null, stage: string): { input: number; output: number; learned: boolean } {
  const DEFAULTS: Record<string, { input: number; output: number }> = {
    arbitrate: { input: 950, output: 145 },
    audit: { input: 2060, output: 375 },
    substitute: { input: 525, output: 60 },
  };
  if (store) {
    let n = 0;
    let input = 0;
    let output = 0;
    for (const rec of store.records()) {
      if (rec.stage !== stage) continue;
      n++;
      input += rec.usage.input_tokens;
      output += rec.usage.output_tokens;
    }
    if (n >= 20) return { input: input / n, output: output / n, learned: true };
  }
  return { ...(DEFAULTS[stage] ?? { input: 1000, output: 200 }), learned: false };
}

export type PlanResult = {
  stages: StagePlan[];
  totalToAsk: number;
  totalCached: number;
  estUsd: number;
  learned: boolean;
  unpredictable: string[];
};

export function planRun(opts: {
  corpus: Corpus;
  profile: Profile;
  store: EvidenceStore | null;
  maxTerms?: number;
  onlyFlagged?: boolean;
  register?: boolean;
  fix?: boolean;
}): PlanResult {
  const { corpus, profile, store } = opts;
  const lint = lintCorpus(corpus);
  const mined = mineGlossary(corpus);
  const conflicts = opts.maxTerms && opts.maxTerms > 0 ? mined.conflicts.slice(0, opts.maxTerms) : mined.conflicts;
  const entries = new Map(corpus.entries.map((e) => [e.id, e]));

  const stages: StagePlan[] = [];
  let learnedAll = true;

  const measure = (stage: string, reqs: { state: unknown; questions: Record<string, unknown> }[]): StagePlan => {
    const model = usageModel(store, stage);
    learnedAll = learnedAll && model.learned;
    let cached = 0;
    for (const r of reqs) {
      if (store?.has(fingerprint(profile.model, r.state, r.questions as never))) cached++;
    }
    const toAsk = reqs.length - cached;
    const estInputTokens = Math.round(toAsk * model.input);
    const estOutputTokens = Math.round(toAsk * model.output);
    return {
      stage,
      units: reqs.length,
      cached,
      toAsk,
      estInputTokens,
      estOutputTokens,
      estUsd:
        (estInputTokens / 1e6) * profile.pricing.inputPerM + (estOutputTokens / 1e6) * profile.pricing.outputPerM,
    };
  };

  stages.push(measure("arbitrate", arbitrationRequests(conflicts, entries, corpus.sourceLang, profile.domain)));

  // The audit's glossary is whatever arbitration produces, which is not known yet. The
  // enforceable terms only add an `adheres` question to keys that contain them, so the
  // request count is exact and the token estimate is a floor.
  const { requests } = auditRequests(corpus, [], lint.issues, {
    register: opts.register ?? true,
    only: opts.onlyFlagged
      ? new Set([...lint.hardByEntry.keys(), ...mined.resolved.flatMap((g) => g.entryIds)])
      : undefined,
  });
  stages.push(measure("audit", requests));

  const unpredictable: string[] = [];
  if (opts.fix !== false) {
    unpredictable.push(
      "substitute — one request per proposed fix, and which keys get a proposal is not known " +
        "until the audit has answered. On the production corpus it was ~15% of the audit's requests.",
    );
  }

  return {
    stages,
    totalToAsk: stages.reduce((n, s) => n + s.toAsk, 0),
    totalCached: stages.reduce((n, s) => n + s.cached, 0),
    estUsd: stages.reduce((n, s) => n + s.estUsd, 0),
    learned: learnedAll,
    unpredictable,
  };
}

export const planTable = (plan: PlanResult): Table => ({
  title: "what a run would ask",
  columns: ["stage", "units", "already bought", "to ask", "est. input", "est. output", "est. cost"],
  rows: plan.stages.map((s) => [
    s.stage,
    s.units,
    s.cached,
    s.toAsk,
    s.estInputTokens,
    s.estOutputTokens,
    `$${s.estUsd.toFixed(2)}`,
  ]),
  note: plan.learned
    ? "token estimates are the mean of what this evidence store actually paid"
    : "token estimates are defaults — they become measurements once this store has 20+ records per stage",
});

// ---------------------------------------------------------------- inspect

export type Inspection = {
  found: boolean;
  entry?: Record<string, unknown>;
  translations?: Record<string, unknown>[];
  lint?: { lang: Lang; code: string; detail: string }[];
  findings?: { lang: Lang; severity: number; action: string; judged: boolean; reasons: string[] }[];
  terms?: Record<string, unknown>[];
};

export function inspect(cache: RunCache, findings: Finding[], query: string): Inspection {
  const q = query.trim().toLowerCase();
  const entry =
    cache.corpus.entries.find((e) => e.id === query) ??
    cache.corpus.entries.find((e) => e.keyName === query) ??
    cache.corpus.entries.find((e) => e.keyName.toLowerCase().includes(q) || norm(e.source).toLowerCase() === q);
  if (!entry) return { found: false };

  const judgment = new Map(cache.judgments).get(entry.id);
  const targets = cache.corpus.langs.filter((l) => l !== cache.corpus.sourceLang);

  return {
    found: true,
    entry: {
      id: entry.id,
      project: entry.project,
      keyName: entry.keyName,
      source: norm(entry.source),
      note: norm(entry.description || entry.context) || undefined,
      isUiString: judgment?.isUiString ?? undefined,
    },
    translations: targets.map((lang) => ({
      lang,
      language: langName(lang),
      text: norm(entry.tr[lang] ?? ""),
      meaning: judgment?.meaning[lang] ?? null,
      adheres: judgment?.adheres[lang] ?? null,
      register: judgment?.register[lang]?.form ?? null,
    })),
    lint: cache.lintIssues.filter((i) => i.entryId === entry.id).map((i) => ({ lang: i.lang, code: i.code, detail: i.detail })),
    findings: findings
      .filter((f) => f.entryId === entry.id)
      .map((f) => ({
        lang: f.lang,
        severity: f.severity,
        action: f.action,
        judged: f.judged,
        reasons: f.reasons.map(renderReason),
      })),
    terms: cache.glossary
      .filter((g) => entry.source.toLowerCase().includes(g.term))
      .map((g) => ({ term: g.term, lang: g.lang, canonical: g.canonical, confidence: g.confidence })),
  };
}

// ---------------------------------------------------------------- explain

export type Derivation = {
  rule: string;
  evidence: string;
  compared: string;
  contributed: string;
  flipsAt?: string;
};

/**
 * Why this row is here, rule by rule: what evidence it read, which threshold it compared
 * against, what that contributed, and the value that would change the answer.
 */
export function explain(f: Finding, profile: Profile): Derivation[] {
  const p = profile.policy;
  const out: Derivation[] = [];
  for (const r of f.reasons) out.push(derive(r, p));
  return out;
}

function derive(r: Reason, p: Profile["policy"]): Derivation {
  switch (r.rule) {
    case "meaning-not-preserved":
      return {
        rule: r.rule,
        evidence: `meaning p=${r.p.toFixed(2)}`,
        compared: `< meaningBad ${r.threshold}`,
        contributed: "severity 3, category meaning, action needs human",
        flipsAt: `meaningBad <= ${r.p.toFixed(2)} would make this "meaning uncertain" instead`,
      };
    case "meaning-uncertain":
      return {
        rule: r.rule,
        evidence: `meaning p=${r.p.toFixed(2)}`,
        compared: `< meaningDoubtful ${r.threshold}`,
        contributed: "severity 1, category meaning",
        flipsAt: `meaningDoubtful <= ${r.p.toFixed(2)} would drop this finding entirely`,
      };
    case "canonical-not-used":
      return {
        rule: r.rule,
        evidence: `adheres p=${r.p.toFixed(2)} for ${r.terms.map((t) => `"${t.term}"→"${t.canonical}"`).join(", ") || "no named term"}`,
        compared: `< adherenceBad ${r.threshold}`,
        contributed: "severity 1–2 from the term's own severity, category consistency, action auto-fix",
        flipsAt: `adherenceBad <= ${r.p.toFixed(2)}, or marking the term context-dependent, removes it`,
      };
    case "register-drift":
      return {
        rule: r.rule,
        evidence: `this string is ${r.observed} at confidence ${r.confidence.toFixed(2)}; the house norm is ${r.house} at ${Math.round(r.share * 100)}%`,
        compared: `house share >= registerMinDominance ${p.registerMinDominance} and confidence >= registerMinConfidence ${p.registerMinConfidence}`,
        contributed: "severity 1, category style",
        flipsAt: `registerMinDominance > ${r.share.toFixed(2)} would stop judging this language's register at all`,
      };
    case "not-user-facing":
      return {
        rule: r.rule,
        evidence: `isUiString p=${r.p.toFixed(2)}`,
        compared: `< uiStringMin ${r.threshold}`,
        contributed: "semantic checks suppressed, severity capped at 1",
        flipsAt: `uiStringMin <= ${r.p.toFixed(2)} would let the semantic checks run here`,
      };
    case "not-judged":
      return {
        rule: r.rule,
        evidence: `the ${r.stage} request for this key did not come back`,
        compared: "—",
        contributed: "only the exact checks ran; nothing here rules out a meaning defect",
        flipsAt: "re-run: the evidence store will ask only the requests that are still missing",
      };
    case "lint":
      return {
        rule: `${r.rule}/${r.code}`,
        evidence: r.detail,
        compared: "an exact check — no model was involved",
        contributed:
          r.code === "placeholder-mismatch" || r.code === "tag-mismatch"
            ? "severity 3, category integrity, action needs human"
            : "severity 1, category style",
      };
    case "no-translation":
      return { rule: r.rule, evidence: "the target is empty", compared: "an exact check", contributed: "severity 2, category completeness" };
    case "untranslated-copy":
      return {
        rule: r.rule,
        evidence: `byte-identical to the ${r.sourceLang} source`,
        compared: "an exact check",
        contributed: "severity 2, category completeness",
      };
    case "duplicate-source-divergent":
      return {
        rule: r.rule,
        evidence: r.detail,
        compared: "an exact check — this rendering is not the group's majority",
        contributed: "severity 1, category consistency",
      };
    case "spacing-variant":
      return { rule: r.rule, evidence: r.detail, compared: "an exact check", contributed: "severity 0, category consistency" };
    case "substitution-verified":
      return {
        rule: r.rule,
        evidence: `grammar ${r.grammatical.toFixed(2)}, meaning ${r.preserved.toFixed(2)}, better ${r.improved.toFixed(2)}`,
        compared: "all three gates cleared",
        contributed: "action auto-fix, with the edited string in Suggested",
      };
    case "substitution-rejected":
      return {
        rule: r.rule,
        evidence: `grammar ${r.grammatical.toFixed(2)}, meaning ${r.preserved.toFixed(2)}, better ${r.improved.toFixed(2)}`,
        compared: `gates ${r.gates.grammatical} / ${r.gates.preserved} / ${r.gates.improved}`,
        contributed: "action needs human — the edit is offered but not endorsed",
      };
    case "substitution-unverified":
      return {
        rule: r.rule,
        evidence: `"${r.from}" → "${r.to}" was proposed`,
        compared: "the verification request did not come back",
        contributed: "action needs human",
      };
    case "legacy":
      return { rule: r.rule, evidence: r.text, compared: "—", contributed: "saved before reasons were structured" };
  }
}

export const derivationTable = (rows: Derivation[]): Table => ({
  title: "derivation",
  columns: ["rule", "evidence", "compared against", "contributed"],
  rows: rows.map((d) => [d.rule, d.evidence, d.compared, d.contributed]),
});

// ---------------------------------------------------------------- diff

export type RunDiff = {
  left: string;
  right: string;
  counts: Record<string, number | string>;
  byRule: [string, number][];
  bySeverity: [string, number][];
};

const cellKey = (f: Finding): string => `${f.entryId}\u0000${f.lang}`;

export function diffRuns(leftPath: string, rightPath: string, profile: Profile): RunDiff {
  const load = (path: string) => {
    const cache = loadCache(path);
    const findings = compose({
      corpus: cache.corpus,
      lintIssues: cache.lintIssues,
      judgments: new Map(cache.judgments),
      glossary: cache.glossary,
      registerNorms: new Map(cache.registerNorms),
      policy: profile.policy,
      unjudged: cache.unjudged,
    });
    return { cache, findings, byCell: new Map(findings.map((f) => [cellKey(f), f])) };
  };

  const a = load(leftPath);
  const b = load(rightPath);

  const gone = [...a.byCell.keys()].filter((k) => !b.byCell.has(k));
  const added = [...b.byCell.keys()].filter((k) => !a.byCell.has(k));
  const changed = [...a.byCell.keys()].filter((k) => {
    const other = b.byCell.get(k);
    return other && other.severity !== a.byCell.get(k)!.severity;
  });

  const ruleDelta = new Map<string, number>();
  for (const f of a.findings) for (const r of f.reasons) ruleDelta.set(r.rule, (ruleDelta.get(r.rule) ?? 0) - 1);
  for (const f of b.findings) for (const r of f.reasons) ruleDelta.set(r.rule, (ruleDelta.get(r.rule) ?? 0) + 1);

  const sevDelta: [string, number][] = [3, 2, 1, 0].map((s) => [
    `severity ${s}`,
    b.findings.filter((f) => Math.round(f.severity) === s).length -
      a.findings.filter((f) => Math.round(f.severity) === s).length,
  ]);

  return {
    left: leftPath,
    right: rightPath,
    counts: {
      "findings left": a.findings.length,
      "findings right": b.findings.length,
      added: added.length,
      gone: gone.length,
      "severity changed": changed.length,
      "questions left": a.cache.provenance?.questions ?? "unknown",
      "questions right": b.cache.provenance?.questions ?? "unknown",
    },
    byRule: [...ruleDelta].filter(([, n]) => n !== 0).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])),
    bySeverity: sevDelta,
  };
}

export const stageSummary = (stages: StageStats[]): string =>
  stages.map((s) => `${s.name} ${s.requests - s.errors}/${s.requests}`).join(" · ");

export const runsNear = (path: string): string[] => {
  const dir = dirname(resolve(path));
  return readdirSync(dir)
    .filter((n) => n.endsWith(".run.json"))
    .sort();
};
