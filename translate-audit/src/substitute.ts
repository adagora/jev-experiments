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

  // A total order over the candidate terms, so which fix a finding gets is a function of
  // the inputs rather than of which lane finished first: worst damage first, then the most
  // specific term, then the name. Ties broken all the way down, because "mostly ordered"
  // reproduces right up until the day it does not.
  for (const list of byLang.values()) {
    list.sort(
      (a, b) =>
        (b.severity ?? 0) - (a.severity ?? 0) ||
        b.term.length - a.term.length ||
        a.term.localeCompare(b.term) ||
        (a.canonical ?? "").localeCompare(b.canonical ?? ""),
    );
  }

  const out: Proposal[] = [];
  for (const f of findings) {
    if (f.action !== "auto-fix" || !f.current) continue;
    const candidates = byLang.get(f.lang) ?? [];
    const sourceFolded = fold(f.source);

    // At most one proposal per finding.
    //
    // Several glossary terms can apply to one string, and every proposal used to hold a
    // reference to the same `Finding` — so whichever request returned last overwrote
    // `suggested`, `substitutionOk` and `action`, while `reasons` accumulated all of them
    // and could carry both a verified and a rejected verdict for the same row. On the
    // production corpus 1,040 requests stored 1,019 suggestions; the other 21 were paid
    // for and dropped.
    //
    // Composing the fixes instead is the tempting repair and it is a trap: each
    // verification asks whether one exact `after` string is grammatical and still means
    // the source. Apply a second edit on top of it and that string no longer exists, so
    // the run would ship text nobody judged while holding a receipt that says verified.
    //
    // Nothing is hidden by choosing one. The finding's `canonical-not-used` reason already
    // names every term that applies, so the reviewer sees the rest and the next run — read
    // against a glossary that has moved on — proposes the next one.
    for (const g of candidates) {
      if (!containsTerm(sourceFolded, g.term)) continue;
      const canonical = g.canonical!;
      const losers = g.variants
        .map((v) => v.text)
        .filter((t) => fold(t) !== fold(canonical))
        .sort((a, b) => b.length - a.length || a.localeCompare(b));

      const hit = losers
        .map((loser) => ({ loser, ...replaceTerm(f.current!, loser, canonical) }))
        .find((r) => r.count > 0 && r.text !== f.current);

      if (hit) {
        out.push({ finding: f, from: hit.loser, to: canonical, before: f.current, after: hit.text });
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
