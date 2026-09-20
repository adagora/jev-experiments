import { readFileSync, writeFileSync } from "node:fs";
import type { Corpus, EntryJudgment, GlossaryEntry, LintIssue, StageStats } from "./types.ts";

export const CACHE_VERSION = 1;

export type RunCache = {
  version: number;
  savedAt: string;
  corpus: Corpus;
  lintIssues: LintIssue[];
  glossary: GlossaryEntry[];
  judgments: [string, EntryJudgment][];
  registerNorms: [string, { formalShare: number; n: number }][];
  stages: StageStats[];
  substitutions: { entryId: string; lang: string; suggested: string; check: number; note: string }[];
};

export function saveCache(path: string, cache: Omit<RunCache, "version" | "savedAt">): void {
  const payload: RunCache = { version: CACHE_VERSION, savedAt: new Date().toISOString(), ...cache };
  writeFileSync(path, JSON.stringify(payload), "utf8");
}

const unknown = (n: number | null | undefined): number => (n === null || n === undefined ? NaN : n);

export function loadCache(path: string): RunCache {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RunCache;
  if (raw.version !== CACHE_VERSION) {
    throw new Error(`${path} was written by cache version ${raw.version}; this build reads version ${CACHE_VERSION}`);
  }
  return {
    ...raw,
    glossary: raw.glossary.map((g) => ({
      ...g,
      interchangeable: unknown(g.interchangeable),
      doNotTranslate: unknown(g.doNotTranslate),
      covered: unknown(g.covered),
      severity: unknown(g.severity),
    })),
    judgments: raw.judgments.map(([id, j]) => [id, { ...j, isUiString: unknown(j.isUiString) }]),
    substitutions: raw.substitutions.map((s) => ({ ...s, check: unknown(s.check) })),
  };
}
