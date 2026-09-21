import type { Lang, LintCode } from "../types.ts";
import type { SubstitutionGates } from "../config/profile.ts";

/**
 * Why a finding was raised, as data.
 *
 * Policy used to write English into `reasons` and then read it back —
 * `reasons.some((r) => r.startsWith("meaning not preserved"))` — so rewording a
 * sentence silently changed which rows were auto-fixed. A reason is a rule and its
 * arguments; the English is produced by `renderReason` at display time and never
 * parsed. Grouping, filtering and explaining all key off `rule`.
 */
export type Register = "formal" | "informal";

export type Reason =
  | { rule: "lint"; code: LintCode; detail: string }
  | { rule: "no-translation" }
  | { rule: "untranslated-copy"; sourceLang: Lang }
  | { rule: "duplicate-source-divergent"; detail: string }
  | { rule: "spacing-variant"; detail: string }
  | { rule: "meaning-not-preserved"; p: number; threshold: number }
  | { rule: "meaning-uncertain"; p: number; threshold: number }
  | {
      rule: "canonical-not-used";
      p: number;
      threshold: number;
      terms: { term: string; canonical: string }[];
    }
  | {
      rule: "register-drift";
      lang: Lang;
      house: Register;
      observed: Register;
      share: number;
      confidence: number;
    }
  | { rule: "not-user-facing"; p: number; threshold: number }
  | { rule: "not-judged"; stage: string }
  | { rule: "substitution-verified"; from: string; to: string; grammatical: number; preserved: number; improved: number }
  | {
      rule: "substitution-rejected";
      from: string;
      to: string;
      grammatical: number;
      preserved: number;
      improved: number;
      gates: SubstitutionGates;
    }
  | { rule: "substitution-unverified"; from: string; to: string }
  /** A run saved before reasons were structured. Its text is all that survives. */
  | { rule: "legacy"; text: string };

export type RuleId = Reason["rule"];

const p2 = (n: number): string => n.toFixed(2);

export function renderReason(r: Reason): string {
  switch (r.rule) {
    case "lint":
      return `${r.code} — ${r.detail}`;
    case "no-translation":
      return "no translation";
    case "untranslated-copy":
      return `identical to the ${r.sourceLang} source`;
    case "duplicate-source-divergent":
      return `same source translated differently elsewhere — ${r.detail}`;
    case "spacing-variant":
      return `spacing or case varies between otherwise identical translations — ${r.detail}`;
    case "meaning-not-preserved":
      return `meaning not preserved (p=${p2(r.p)}) — check negation, quantity and condition`;
    case "meaning-uncertain":
      return `meaning uncertain (p=${p2(r.p)})`;
    case "canonical-not-used": {
      const named = r.terms.map((t) => `"${t.term}" → "${t.canonical}"`).join(", ");
      return `does not use the canonical term${named ? ` (${named})` : ""} (p=${p2(r.p)})`;
    }
    case "register-drift":
      return (
        `register drift — ${Math.round(r.share * 100)}% of ${r.lang} strings that address the reader are ` +
        `${r.house}, this one is ${r.observed} (confidence ${p2(r.confidence)})`
      );
    case "not-user-facing":
      return `(not a user-facing string, p=${p2(r.p)} — cosmetic checks only)`;
    case "not-judged":
      return `not judged — the ${r.stage} request for this key did not come back, so only the exact checks ran`;
    case "substitution-verified":
      return (
        `substitution "${r.from}" → "${r.to}" verified (grammatical ${p2(r.grammatical)}, ` +
        `meaning ${p2(r.preserved)}, better ${p2(r.improved)})`
      );
    case "substitution-rejected": {
      const failed = [
        r.grammatical < r.gates.grammatical ? `grammar ${p2(r.grammatical)}` : null,
        r.preserved < r.gates.preserved ? `meaning ${p2(r.preserved)}` : null,
        r.improved < r.gates.improved ? `not an improvement ${p2(r.improved)}` : null,
      ].filter(Boolean);
      return `substitution "${r.from}" → "${r.to}" rejected (${failed.join(", ")})`;
    }
    case "substitution-unverified":
      return `substitution proposed ("${r.from}" → "${r.to}") but could not be verified`;
    case "legacy":
      return r.text;
  }
}

/** A stable, probability-free label for grouping a summary by rule. */
export const RULE_LABELS: Record<RuleId, string> = {
  lint: "exact defect",
  "no-translation": "no translation",
  "untranslated-copy": "identical to the source",
  "duplicate-source-divergent": "same source translated differently elsewhere",
  "spacing-variant": "spacing or case varies",
  "meaning-not-preserved": "meaning not preserved",
  "meaning-uncertain": "meaning uncertain",
  "canonical-not-used": "does not use the canonical term",
  "register-drift": "register drift",
  "not-user-facing": "not a user-facing string",
  "not-judged": "not judged",
  "substitution-verified": "substitution verified",
  "substitution-rejected": "substitution rejected",
  "substitution-unverified": "substitution could not be verified",
  legacy: "saved before reasons were structured",
};

/** `lint` carries its own code, which is the grouping people actually want. */
export const ruleLabel = (r: Reason): string =>
  r.rule === "lint" ? `${r.code}` : RULE_LABELS[r.rule];

export const has = (reasons: Reason[], rule: RuleId): boolean => reasons.some((r) => r.rule === rule);

export const find = <K extends RuleId>(reasons: Reason[], rule: K): Extract<Reason, { rule: K }> | undefined =>
  reasons.find((r): r is Extract<Reason, { rule: K }> => r.rule === rule);

/** Reads a reason saved before stage 2, so an old run still renders. */
export const legacy = (text: string): Reason => ({ rule: "legacy", text });
