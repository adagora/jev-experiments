export type Lang = string;
export type Category = "integrity" | "meaning" | "consistency" | "completeness" | "style";
export type Action = "keep" | "auto-fix" | "needs human" | "needs source fix";
export type Verdict = "accept" | "reject" | "edited" | "defer";
export type TermStatus = "proposed" | "approved" | "rejected" | "context-dependent" | "do-not-translate";

export type Variant = { text: string; count: number; examples: string[] };

export type ReviewRow = {
  entryId: string;
  project: string;
  keyName: string;
  lang: Lang;
  source: string;
  current: string;
  suggested: string | null;
  reasons: string[];
  rules: string[];
  category: Category;
  severity: number;
  action: Action;
  confidence: number;
  substitutionOk: number | null;
  verdict: Verdict | null;
  decidedText: string | null;
  decidedBy: string | null;
  siblings: { text: string; count: number }[];
};

export type GlossaryRow = {
  key: string;
  term: string;
  display: string;
  lang: Lang;
  canonical: string | null;
  status: TermStatus;
  source: "jev" | "code" | "human";
  confidence: number;
  severity: number | null;
  doNotTranslate: number | null;
  covered: number | null;
  variants: Variant[];
  entryIds: string[];
  guidance: string;
  note: string;
  decidedBy: string | null;
  decidedAt: string | null;
  firstSeen: string;
};

export type StageStats = {
  name: string;
  /** Units the stage tried. `requests - reused` is how many were actually sent. */
  requests: number;
  judgments: number;
  errors: number;
  /** Units answered from evidence already on disk: attempted, answered, and free. */
  reused: number;
  skipped: number;
  retries: number;
  wallMs: number;
  latencies: number[];
  inputTokens: number;
  outputTokens: number;
};

export type Meta = {
  origin: string;
  sourceLang: Lang;
  langs: Lang[];
  keys: number;
  savedAt: string;
  stages: StageStats[];
  policy: Record<string, number>;
  live: boolean;
};

export type Stats = {
  summary: {
    findings: number;
    entriesTouched: number;
    entriesTotal: number;
    bySeverity: number[];
    byLang: [string, number][];
    byAction: [string, number][];
    byCategory: [Category, number][];
    byReason: [string, number][];
  };
  glossary: {
    total: number;
    decided: number;
    proposed: number;
    withGuidance: number;
    byStatus: [TermStatus, number][];
    keysCovered: number;
  };
  decisions: {
    total: number;
    changed: number;
    byVerdict: [Verdict, number][];
    byWho: [string, number][];
  };
};

export type EntryDetail = {
  id: string;
  project: string;
  keyName: string;
  source: string;
  description: string;
  context: string;
  isUiString: number | null;
  translations: {
    lang: Lang;
    langName: string;
    value: string;
    meaning: number | null;
    adheres: number | null;
    register: { form: "formal" | "informal" | "none"; confidence: number } | null;
    decided: string | null;
  }[];
};

export type EditCheck = { meaning: number; grammatical: number; glossaryOk: number; ms: number };

/**
 * What `POST /api/consistency` answers for a string being written. `violations` and
 * `glossary` are established by matching and cost nothing; `judged` is the only part that
 * takes a request, and it is `null` when none was made — never a faked number.
 */
export type Consistency = {
  glossary: { term: string; canonical: string; guidance?: string }[];
  violations: { term: string; used: string; canonical: string; guidance?: string; suggested: string }[];
  judged: { meaning: number | null; grammatical: number | null; glossaryOk: number | null } | null;
  ms: number;
};

export type TermOpinion = {
  canonical: string | null;
  contextDependent: boolean;
  confidence: number;
  probabilities: Record<string, number>;
  doNotTranslate: number | null;
  ms: number;
};

export const CATEGORIES: Category[] = ["integrity", "meaning", "consistency", "completeness", "style"];

export const CATEGORY_NOTE: Record<Category, string> = {
  integrity: "placeholders or markup differ — the product renders wrong",
  meaning: "says something other than the source says",
  consistency: "right meaning, different wording than elsewhere",
  completeness: "missing, or still in the source language",
  style: "casing, punctuation or formality",
};

export const STATUSES: TermStatus[] = ["proposed", "approved", "rejected", "context-dependent", "do-not-translate"];

export const SEVERITY_LABEL = ["cosmetic", "minor", "confusing", "breaks meaning"];
