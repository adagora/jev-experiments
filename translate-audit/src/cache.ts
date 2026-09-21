import { readFileSync, writeFileSync } from "node:fs";
import type { Corpus, EntryJudgment, GlossaryEntry, LintIssue, StageStats, Unjudged } from "./types.ts";
import type { Policy, SubstitutionGates } from "./config/profile.ts";
import { legacy, type Reason } from "./policy/rules.ts";

export const CACHE_VERSION = 2;

/** What produced this file. Optional, because runs saved before it existed have none. */
export type RunProvenance = {
  questions: string;
  model: string;
  domain: string;
  policy: Policy;
  gates: SubstitutionGates;
  configuredBy: string[];
};

export type RunCache = {
  version: number;
  savedAt: string;
  provenance?: RunProvenance;
  corpus: Corpus;
  lintIssues: LintIssue[];
  glossary: GlossaryEntry[];
  judgments: [string, EntryJudgment][];
  registerNorms: [string, { formalShare: number; n: number }][];
  stages: StageStats[];
  /** Units asked about that did not come back. Absent in v1 files, which recorded none. */
  unjudged?: Unjudged[];
  substitutions: { entryId: string; lang: string; suggested: string; check: number | null; note: Reason | null }[];
};

export function saveCache(path: string, cache: Omit<RunCache, "version" | "savedAt">): void {
  const payload: RunCache = { version: CACHE_VERSION, savedAt: new Date().toISOString(), ...cache };
  writeFileSync(path, JSON.stringify(payload), "utf8");
}

export function loadCache(path: string): RunCache {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RunCache;
  if (raw.version !== CACHE_VERSION && raw.version !== 1) {
    throw new Error(`${path} was written by cache version ${raw.version}; this build reads version ${CACHE_VERSION}`);
  }
  return {
    ...raw,
    unjudged: raw.unjudged ?? [],
    // v1 had no `skipped`; absent is not zero-known, but zero is the only honest default.
    stages: raw.stages.map((s) => ({ ...s, skipped: s.skipped ?? 0, reused: s.reused ?? 0 })),
    glossary: raw.glossary.map((g) => ({
      ...g,
      interchangeable: g.interchangeable ?? null,
      doNotTranslate: g.doNotTranslate ?? null,
      covered: g.covered ?? null,
      severity: g.severity ?? null,
    })),
    judgments: raw.judgments.map(([id, j]) => [id, { ...j, isUiString: j.isUiString ?? null }]),
    substitutions: raw.substitutions.map((s) => ({
      ...s,
      check: s.check ?? null,
      // v1 stored the note as prose. All that survives of it is the prose.
      note: typeof s.note === "string" ? (s.note ? legacy(s.note) : null) : (s.note ?? null),
    })),
  };
}
