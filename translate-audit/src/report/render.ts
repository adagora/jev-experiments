import type { Category, Finding } from "../types.ts";
import { compose, summarise, type Summary } from "../compose.ts";
import { policyNote, type Policy, type Profile } from "../config/profile.ts";
import { has } from "../policy/rules.ts";
import { loadCache, type RunCache } from "../cache.ts";
import { writeWorkbook } from "./xlsx.ts";

export type RenderOptions = {
  cachePath: string;
  out: string;
  /** Thresholds, gates and prices already have every override folded in by `loadProfile`. */
  profile: Profile;
  minSeverity?: number;
  only?: Set<Category | string>;
};

export type RenderResult = { cache: RunCache; composed: number; kept: number; summary: Summary; out: string };

export async function renderFromCache(opts: RenderOptions): Promise<RenderResult> {
  const cache = loadCache(opts.cachePath);
  const policy: Policy = opts.profile.policy;

  let findings: Finding[] = compose({
    corpus: cache.corpus,
    lintIssues: cache.lintIssues,
    judgments: new Map(cache.judgments),
    glossary: cache.glossary,
    registerNorms: new Map(cache.registerNorms),
    policy,
    unjudged: cache.unjudged,
  });

  const subs = new Map(cache.substitutions.map((x) => [`${x.entryId}\u0000${x.lang}`, x]));
  for (const f of findings) {
    const hit = subs.get(`${f.entryId}\u0000${f.lang}`);
    if (!hit) continue;
    f.suggested = hit.suggested;
    f.substitutionOk = hit.check;
    if (hit.note && !f.reasons.some((r) => r.rule === hit.note!.rule)) f.reasons.push(hit.note);
    if (has(f.reasons, "substitution-verified")) f.action = "auto-fix";
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
    pricing: opts.profile.pricing,
    startedAt: new Date(cache.savedAt),
    policyNote: policyNote(policy, opts.profile.gates),
  });

  return { cache, composed, kept: findings.length, summary, out: opts.out };
}
