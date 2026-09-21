import type { Finding, GlossaryEntry, Lang, StageStats, Unjudged } from "./types.ts";
import { asNoul, type JevClient, type JevRequest } from "./jev/client.ts";
import { substitutionQuestions, type SubstitutionState } from "./jev/questions.ts";
import { containsTerm, fold, replaceTerm } from "./util/text.ts";
import { DEFAULT_GATES, DEFAULT_POLICY, type Policy, type SubstitutionGates } from "./config/profile.ts";
import type { Reason } from "./policy/rules.ts";

export type Proposal = {
  finding: Finding;
  from: string;
  to: string;
  before: string;
  after: string;
};

export function proposeSubstitutions(
  findings: Finding[],
  glossary: GlossaryEntry[],
  policy: Policy = DEFAULT_POLICY,
): Proposal[] {
  const byLang = new Map<Lang, GlossaryEntry[]>();
  for (const g of glossary) {
    if (!g.canonical || g.confidence < policy.canonicalConfidence) continue;
    if (g.doNotTranslate !== null && g.doNotTranslate >= 0.5) continue;
    const list = byLang.get(g.lang);
    if (list) list.push(g);
    else byLang.set(g.lang, [g]);
  }

  const out: Proposal[] = [];
  for (const f of findings) {
    if (f.action !== "auto-fix" || !f.current) continue;
    const candidates = byLang.get(f.lang) ?? [];
    const sourceFolded = fold(f.source);

    for (const g of candidates) {
      if (!containsTerm(sourceFolded, g.term)) continue;
      const canonical = g.canonical!;
      const losers = g.variants
        .map((v) => v.text)
        .filter((t) => fold(t) !== fold(canonical))
        .sort((a, b) => b.length - a.length);

      for (const loser of losers) {
        const { text, count } = replaceTerm(f.current, loser, canonical);
        if (count === 0 || text === f.current) continue;
        out.push({ finding: f, from: loser, to: canonical, before: f.current, after: text });
        break;
      }
    }
  }
  return out;
}

export type SubstituteResult = { applied: number; rejected: number; stats: StageStats; unjudged: Unjudged[] };

export async function verifySubstitutions(
  client: JevClient,
  proposals: Proposal[],
  sourceLangName: string,
  onProgress?: (done: number, total: number) => void,
  gates: SubstitutionGates = DEFAULT_GATES,
): Promise<SubstituteResult> {
  const requests: JevRequest<Proposal>[] = proposals.map((p) => ({
    tag: p,
    unit: `fix:${p.finding.entryId}/${p.finding.lang}`,
    state: {
      target_language: p.finding.lang,
      source_language: sourceLangName,
      source: p.finding.source,
      before: p.before,
      after: p.after,
      replaced_term: p.from,
      canonical_term: p.to,
    } satisfies SubstitutionState & { source_language: string },
    questions: substitutionQuestions(p.finding.lang),
  }));

  let applied = 0;
  let rejected = 0;
  const unjudged: Unjudged[] = [];
  const stats = await client.run(
    "substitute",
    requests,
    (r) => {
      const p = r.tag;
      if ("error" in r) {
        unjudged.push({ stage: "substitute", entryId: p.finding.entryId, error: r.error, status: r.status });
        p.finding.action = "needs human";
        p.finding.suggested = p.after;
        p.finding.reasons.push({ rule: "substitution-unverified", from: p.from, to: p.to });
        rejected++;
        return;
      }
      const grammatical = asNoul(r.answers.grammatical) ?? 0;
      const preserved = asNoul(r.answers.preserved) ?? 0;
      const improved = asNoul(r.answers.improved) ?? 0;
      p.finding.suggested = p.after;
      p.finding.substitutionOk = Math.min(grammatical, preserved, improved);

      const ok =
        grammatical >= gates.grammatical &&
        preserved >= gates.preserved &&
        improved >= gates.improved;

      const verdict: Reason = ok
        ? { rule: "substitution-verified", from: p.from, to: p.to, grammatical, preserved, improved }
        : { rule: "substitution-rejected", from: p.from, to: p.to, grammatical, preserved, improved, gates };
      p.finding.reasons.push(verdict);

      if (ok) {
        p.finding.action = "auto-fix";
        applied++;
      } else {
        p.finding.action = "needs human";
        rejected++;
      }
    },
    onProgress,
  );

  return { applied, rejected, stats, unjudged };
}
