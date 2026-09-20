import { performance } from "node:perf_hooks";
import type { Entry, TermConflict, Variant } from "../types.ts";
import { JevClient, asChoice, asNoul, choice } from "../jev/client.ts";
import { CONTEXT_DEPENDENT, arbitrationQuestions, arbitrationState, langName } from "../jev/questions.ts";
import { orderStats, type OrderProbe } from "../calibrate.ts";

export const DOMAIN =
  "a B2B product configurator and order portal for building joinery (gates, doors, fences, windows)";

function reversed(c: TermConflict): TermConflict {
  return { ...c, variants: [...c.variants].reverse() };
}

export async function probeOrder(
  client: JevClient,
  conflicts: TermConflict[],
  entries: Map<string, Entry>,
  sourceLang: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ probes: OrderProbe[]; ms: number }> {
  const t0 = performance.now();
  const probes: OrderProbe[] = [];
  let done = 0;

  const ask = async (c: TermConflict) => {
    const { response } = await client.one(
      arbitrationState(c, entries, sourceLang, DOMAIN),
      { canonical: arbitrationQuestions(c).canonical },
    );
    return asChoice(response.answers.canonical);
  };

  const lanes = Array.from({ length: Math.min(client.concurrency, conflicts.length) }, async () => {
    for (;;) {
      const c = conflicts[done];
      if (!c) return;
      const mine = done++;
      try {
        const [a, b] = await Promise.all([ask(c), ask(reversed(c))]);
        if (!a || !b) {
          onProgress?.(mine + 1, conflicts.length);
          continue;
        }
        const keys = new Set([...Object.keys(a.probabilities), ...Object.keys(b.probabilities)]);
        let maxDrift = 0;
        for (const k of keys) {
          maxDrift = Math.max(maxDrift, Math.abs((a.probabilities[k] ?? 0) - (b.probabilities[k] ?? 0)));
        }
        probes.push({
          id: `${c.term}/${c.lang}`,
          first: a.choice,
          second: b.choice,
          agree: a.choice === b.choice,
          confidenceFirst: a.confidence,
          confidenceSecond: b.confidence,
          maxDrift,
        });
      } catch {
      }
      onProgress?.(mine + 1, conflicts.length);
    }
  });
  await Promise.all(lanes);
  return { probes, ms: performance.now() - t0 };
}

export type ScopeProbe = {
  id: string;
  tookNoMatch: boolean;
  chose: string | null;
  confidence: number;
  presence: number;
};

export async function probeScope(
  client: JevClient,
  cases: { id: string; lang: string; term: string; keep: Variant[] }[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ probes: ScopeProbe[]; ms: number }> {
  const t0 = performance.now();
  const probes: ScopeProbe[] = [];
  let done = 0;

  const lanes = Array.from({ length: Math.min(client.concurrency, cases.length) }, async () => {
    for (;;) {
      const c = cases[done];
      if (!c) return;
      const mine = done++;
      const target = langName(c.lang);
      const options: Record<string, string | null> = {};
      for (const v of c.keep) options[v.text] = `Used in ${v.count} keys.`;
      options[CONTEXT_DEPENDENT] =
        "None of the renderings above is the right one for this term, or the right wording depends on where it appears.";

      try {
        const { response } = await client.one(
          {
            domain: DOMAIN,
            source_language: "Polish",
            target_language: target,
            source_term: c.term,
            observed_renderings: c.keep.map((v) => ({ rendering: v.text, used_in_keys: v.count })),
          },
          {
            canonical: choice(
              `Which rendering should become the single canonical ${target} term for \`source_term\`?`,
              options,
            ),
            covered: {
              type: "noul",
              instructions: `Is the correct ${target} translation of \`source_term\` present in \`observed_renderings\`?`,
            },
          },
        );
        const pick = asChoice(response.answers.canonical);
        if (!pick) {
          onProgress?.(mine + 1, cases.length);
          continue;
        }
        probes.push({
          id: c.id,
          tookNoMatch: pick.choice === CONTEXT_DEPENDENT,
          chose: pick.choice,
          confidence: pick.confidence,
          presence: asNoul(response.answers.covered) ?? NaN,
        });
      } catch {
      }
      onProgress?.(mine + 1, cases.length);
    }
  });
  await Promise.all(lanes);
  return { probes, ms: performance.now() - t0 };
}

export function scopeStats(probes: ScopeProbe[]) {
  const n = probes.length;
  const caught = probes.filter((p) => p.tookNoMatch).length;
  const missed = probes.filter((p) => !p.tookNoMatch);
  const confidentlyWrong = missed.filter((p) => p.confidence >= 0.8).length;

  const withPresence = probes.filter((p) => Number.isFinite(p.presence));
  const presenceCaught = withPresence.filter((p) => p.presence < 0.5).length;

  const missedWithConfidence = missed.filter((p) => Number.isFinite(p.confidence));

  return {
    n,
    caught,
    caughtRate: n ? caught / n : NaN,
    confidentlyWrong,
    presenceCaught,
    presenceN: withPresence.length,
    presenceRate: withPresence.length ? presenceCaught / withPresence.length : NaN,
    meanConfidenceWhenWrong: missedWithConfidence.length
      ? missedWithConfidence.reduce((s, p) => s + p.confidence, 0) / missedWithConfidence.length
      : NaN,
  };
}

export { orderStats };
