import type { Action, Category, Corpus, Entry, EntryJudgment, Finding, GlossaryEntry, Lang, LintIssue } from "./types.ts";
import { norm } from "./util/text.ts";
import { indexByTerm } from "./glossary/match.ts";

export type Policy = {
  meaningBad: number;
  meaningDoubtful: number;
  adherenceBad: number;
  uiStringMin: number;
  registerMinSample: number;
  registerMinDominance: number;
  registerMinConfidence: number;
  canonicalConfidence: number;
  autoFixMaxSeverity: number;
};

export const POLICY: Policy = {
  meaningBad: 0.35,
  meaningDoubtful: 0.7,
  adherenceBad: 0.4,
  uiStringMin: 0.25,
  registerMinSample: 25,
  registerMinDominance: 0.8,
  registerMinConfidence: 0.6,
  canonicalConfidence: 0.6,
  autoFixMaxSeverity: 2,
};

const HARD_CODES = new Set(["placeholder-mismatch", "tag-mismatch"]);
const COSMETIC_CODES = new Set(["case-inconsistent", "terminal-punctuation", "whitespace", "spacing-variant"]);

export type ComposeInput = {
  corpus: Corpus;
  lintIssues: LintIssue[];
  judgments: Map<string, EntryJudgment>;
  glossary: GlossaryEntry[];
  registerNorms: Map<Lang, { formalShare: number; n: number }>;
  policy?: Policy;
};

export function compose(input: ComposeInput): Finding[] {
  const policy = input.policy ?? POLICY;
  const targets = input.corpus.langs.filter((l) => l !== input.corpus.sourceLang);

  const lintByPair = new Map<string, LintIssue[]>();
  for (const i of input.lintIssues) {
    const k = `${i.entryId}\u0000${i.lang}`;
    const list = lintByPair.get(k);
    if (list) list.push(i);
    else lintByPair.set(k, [i]);
  }

  const glossaryIndex = indexByTerm(input.glossary, (g) => g.term);

  const findings: Finding[] = [];

  for (const entry of input.corpus.entries) {
    const j = input.judgments.get(entry.id);
    const isUi = j ? (Number.isNaN(j.isUiString) ? 1 : j.isUiString) : 1;
    const applicable = glossaryIndex.matches(entry.source).flatMap((m) => m.value);

    for (const lang of targets) {
      const current = norm(entry.tr[lang] ?? "");
      const lint = lintByPair.get(`${entry.id}\u0000${lang}`) ?? [];
      if (!current && !lint.length) continue;

      const reasons: string[] = [];
      const categories = new Set<Category>();
      let severity = 0;
      let confidence = 1;

      for (const i of lint) {
        if (HARD_CODES.has(i.code)) {
          reasons.push(`${i.code} — ${i.detail}`);
          severity = Math.max(severity, 3);
          categories.add("integrity");
        } else if (i.code === "empty-translation") {
          reasons.push("no translation");
          severity = Math.max(severity, 2);
          categories.add("completeness");
        } else if (i.code === "untranslated-copy") {
          reasons.push(`identical to the ${input.corpus.sourceLang} source`);
          severity = Math.max(severity, 2);
          categories.add("completeness");
        } else if (i.code === "duplicate-source-divergent") {
          reasons.push(`same source translated differently elsewhere — ${i.detail}`);
          severity = Math.max(severity, 1);
          categories.add("consistency");
        } else if (i.code === "spacing-variant") {
          reasons.push(`spacing or case varies between otherwise identical translations — ${i.detail}`);
          severity = Math.max(severity, 0);
          categories.add("consistency");
        } else if (COSMETIC_CODES.has(i.code)) {
          reasons.push(`${i.code} — ${i.detail}`);
          severity = Math.max(severity, 1);
          categories.add("style");
        }
      }

      if (j && isUi >= policy.uiStringMin) {
        const meaning = j.meaning[lang];
        if (meaning !== undefined && !Number.isNaN(meaning)) {
          if (meaning < policy.meaningBad) {
            reasons.push(`meaning not preserved (p=${meaning.toFixed(2)}) — check negation, quantity and condition`);
            severity = Math.max(severity, 3);
            categories.add("meaning");
            confidence = Math.min(confidence, 1 - meaning);
          } else if (meaning < policy.meaningDoubtful) {
            reasons.push(`meaning uncertain (p=${meaning.toFixed(2)})`);
            severity = Math.max(severity, 1);
            categories.add("meaning");
            confidence = Math.min(confidence, 1 - meaning);
          }
        }

        const adheres = j.adheres[lang];
        const terms = applicable.filter((g) => g.lang === lang && g.canonical);
        if (terms.length > 0 && adheres !== undefined && !Number.isNaN(adheres) && adheres < policy.adherenceBad) {
          const named = terms.map((g) => `"${g.term}" → "${g.canonical}"`).join(", ");
          reasons.push(`does not use the canonical term${named ? ` (${named})` : ""} (p=${adheres.toFixed(2)})`);
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
            reasons.push(
              `register drift — ${Math.round(houseShare * 100)}% of ${lang} strings that address the reader are ` +
                `${houseIsFormal ? "formal" : "informal"}, this one is ${reg.form} (confidence ${reg.confidence.toFixed(2)})`,
            );
            severity = Math.max(severity, 1);
            categories.add("style");
            confidence = Math.min(confidence, reg.confidence);
          }
        }
      } else if (j && isUi < policy.uiStringMin && reasons.length) {
        reasons.push(`(not a user-facing string, p=${isUi.toFixed(2)} — cosmetic checks only)`);
        severity = Math.min(severity, 1);
      }

      if (reasons.length === 0) continue;

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
  gs.reduce((m, g) => (Number.isNaN(g.severity) ? m : Math.max(m, g.severity)), 1);

function decideAction(severity: number, reasons: string[], lint: LintIssue[]): Action {
  if (lint.some((i) => i.code === "empty-translation")) return "needs human";
  if (lint.some((i) => HARD_CODES.has(i.code))) return "needs human";
  if (reasons.some((r) => r.startsWith("meaning not preserved"))) return "needs human";
  if (reasons.some((r) => r.startsWith("does not use the canonical term"))) return "auto-fix";
  if (severity <= 1) return "keep";
  return "needs human";
}

export function reasonHead(reason: string): string {
  return reason
    .replace(/"[^"]*"/g, "…")
    .replace(/\(p=[\d.]+\)/g, "")
    .replace(/\(confidence [\d.]+\)/g, "")
    .replace(/\((grammar|meaning|not an improvement)[^)]*\)/g, "")
    .split(" —")[0]
    .replace(/\s+/g, " ")
    .trim();
}

export function summarise(findings: Finding[], corpus: Corpus) {
  const bySeverity = [0, 0, 0, 0];
  const byLang = new Map<Lang, number>();
  const byAction = new Map<Action, number>();
  const byReason = new Map<string, number>();
  const byCategory = new Map<Category, number>();
  for (const f of findings) {
    bySeverity[Math.min(3, Math.max(0, Math.round(f.severity)))]++;
    byLang.set(f.lang, (byLang.get(f.lang) ?? 0) + 1);
    byAction.set(f.action, (byAction.get(f.action) ?? 0) + 1);
    byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
    for (const r of f.reasons) byReason.set(reasonHead(r), (byReason.get(reasonHead(r)) ?? 0) + 1);
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
  };
}

export type Summary = ReturnType<typeof summarise>;

export const entryIndex = (entries: Entry[]): Map<string, Entry> => new Map(entries.map((e) => [e.id, e]));
