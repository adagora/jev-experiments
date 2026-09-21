import type {
  Action,
  Category,
  Corpus,
  Coverage,
  Entry,
  EntryJudgment,
  Finding,
  GlossaryEntry,
  Lang,
  LintIssue,
  StageStats,
  Unjudged,
} from "./types.ts";
import { norm } from "./util/text.ts";
import { indexByTerm } from "./glossary/match.ts";
import { DEFAULT_POLICY, type Policy } from "./config/profile.ts";
import { has, ruleLabel, type Reason, type RuleId } from "./policy/rules.ts";

export type { Policy };

const HARD_CODES = new Set(["placeholder-mismatch", "tag-mismatch"]);
const COSMETIC_CODES = new Set(["case-inconsistent", "terminal-punctuation", "whitespace", "spacing-variant"]);

export type ComposeInput = {
  corpus: Corpus;
  lintIssues: LintIssue[];
  judgments: Map<string, EntryJudgment>;
  glossary: GlossaryEntry[];
  registerNorms: Map<Lang, { formalShare: number; n: number }>;
  policy?: Policy;
  /** Keys the audit asked about and did not get an answer for. */
  unjudged?: Unjudged[];
};

export function compose(input: ComposeInput): Finding[] {
  const policy = input.policy ?? DEFAULT_POLICY;
  const targets = input.corpus.langs.filter((l) => l !== input.corpus.sourceLang);

  const lintByPair = new Map<string, LintIssue[]>();
  for (const i of input.lintIssues) {
    const k = `${i.entryId}\u0000${i.lang}`;
    const list = lintByPair.get(k);
    if (list) list.push(i);
    else lintByPair.set(k, [i]);
  }

  const glossaryIndex = indexByTerm(input.glossary, (g) => g.term);
  const blind = new Map((input.unjudged ?? []).map((u) => [u.entryId, u.stage]));

  const findings: Finding[] = [];

  for (const entry of input.corpus.entries) {
    const j = input.judgments.get(entry.id);
    const isUi = j?.isUiString ?? 1;
    const applicable = glossaryIndex.matches(entry.source).flatMap((m) => m.value);

    for (const lang of targets) {
      const current = norm(entry.tr[lang] ?? "");
      const lint = lintByPair.get(`${entry.id}\u0000${lang}`) ?? [];
      if (!current && !lint.length) continue;

      const reasons: Reason[] = [];
      const categories = new Set<Category>();
      let severity = 0;
      let confidence = 1;
      const blindStage = blind.get(entry.id);

      for (const i of lint) {
        if (HARD_CODES.has(i.code)) {
          reasons.push({ rule: "lint", code: i.code, detail: i.detail });
          severity = Math.max(severity, 3);
          categories.add("integrity");
        } else if (i.code === "empty-translation") {
          reasons.push({ rule: "no-translation" });
          severity = Math.max(severity, 2);
          categories.add("completeness");
        } else if (i.code === "untranslated-copy") {
          reasons.push({ rule: "untranslated-copy", sourceLang: input.corpus.sourceLang });
          severity = Math.max(severity, 2);
          categories.add("completeness");
        } else if (i.code === "duplicate-source-divergent") {
          reasons.push({ rule: "duplicate-source-divergent", detail: i.detail });
          severity = Math.max(severity, 1);
          categories.add("consistency");
        } else if (i.code === "spacing-variant") {
          reasons.push({ rule: "spacing-variant", detail: i.detail });
          severity = Math.max(severity, 0);
          categories.add("consistency");
        } else if (COSMETIC_CODES.has(i.code)) {
          reasons.push({ rule: "lint", code: i.code, detail: i.detail });
          severity = Math.max(severity, 1);
          categories.add("style");
        }
      }

      if (j && isUi >= policy.uiStringMin) {
        const meaning = j.meaning[lang];
        if (meaning !== undefined) {
          if (meaning < policy.meaningBad) {
            reasons.push({ rule: "meaning-not-preserved", p: meaning, threshold: policy.meaningBad });
            severity = Math.max(severity, 3);
            categories.add("meaning");
            confidence = Math.min(confidence, 1 - meaning);
          } else if (meaning < policy.meaningDoubtful) {
            reasons.push({ rule: "meaning-uncertain", p: meaning, threshold: policy.meaningDoubtful });
            severity = Math.max(severity, 1);
            categories.add("meaning");
            confidence = Math.min(confidence, 1 - meaning);
          }
        }

        const adheres = j.adheres[lang];
        const terms = applicable.filter((g) => g.lang === lang && g.canonical);
        if (terms.length > 0 && adheres !== undefined && adheres < policy.adherenceBad) {
          reasons.push({
            rule: "canonical-not-used",
            p: adheres,
            threshold: policy.adherenceBad,
            terms: terms.map((g) => ({ term: g.term, canonical: g.canonical! })),
          });
          severity = Math.max(severity, Math.min(2, Math.max(1, Math.round(maxSeverity(terms)))));
          categories.add("consistency");
          confidence = Math.min(confidence, 1 - adheres);
        }

        const reg = j.register[lang];
        const houseNorm = input.registerNorms.get(lang);
        if (reg && reg.form !== "none" && houseNorm && houseNorm.n >= policy.registerMinSample) {
          const houseIsFormal = houseNorm.formalShare >= 0.5;
          const houseShare = houseIsFormal ? houseNorm.formalShare : 1 - houseNorm.formalShare;
          const deviates =
            houseShare >= policy.registerMinDominance &&
            reg.form === (houseIsFormal ? "informal" : "formal") &&
            reg.confidence >= policy.registerMinConfidence;
          if (deviates) {
            reasons.push({
              rule: "register-drift",
              lang,
              house: houseIsFormal ? "formal" : "informal",
              observed: reg.form,
              share: houseShare,
              confidence: reg.confidence,
            });
            severity = Math.max(severity, 1);
            categories.add("style");
            confidence = Math.min(confidence, reg.confidence);
          }
        }
      } else if (j && isUi < policy.uiStringMin && reasons.length) {
        reasons.push({ rule: "not-user-facing", p: isUi, threshold: policy.uiStringMin });
        severity = Math.min(severity, 1);
      }

      if (reasons.length === 0) continue;

      // The semantic checks did not run here. Say so on the row rather than letting it
      // read as a key that passed them.
      if (blindStage !== undefined) reasons.push({ rule: "not-judged", stage: blindStage });

      findings.push({
        entryId: entry.id,
        project: entry.project,
        keyName: entry.keyName,
        lang,
        source: norm(entry.source),
        current,
        suggested: null,
        reasons,
        category: worstCategory(categories),
        severity,
        action: decideAction(severity, reasons, lint),
        confidence,
        substitutionOk: null,
        judged: blindStage === undefined,
      });
    }
  }

  findings.sort(
    (a, b) =>
      b.severity - a.severity ||
      b.confidence - a.confidence ||
      a.lang.localeCompare(b.lang) ||
      a.source.localeCompare(b.source),
  );
  return findings;
}

const CATEGORY_RANK: Category[] = ["integrity", "meaning", "consistency", "completeness", "style"];

const worstCategory = (set: Set<Category>): Category =>
  CATEGORY_RANK.find((c) => set.has(c)) ?? "style";

const maxSeverity = (gs: GlossaryEntry[]): number =>
  gs.reduce((m, g) => (g.severity === null ? m : Math.max(m, g.severity)), 1);

function decideAction(severity: number, reasons: Reason[], lint: LintIssue[]): Action {
  if (lint.some((i) => i.code === "empty-translation")) return "needs human";
  if (lint.some((i) => HARD_CODES.has(i.code))) return "needs human";
  if (has(reasons, "meaning-not-preserved")) return "needs human";
  if (has(reasons, "canonical-not-used")) return "auto-fix";
  if (severity <= 1) return "keep";
  return "needs human";
}

export function summarise(findings: Finding[], corpus: Corpus) {
  const bySeverity = [0, 0, 0, 0];
  const byLang = new Map<Lang, number>();
  const byAction = new Map<Action, number>();
  const byRule = new Map<RuleId, number>();
  const byReason = new Map<string, number>();
  const byCategory = new Map<Category, number>();
  for (const f of findings) {
    bySeverity[Math.min(3, Math.max(0, Math.round(f.severity)))]++;
    byLang.set(f.lang, (byLang.get(f.lang) ?? 0) + 1);
    byAction.set(f.action, (byAction.get(f.action) ?? 0) + 1);
    byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
    for (const r of f.reasons) {
      byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + 1);
      const label = ruleLabel(r);
      byReason.set(label, (byReason.get(label) ?? 0) + 1);
    }
  }
  const touched = new Set(findings.map((f) => f.entryId));
  return {
    findings: findings.length,
    entriesTouched: touched.size,
    entriesTotal: corpus.entries.length,
    bySeverity,
    byLang: [...byLang.entries()].sort((a, b) => b[1] - a[1]),
    byAction: [...byAction.entries()].sort((a, b) => b[1] - a[1]),
    byCategory: CATEGORY_RANK.filter((c) => byCategory.has(c)).map((c) => [c, byCategory.get(c)!] as [Category, number]),
    byReason: [...byReason.entries()].sort((a, b) => b[1] - a[1]),
    byRule: [...byRule.entries()].sort((a, b) => b[1] - a[1]),
  };
}

export type Summary = ReturnType<typeof summarise>;

export const entryIndex = (entries: Entry[]): Map<string, Entry> => new Map(entries.map((e) => [e.id, e]));

/**
 * What the run actually saw, per stage and in total.
 *
 * `report` and the workbook state this because a summary computed over partial evidence
 * is a claim about a population it did not measure.
 */
export function coverageOf(stages: StageStats[]): Map<string, Coverage> {
  const out = new Map<string, Coverage>();
  for (const s of stages) {
    out.set(s.name, {
      attempted: s.requests,
      answered: s.requests - s.errors,
      failed: s.errors,
      skipped: s.skipped,
    });
  }
  return out;
}

export const totalCoverage = (stages: StageStats[]): Coverage =>
  stages.reduce<Coverage>(
    (a, s) => ({
      attempted: a.attempted + s.requests,
      answered: a.answered + (s.requests - s.errors),
      failed: a.failed + s.errors,
      skipped: a.skipped + s.skipped,
    }),
    { attempted: 0, answered: 0, failed: 0, skipped: 0 },
  );

/** 1 when everything asked came back. The number a summary has to earn. */
export const completeness = (c: Coverage): number => (c.attempted === 0 ? 1 : c.answered / c.attempted);
