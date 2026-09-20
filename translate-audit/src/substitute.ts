import type { Finding, GlossaryEntry, Lang, StageStats } from "./types.ts";
import { asNoul, type JevClient, type JevRequest } from "./jev/client.ts";
import { substitutionQuestions, type SubstitutionState } from "./jev/questions.ts";
import { containsTerm, fold, replaceTerm } from "./util/text.ts";
import { POLICY, type Policy } from "./compose.ts";

export const SUBSTITUTION_GATES = { grammatical: 0.7, preserved: 0.8, improved: 0.6 };

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
  policy: Policy = POLICY,
): Proposal[] {
  const byLang = new Map<Lang, GlossaryEntry[]>();
  for (const g of glossary) {
    if (!g.canonical || g.confidence < policy.canonicalConfidence) continue;
    if (!Number.isNaN(g.doNotTranslate) && g.doNotTranslate >= 0.5) continue;
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

export type SubstituteResult = { applied: number; rejected: number; stats: StageStats };

export async function verifySubstitutions(
  client: JevClient,
  proposals: Proposal[],
  sourceLangName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<SubstituteResult> {
  const requests: JevRequest<Proposal>[] = proposals.map((p) => ({
    tag: p,
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
  const stats = await client.run(
    "substitute",
    requests,
    (r) => {
      const p = r.tag;
      if ("error" in r) {
        p.finding.action = "needs human";
        p.finding.suggested = p.after;
        p.finding.reasons.push(`substitution proposed ("${p.from}" → "${p.to}") but could not be verified`);
        rejected++;
        return;
      }
      const grammatical = asNoul(r.answers.grammatical) ?? 0;
      const preserved = asNoul(r.answers.preserved) ?? 0;
      const improved = asNoul(r.answers.improved) ?? 0;
      p.finding.suggested = p.after;
      p.finding.substitutionOk = Math.min(grammatical, preserved, improved);

      const ok =
        grammatical >= SUBSTITUTION_GATES.grammatical &&
        preserved >= SUBSTITUTION_GATES.preserved &&
        improved >= SUBSTITUTION_GATES.improved;

      if (ok) {
        p.finding.action = "auto-fix";
        p.finding.reasons.push(
          `substitution "${p.from}" → "${p.to}" verified (grammatical ${grammatical.toFixed(2)}, ` +
            `meaning ${preserved.toFixed(2)}, better ${improved.toFixed(2)})`,
        );
        applied++;
      } else {
        p.finding.action = "needs human";
        const failed = [
          grammatical < SUBSTITUTION_GATES.grammatical ? `grammar ${grammatical.toFixed(2)}` : null,
          preserved < SUBSTITUTION_GATES.preserved ? `meaning ${preserved.toFixed(2)}` : null,
          improved < SUBSTITUTION_GATES.improved ? `not an improvement ${improved.toFixed(2)}` : null,
        ].filter(Boolean);
        p.finding.reasons.push(`substitution "${p.from}" → "${p.to}" rejected (${failed.join(", ")})`);
        rejected++;
      }
    },
    onProgress,
  );

  return { applied, rejected, stats };
}
