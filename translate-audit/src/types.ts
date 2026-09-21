import type { Reason } from "./policy/rules.ts";

export type Lang = string;

export type Entry = {
  id: string;
  project: string;
  keyName: string;
  source: string;
  description: string;
  context: string;
  tags: string[];
  tr: Record<Lang, string>;
  status: Record<Lang, string>;
};

export type Corpus = {
  sourceLang: Lang;
  langs: Lang[];
  entries: Entry[];
  origin: string;
};

export type LintCode =
  | "placeholder-mismatch"
  | "tag-mismatch"
  | "whitespace"
  | "empty-translation"
  | "untranslated-copy"
  | "case-inconsistent"
  | "duplicate-source-divergent"
  | "spacing-variant"
  | "terminal-punctuation";

export type LintIssue = {
  entryId: string;
  lang: Lang;
  code: LintCode;
  detail: string;
};

export type Variant = {
  text: string;
  count: number;
  examples: string[];
};

export type TermConflict = {
  term: string;
  lang: Lang;
  variants: Variant[];
  entryIds: string[];
  origin: "duplicate-source" | "short-key-term";
  trivial: boolean;
};

export type GlossaryEntry = {
  term: string;
  lang: Lang;
  canonical: string | null;
  confidence: number;
  /**
   * `null` means not known. It used to be `NaN`, which JSON cannot carry and which
   * `Number.isNaN(null)` reads as a number — a conversion at every persistence boundary
   * and one real bug. There is nothing to convert now.
   */
  interchangeable: number | null;
  doNotTranslate: number | null;
  covered: number | null;
  severity: number | null;
  variants: Variant[];
  entryIds: string[];
  /**
   * How the term came to be known. `human` is a term a translator typed, which no mining
   * ever proposed — it used to be recorded as `duplicate-source`, which was a guess the
   * workbook then printed as fact.
   */
  origin: TermConflict["origin"] | "spacing-or-case" | "human";
};

export type Action = "keep" | "auto-fix" | "needs human" | "needs source fix";

export type Category =
  | "integrity"
  | "meaning"
  | "consistency"
  | "completeness"
  | "style";

export type Finding = {
  entryId: string;
  project: string;
  keyName: string;
  lang: Lang;
  source: string;
  current: string;
  suggested: string | null;
  reasons: Reason[];
  category: Category;
  severity: number;
  action: Action;
  confidence: number;
  substitutionOk: number | null;
  /** False when the audit was attempted for this key and did not come back. */
  judged: boolean;
};

export type EntryJudgment = {
  entryId: string;
  /** `null` when the request came back without it. */
  isUiString: number | null;
  meaning: Record<Lang, number>;
  adheres: Record<Lang, number>;
  register: Record<Lang, { form: "formal" | "informal" | "none"; confidence: number }>;
  ms: number;
};

export type StageStats = {
  name: string;
  /** Units this stage tried. `requests - errors` is how many came back. */
  requests: number;
  judgments: number;
  errors: number;
  /** Units deliberately not attempted — no translation to judge, or filtered out. */
  skipped: number;
  /** Units answered from evidence already on disk. Attempted, answered, and free. */
  reused: number;
  retries: number;
  wallMs: number;
  latencies: number[];
  inputTokens: number;
  outputTokens: number;
};

/** A unit the model was asked about and did not answer for. */
export type Unjudged = {
  stage: string;
  entryId: string;
  error: string;
  status: number;
};

/**
 * What a stage actually saw. A summary that does not state this is a claim about a
 * population it did not measure: a failed request leaves its key unjudged, and an
 * unjudged key produces only lint findings — which looks exactly like a key that passed.
 */
export type Coverage = {
  attempted: number;
  answered: number;
  failed: number;
  skipped: number;
};
