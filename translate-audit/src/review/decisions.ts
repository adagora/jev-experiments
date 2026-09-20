import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Lang } from "../types.ts";

export type Verdict = "accept" | "reject" | "edited" | "defer";

export type DecisionRecord = {
  key: string;
  entryId: string;
  lang: Lang;
  verdict: Verdict;
  text: string;
  was: string;
  who: string;
  at: string;
  check: { meaning: number; grammatical: number } | null;
  note: string;
};

export type DecisionFile = { version: number; updatedAt: string; decisions: DecisionRecord[] };

export const DECISIONS_VERSION = 1;

export const decisionKey = (entryId: string, lang: Lang): string => `${entryId}\u0000${lang}`;

export function loadDecisions(path: string): Map<string, DecisionRecord> {
  if (!existsSync(path)) return new Map();
  const raw = JSON.parse(readFileSync(path, "utf8")) as DecisionFile;
  if (raw.version !== DECISIONS_VERSION) {
    throw new Error(`${path} is decisions version ${raw.version}; this build reads ${DECISIONS_VERSION}`);
  }
  return new Map(raw.decisions.map((d) => [d.key, d]));
}

export function saveDecisions(path: string, decisions: Map<string, DecisionRecord>): void {
  const payload: DecisionFile = {
    version: DECISIONS_VERSION,
    updatedAt: new Date().toISOString(),
    decisions: [...decisions.values()].sort((a, b) => a.at.localeCompare(b.at)),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
}

const sameText = (a: string, b: string): boolean =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

export function changes(decisions: Iterable<DecisionRecord>): DecisionRecord[] {
  return [...decisions].filter(
    (d) => (d.verdict === "accept" || d.verdict === "edited") && d.text.trim() !== "" && !sameText(d.text, d.was),
  );
}

export function decisionStats(decisions: Map<string, DecisionRecord>) {
  const byVerdict = new Map<Verdict, number>();
  const byWho = new Map<string, number>();
  for (const d of decisions.values()) {
    byVerdict.set(d.verdict, (byVerdict.get(d.verdict) ?? 0) + 1);
    byWho.set(d.who, (byWho.get(d.who) ?? 0) + 1);
  }
  return {
    total: decisions.size,
    changed: changes(decisions.values()).length,
    byVerdict: [...byVerdict.entries()].sort((a, b) => b[1] - a[1]),
    byWho: [...byWho.entries()].sort((a, b) => b[1] - a[1]),
  };
}
