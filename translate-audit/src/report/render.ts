import type { Category, Finding } from "../types.ts";
import { POLICY, compose, summarise, type Policy, type Summary } from "../compose.ts";
import { loadCache, type RunCache } from "../cache.ts";
import { writeWorkbook } from "./xlsx.ts";

export const policyNote = (p: Policy): string =>
  `meaning < ${p.meaningBad} = defect, < ${p.meaningDoubtful} = doubtful; glossary adherence < ${p.adherenceBad}; ` +
  `non-UI strings below p=${p.uiStringMin} get cosmetic checks only; formality drift needs a house register at least ` +
  `${Math.round(p.registerMinDominance * 100)}% dominant over ${p.registerMinSample}+ addressing strings; a substitution is ` +
  `offered only when it clears grammar 0.70, meaning 0.80 and improvement 0.60. ` +
  `Change any of these with "translate-audit report <run.json> --meaning-bad 0.2": it re-composes the saved judgments, free.`;

export type RenderOptions = {
  cachePath: string;
  out: string;
  policy?: Partial<Policy>;
  minSeverity?: number;
  only?: Set<Category | string>;
  pricing: { inputPerM: number; outputPerM: number };
};

export type RenderResult = { cache: RunCache; composed: number; kept: number; summary: Summary; out: string };

export async function renderFromCache(opts: RenderOptions): Promise<RenderResult> {
  const cache = loadCache(opts.cachePath);
  const policy: Policy = { ...POLICY, ...opts.policy };

  let findings: Finding[] = compose({
    corpus: cache.corpus,
    lintIssues: cache.lintIssues,
    judgments: new Map(cache.judgments),
    glossary: cache.glossary,
    registerNorms: new Map(cache.registerNorms),
    policy,
  });

  const subs = new Map(cache.substitutions.map((x) => [`${x.entryId}\u0000${x.lang}`, x]));
  for (const f of findings) {
    const hit = subs.get(`${f.entryId}\u0000${f.lang}`);
    if (!hit) continue;
    f.suggested = hit.suggested;
    f.substitutionOk = Number.isNaN(hit.check) ? null : hit.check;
    if (hit.note && !f.reasons.includes(hit.note)) f.reasons.push(hit.note);
    if (hit.note.includes("verified")) f.action = "auto-fix";
  }
  for (const f of findings) if (f.action === "auto-fix" && !f.suggested) f.action = "needs human";

  const composed = findings.length;
  if (opts.minSeverity && opts.minSeverity > 0) findings = findings.filter((f) => f.severity >= opts.minSeverity!);
  if (opts.only?.size) findings = findings.filter((f) => opts.only!.has(f.category));

  const summary = summarise(findings, cache.corpus);
  await writeWorkbook(opts.out, {
    corpus: cache.corpus,
    findings,
    glossary: cache.glossary,
    lintIssues: cache.lintIssues,
    summary,
    stages: cache.stages,
    registerNorms: new Map(cache.registerNorms),
    pricing: opts.pricing,
    startedAt: new Date(cache.savedAt),
    policyNote: policyNote(policy),
  });

  return { cache, composed, kept: findings.length, summary, out: opts.out };
}
