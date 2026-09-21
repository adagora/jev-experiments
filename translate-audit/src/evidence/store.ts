import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Answer, Question, SystemOneResponse } from "../jev/client.ts";

/**
 * Judgments, addressed by what they depend on.
 *
 * A judgment is a function of exactly three things: the model, the state and the
 * questions. Its address is their fingerprint. Four things follow, and each of them is
 * a cost the run cache could not avoid:
 *
 *   - a run that dies at 90% loses nothing; the next one asks only what it never got
 *   - rewording one question re-asks only the units that ask that question
 *   - re-running identical inputs costs nothing and can prove it
 *   - the fingerprint *is* the provenance
 *
 * The store is append-only. Nothing is ever rewritten, so a crash mid-write costs at
 * most the line being written, and two processes appending cannot corrupt each other's
 * records.
 */
export type EvidenceRecord = {
  fp: string;
  model: string;
  stage: string;
  /** A human-readable tag for the unit asked about, e.g. `key:4821` or `term:usun/de`. */
  unit: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
  ms: number;
  at: string;
  /** Only with `--keep-state`: the state as sent, for debugging a disagreement. */
  state?: unknown;
};

/**
 * Sorts object keys so that the same data fingerprints the same however it was built.
 * Arrays keep their order, because theirs is data.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = canonicalise((value as Record<string, unknown>)[k]);
  }
  return out;
}

/**
 * The address of a judgment.
 *
 * `state` is canonicalised, because it is data and its key order carries nothing.
 * `questions` are serialised exactly as they will be sent, because their order *is*
 * meaningful: a Choice's options are presented in order, and `probe` exists precisely to
 * ask the same question twice with the options reversed. Sorting them would hand the
 * second ask the first one's answer and silently destroy the measurement.
 *
 * The rule the whole store rests on: a miss is free, a false hit is a wrong answer.
 */
export function fingerprint(model: string, state: unknown, questions: Record<string, Question>): string {
  const payload = JSON.stringify({
    model,
    state: canonicalise(state),
    questions,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export class EvidenceStore {
  readonly path: string;
  private index = new Map<string, EvidenceRecord>();
  private keepState: boolean;
  hits = 0;
  misses = 0;
  appended = 0;
  /** Lines that could not be parsed — a truncated final write survives as one of these. */
  damaged = 0;

  private constructor(path: string, keepState: boolean) {
    this.path = path;
    this.keepState = keepState;
  }

  static open(path: string, opts: { keepState?: boolean } = {}): EvidenceStore {
    const store = new EvidenceStore(path, opts.keepState ?? false);
    if (!existsSync(path)) return store;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as EvidenceRecord;
        if (rec.fp) store.index.set(rec.fp, rec);
      } catch {
        store.damaged++;
      }
    }
    return store;
  }

  get size(): number {
    return this.index.size;
  }

  /** Marks a hit or a miss as it looks, so a run can report what it did not have to buy. */
  take(fp: string): EvidenceRecord | undefined {
    const hit = this.index.get(fp);
    if (hit) this.hits++;
    else this.misses++;
    return hit;
  }

  has(fp: string): boolean {
    return this.index.has(fp);
  }

  /** Every record, for estimating what a request of a given stage costs. */
  records(): Iterable<EvidenceRecord> {
    return this.index.values();
  }

  append(rec: EvidenceRecord, state?: unknown): void {
    const stored: EvidenceRecord = this.keepState && state !== undefined ? { ...rec, state } : rec;
    this.index.set(rec.fp, stored);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(stored) + "\n", "utf8");
    this.appended++;
  }

  /** What a cached record looks like coming back out, so callers need no special case. */
  static asResponse(rec: EvidenceRecord): SystemOneResponse {
    return { model: rec.model, answers: rec.answers, usage: rec.usage };
  }
}

/** Where a run keeps its evidence, given where it keeps everything else. */
export const evidencePathFor = (base: string): string =>
  `${base.replace(/\.xlsx$|\.run\.json$|\.json$/, "")}.evidence.jsonl`;
