import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Coverage } from "../types.ts";
import type { Policy, Profile, SubstitutionGates } from "../config/profile.ts";
import type { Envelope } from "../report/envelope.ts";

/**
 * What every run and every measurement produced, kept.
 *
 * `score` printed precision, recall and a reliability diagram, and then the numbers
 * evaporated into scrollback — so *"did that change help?"* could only be answered by
 * re-measuring the past, which nobody does, so regressions were invisible across
 * sessions. A row per run makes the question a diff of two rows.
 *
 * Append-only, like the evidence store, and for the same reason: nothing that is already
 * true about a past run should ever be rewritten.
 */
export type LedgerEntry = {
  id: string;
  at: string;
  command: string;
  /** Everything that decides what the numbers mean. */
  questions: string;
  model: string;
  domain: string;
  policy: Policy;
  gates: SubstitutionGates;
  configuredBy: string[];
  corpus: string;
  keys: number;
  coverage?: Coverage;
  cost?: { requests: number; judgments: number; errors: number; usd: number; wallMs: number };
  counts: Record<string, number | string>;
  /** The numbers a change is judged by. Absent for `run`, which measures nothing. */
  measurements?: Record<string, number>;
  outputs?: Record<string, string>;
};

export const DEFAULT_LEDGER = "runs/ledger.jsonl";

/**
 * Built from the envelope the command already returns, so the ledger cannot record
 * something different from what the command reported.
 */
export function entryFrom(
  e: Envelope,
  profile: Profile,
  extra: { corpus: string; keys: number; measurements?: Record<string, number> },
): LedgerEntry {
  return {
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    command: e.command,
    questions: String(e.inputs.questions ?? "unknown"),
    model: profile.model,
    domain: profile.domain,
    policy: profile.policy,
    gates: profile.gates,
    configuredBy: profile.sources,
    corpus: extra.corpus,
    keys: extra.keys,
    coverage: e.coverage,
    cost: e.cost
      ? {
          requests: e.cost.requests,
          judgments: e.cost.judgments,
          errors: e.cost.errors,
          usd: Number(e.cost.usd.toFixed(4)),
          wallMs: Math.round(e.cost.wallMs),
        }
      : undefined,
    counts: e.counts ?? {},
    measurements: extra.measurements,
    outputs: e.outputs,
  };
}

export function appendLedger(path: string, entry: LedgerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // A truncated final write costs that line and nothing else.
    }
  }
  return out;
}

export const findEntry = (rows: LedgerEntry[], ref: string): LedgerEntry | undefined =>
  rows.find((r) => r.id === ref) ?? (/^-?\d+$/.test(ref) ? rows.at(Number(ref)) : undefined);

export type LedgerDiff = {
  left: LedgerEntry;
  right: LedgerEntry;
  /** Only what actually differs, so the cause of a change is not buried in what did not. */
  configChanged: [string, string, string][];
  measurements: [string, number | undefined, number | undefined, number | undefined][];
};

const flatPolicy = (e: LedgerEntry): Record<string, unknown> => ({
  questions: e.questions,
  model: e.model,
  domain: e.domain,
  corpus: e.corpus,
  keys: e.keys,
  ...Object.fromEntries(Object.entries(e.policy).map(([k, v]) => [`policy.${k}`, v])),
  ...Object.fromEntries(Object.entries(e.gates).map(([k, v]) => [`gates.${k}`, v])),
});

/**
 * What changed between two recorded runs, and what it did to the numbers.
 *
 * The point is attribution: a measurement that moved beside a configuration that did not
 * is noise, and a measurement that moved beside exactly one changed threshold is a result.
 */
export function diffEntries(left: LedgerEntry, right: LedgerEntry): LedgerDiff {
  const a = flatPolicy(left);
  const b = flatPolicy(right);
  const configChanged: [string, string, string][] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    configChanged.push([k, String(a[k] ?? "—"), String(b[k] ?? "—")]);
  }
  configChanged.sort((x, y) => x[0].localeCompare(y[0]));

  const keys = new Set([...Object.keys(left.measurements ?? {}), ...Object.keys(right.measurements ?? {})]);
  const measurements = [...keys].sort().map((k) => {
    const l = left.measurements?.[k];
    const r = right.measurements?.[k];
    const delta = l !== undefined && r !== undefined ? Number((r - l).toFixed(4)) : undefined;
    return [k, l, r, delta] as [string, number | undefined, number | undefined, number | undefined];
  });

  return { left, right, configChanged, measurements };
}
