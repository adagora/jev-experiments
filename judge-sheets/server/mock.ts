/**
 * Deterministic stand-in answers for MOCK=1 when a request was never recorded.
 * These are NOT Jev judgments — the UI shows a MOCK banner whenever this mode is on.
 */
import type { Answer, Question } from "./types.ts";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function mockAnswers(state: unknown, questions: Record<string, Question>) {
  const text = typeof state === "string" ? state : JSON.stringify(state);
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const r = hash(text + "|" + q.instructions);
    if (q.type === "noul") {
      out[id] = { type: "noul", noul: Math.round(r * 100) / 100 };
    } else if (q.type === "choice") {
      const opts = Object.keys(q.criteria);
      const pick = opts[Math.floor(r * opts.length)];
      const probabilities = Object.fromEntries(opts.map((o) => [o, o === pick ? 0.7 : 0.3 / (opts.length - 1 || 1)]));
      out[id] = { type: "choice", choice: pick, probabilities, confidence: 0.7 };
    } else {
      const n = q.criteria.length;
      const scoreVal = Math.round(r * (n - 1) * 100) / 100;
      const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), c]));
      const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === Math.round(scoreVal) ? 0.7 : 0.3 / (n - 1 || 1)]));
      out[id] = { type: "score", score: scoreVal, legend, probabilities, confidence: 0.7 };
    }
  }
  return out;
}
