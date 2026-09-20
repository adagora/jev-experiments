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
  interchangeable: number;
  doNotTranslate: number;
  covered: number;
  severity: number;
  variants: Variant[];
  entryIds: string[];
  origin: TermConflict["origin"] | "spacing-or-case";
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
  reasons: string[];
  category: Category;
  severity: number;
  action: Action;
  confidence: number;
  substitutionOk: number | null;
};

export type EntryJudgment = {
  entryId: string;
  isUiString: number;
  meaning: Record<Lang, number>;
  adheres: Record<Lang, number>;
  register: Record<Lang, { form: "formal" | "informal" | "none"; confidence: number }>;
  ms: number;
};

export type StageStats = {
  name: string;
  requests: number;
  judgments: number;
  errors: number;
  retries: number;
  wallMs: number;
  latencies: number[];
  inputTokens: number;
  outputTokens: number;
};
