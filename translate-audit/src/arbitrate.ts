import type { Entry, GlossaryEntry, StageStats, TermConflict } from "./types.ts";
import { asChoice, asNoul, asScore, type JevClient, type JevRequest } from "./jev/client.ts";
import { CONTEXT_DEPENDENT, arbitrationQuestions, arbitrationState } from "./jev/questions.ts";

export type ArbitrateResult = { glossary: GlossaryEntry[]; stats: StageStats };

export async function arbitrate(
  client: JevClient,
  conflicts: TermConflict[],
  entries: Map<string, Entry>,
  sourceLang: string,
  domain: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ArbitrateResult> {
  const requests: JevRequest<TermConflict>[] = conflicts.map((c) => ({
    tag: c,
    state: arbitrationState(c, entries, sourceLang, domain),
    questions: arbitrationQuestions(c),
  }));

  const glossary: GlossaryEntry[] = [];
  const stats = await client.run(
    "arbitrate",
    requests,
    (r) => {
      const c = r.tag;
      if ("error" in r) {
        glossary.push({
          term: c.term,
          lang: c.lang,
          canonical: null,
          confidence: 0,
          interchangeable: NaN,
          doNotTranslate: NaN,
          covered: NaN,
          severity: NaN,
          variants: c.variants,
          entryIds: c.entryIds,
          origin: c.origin,
        });
        return;
      }
      const pick = asChoice(r.answers.canonical);
      const chosen = pick && pick.choice !== CONTEXT_DEPENDENT ? pick.choice : null;
      glossary.push({
        term: c.term,
        lang: c.lang,
        canonical: chosen,
        confidence: pick?.confidence ?? 0,
        interchangeable: asNoul(r.answers.interchangeable) ?? NaN,
        doNotTranslate: asNoul(r.answers.doNotTranslate) ?? NaN,
        covered: asNoul(r.answers.covered) ?? NaN,
        severity: asScore(r.answers.severity)?.score ?? NaN,
        variants: c.variants,
        entryIds: c.entryIds,
        origin: c.origin,
      });
    },
    onProgress,
  );

  glossary.sort(
    (a, b) =>
      (b.severity || 0) - (a.severity || 0) ||
      b.entryIds.length - a.entryIds.length ||
      a.term.localeCompare(b.term) ||
      a.lang.localeCompare(b.lang),
  );
  return { glossary, stats };
}

export function glossaryIndex(glossary: GlossaryEntry[]): Map<string, GlossaryEntry[]> {
  const byTerm = new Map<string, GlossaryEntry[]>();
  for (const g of glossary) {
    const list = byTerm.get(g.term);
    if (list) list.push(g);
    else byTerm.set(g.term, [g]);
  }
  return byTerm;
}
