import type { EntryJudgment, Finding, Lang } from "../types.ts";
import type { RunCache } from "../cache.ts";
import type { DecisionRecord } from "./decisions.ts";
import { decisionKey } from "./decisions.ts";
import { renderReason, type RuleId } from "../policy/rules.ts";
import { norm } from "../util/text.ts";

/**
 * The eval set the tool writes by being used.
 *
 * Every verdict a translator enters is a label, and all of them were already on disk and
 * read by nothing but the review app. A `reject` on a finding is a labelled false
 * positive. An `edited` on a cell nothing flagged is a labelled miss. An `accept` on a
 * proposed substitution says the gates were right.
 *
 * This is the one measurement `score` cannot synthesise: its generator's template
 * translations are not always good prose, so the model objects to things nobody injected,
 * which is why the low reliability bins are noisy and partly the generator's fault.
 */
export type CaseLabel =
  | "false-positive"
  | "true-positive"
  | "missed"
  | "substitution-taken"
  | "substitution-rewritten";

export type LabelledCase = {
  label: CaseLabel;
  entryId: string;
  lang: Lang;
  source: string;
  was: string;
  became: string;
  verdict: DecisionRecord["verdict"];
  who: string;
  at: string;
  /** The finding the human ruled on, when there was one. */
  severity?: number;
  category?: string;
  rules?: RuleId[];
  why?: string[];
  /** The judgment that produced it, so a disagreement can be looked at directly. */
  meaning?: number;
  adheres?: number;
  suggested?: string | null;
};

const value = (j: EntryJudgment | undefined, field: "meaning" | "adheres", lang: Lang): number | undefined => {
  const v = j?.[field][lang];
  return v ?? undefined;
};

export function buildCasebook(
  cache: RunCache,
  findings: Finding[],
  decisions: Map<string, DecisionRecord>,
): LabelledCase[] {
  const byCell = new Map(findings.map((f) => [decisionKey(f.entryId, f.lang), f]));
  const judgments = new Map(cache.judgments);
  const entries = new Map(cache.corpus.entries.map((e) => [e.id, e]));
  const out: LabelledCase[] = [];

  for (const d of decisions.values()) {
    if (d.verdict === "defer") continue;
    const entry = entries.get(d.entryId);
    if (!entry) continue;
    const f = byCell.get(d.key);
    const j = judgments.get(d.entryId);

    const base = {
      entryId: d.entryId,
      lang: d.lang,
      source: norm(entry.source),
      was: norm(d.was),
      became: norm(d.text),
      verdict: d.verdict,
      who: d.who,
      at: d.at,
      meaning: value(j, "meaning", d.lang),
      adheres: value(j, "adheres", d.lang),
    };

    const fromFinding = f
      ? {
          severity: f.severity,
          category: f.category,
          rules: f.reasons.map((r) => r.rule),
          why: f.reasons.map(renderReason),
          suggested: f.suggested,
        }
      : {};

    if (!f) {
      // Nothing was flagged here and a human changed it anyway.
      if (d.verdict === "edited" && base.became && base.became !== base.was) {
        out.push({ label: "missed", ...base, ...fromFinding });
      }
      continue;
    }

    if (d.verdict === "reject") {
      out.push({ label: "false-positive", ...base, ...fromFinding });
      continue;
    }

    // accept or edited on a flagged row: the human agreed something was wrong here
    out.push({ label: "true-positive", ...base, ...fromFinding });

    if (f.suggested) {
      out.push({
        label: d.verdict === "accept" ? "substitution-taken" : "substitution-rewritten",
        ...base,
        ...fromFinding,
      });
    }
  }

  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export type CasebookStats = {
  cases: number;
  reviewers: number;
  byLabel: [CaseLabel, number][];
  /** Of the rows a human ruled on, how many were real. Recall is not knowable here. */
  precision: number | null;
  precisionAtSeverity2: number | null;
  substitutionPrecision: number | null;
  missed: number;
  /** Rules ranked by how often a human said the finding was wrong. */
  falsePositivesByRule: [RuleId, number][];
};

export function casebookStats(cases: LabelledCase[]): CasebookStats {
  const byLabel = new Map<CaseLabel, number>();
  for (const c of cases) byLabel.set(c.label, (byLabel.get(c.label) ?? 0) + 1);

  const tp = byLabel.get("true-positive") ?? 0;
  const fp = byLabel.get("false-positive") ?? 0;
  const taken = byLabel.get("substitution-taken") ?? 0;
  const rewritten = byLabel.get("substitution-rewritten") ?? 0;

  const sev2 = cases.filter((c) => (c.severity ?? 0) >= 2);
  const tp2 = sev2.filter((c) => c.label === "true-positive").length;
  const fp2 = sev2.filter((c) => c.label === "false-positive").length;

  const falseByRule = new Map<RuleId, number>();
  for (const c of cases) {
    if (c.label !== "false-positive") continue;
    for (const r of c.rules ?? []) falseByRule.set(r, (falseByRule.get(r) ?? 0) + 1);
  }

  const ratio = (a: number, b: number): number | null => (a + b === 0 ? null : Number((a / (a + b)).toFixed(4)));

  return {
    cases: cases.length,
    reviewers: new Set(cases.map((c) => c.who)).size,
    byLabel: [...byLabel].sort((a, b) => b[1] - a[1]),
    precision: ratio(tp, fp),
    precisionAtSeverity2: ratio(tp2, fp2),
    substitutionPrecision: ratio(taken, rewritten),
    missed: byLabel.get("missed") ?? 0,
    falsePositivesByRule: [...falseByRule].sort((a, b) => b[1] - a[1]),
  };
}

/**
 * Why there is no recall here.
 *
 * A reviewer only opens rows the audit already flagged, so the corpus of decisions is
 * conditioned on the audit having fired. Precision is measurable from it; recall is not,
 * because the cells nobody was shown are exactly the ones a missed defect lives in. The
 * `missed` count is a floor on false negatives, not an estimate of them.
 */
export const RECALL_NOTE =
  "precision is measurable here; recall is not — a reviewer only sees rows the audit flagged, " +
  "so `missed` is a floor on false negatives rather than an estimate of them";
