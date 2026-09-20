/**
 * Browser side of the Jev pipeline. Turns pending JevSpecs from the workbook
 * into batched /api/judge requests (one request per distinct source text, all
 * questions for that text fanned out inside it), streams the answers back into
 * the workbook cache and measures everything with performance.now().
 */
import { batchSpecs, jevKey, type JevSpec } from "../engine/jev.ts";
import type { JevValue, Value } from "../engine/values.ts";
import { choice, noul, score, type Answer, type JudgeLine, type Question } from "../../server/types.ts";

export const LLM_BASELINE_S_PER_CELL = 4;

export type RunStats = {
  active: boolean;
  startedAt: number;
  elapsedMs: number;
  cells: number;
  cellsDone: number;
  requests: number;
  requestsDone: number;
  errors: number;
  retries: number;
  cacheHits: number;
  latencies: number[];
  inputTokens: number;
  outputTokens: number;
};

export type Totals = { cells: number; requests: number; latencies: number[] };

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(lat: number[]) {
  const s = [...lat].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), min: s[0] ?? 0, max: s[s.length - 1] ?? 0 };
}

export function toQuestion(spec: JevSpec): Question {
  switch (spec.kind) {
    case "judge":
      return noul(spec.instructions);
    case "pick":
      return choice(spec.instructions, spec.options);
    case "rate":
      return score(spec.instructions, spec.options);
  }
}

export function answerToValue(spec: JevSpec, a: Answer): Value {
  if (spec.kind === "judge" && a.type === "noul") {
    const v: JevValue = { jev: "judge", value: a.noul, confidence: Math.abs(a.noul - 0.5) * 2 };
    return v;
  }
  if (spec.kind === "pick" && a.type === "choice") {
    const v: JevValue = {
      jev: "pick",
      value: a.choice,
      confidence: a.confidence,
      probabilities: a.probabilities,
      levels: spec.options,
    };
    return v;
  }
  if (spec.kind === "rate" && a.type === "score") {
    const v: JevValue = {
      jev: "rate",
      value: a.score,
      confidence: a.confidence,
      probabilities: a.probabilities,
      levels: spec.options,
    };
    return v;
  }
  return { error: "#JEV!", message: `unexpected answer type ${a.type} for ${spec.kind}` };
}

export const emptyRun = (): RunStats => ({
  active: false,
  startedAt: 0,
  elapsedMs: 0,
  cells: 0,
  cellsDone: 0,
  requests: 0,
  requestsDone: 0,
  errors: 0,
  retries: 0,
  cacheHits: 0,
  latencies: [],
  inputTokens: 0,
  outputTokens: 0,
});

type Resolve = (key: string, value: Value) => void;

export class JevRunner {
  run: RunStats = emptyRun();
  totals: Totals = { cells: 0, requests: 0, latencies: [] };
  private inflight = new Set<string>();
  private outstanding = 0;
  private onChange: () => void;
  private resolve: Resolve;
  lastError: string | null = null;

  constructor(resolve: Resolve, onChange: () => void) {
    this.resolve = resolve;
    this.onChange = onChange;
  }

  /** Submit the pending specs of one recalc tick. Returns the number of new requests fired. */
  submit(pending: JevSpec[], cacheHits = 0): number {
    const fresh = pending.filter((s) => !this.inflight.has(jevKey(s)));
    if (!this.run.active) {
      this.run = emptyRun();
      this.run.active = true;
      this.run.startedAt = performance.now();
    }
    this.run.cacheHits += cacheHits;
    if (fresh.length === 0) {
      if (this.outstanding === 0) this.finish();
      this.onChange();
      return 0;
    }
    for (const s of fresh) this.inflight.add(jevKey(s));
    const batches = batchSpecs(fresh);
    this.run.cells += fresh.length;
    this.run.requests += batches.length;
    this.totals.cells += fresh.length;
    this.totals.requests += batches.length;
    this.outstanding++;
    void this.post(batches).finally(() => {
      this.outstanding--;
      if (this.outstanding === 0) this.finish();
      this.onChange();
    });
    this.onChange();
    return batches.length;
  }

  private finish() {
    this.run.active = false;
    this.run.elapsedMs = performance.now() - this.run.startedAt;
  }

  private async post(batches: { text: string; specs: JevSpec[] }[]) {
    const requests = batches.map((b, i) => ({
      id: String(i),
      state: b.text,
      questions: Object.fromEntries(b.specs.map((s, j) => [String(j), toQuestion(s)])),
    }));
    let res: Response;
    try {
      res = await fetch("/api/judge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests }),
      });
    } catch (e) {
      this.failAll(batches, `network error: ${(e as Error).message}`);
      return;
    }
    if (!res.ok || !res.body) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      this.failAll(batches, msg);
      return;
    }
    this.lastError = null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.handleLine(batches, JSON.parse(line) as JudgeLine);
      }
    }
    // Anything the server never answered (connection dropped) gets an error.
    for (const b of batches) {
      for (const s of b.specs) {
        const k = jevKey(s);
        if (this.inflight.has(k)) {
          this.inflight.delete(k);
          this.resolve(k, { error: "#JEV!", message: "no answer" });
        }
      }
    }
  }

  private handleLine(batches: { text: string; specs: JevSpec[] }[], line: JudgeLine) {
    if ("done" in line) return;
    const batch = batches[Number(line.id)];
    if (!batch) return;
    this.run.requestsDone++;
    this.run.cellsDone += batch.specs.length;
    if ("error" in line) {
      this.run.errors++;
      this.lastError = line.error;
      for (const s of batch.specs) {
        this.inflight.delete(jevKey(s));
        this.resolve(jevKey(s), { error: "#JEV!", message: line.error });
      }
    } else {
      this.run.latencies.push(line.ms);
      this.run.retries += Math.max(0, line.attempts - 1);
      this.totals.latencies.push(line.ms);
      if (line.usage) {
        this.run.inputTokens += line.usage.input_tokens;
        this.run.outputTokens += line.usage.output_tokens;
      }
      batch.specs.forEach((s, j) => {
        this.inflight.delete(jevKey(s));
        const a = line.answers[String(j)];
        this.resolve(jevKey(s), a ? answerToValue(s, a) : { error: "#JEV!", message: "missing answer" });
      });
    }
    this.onChange();
  }

  private failAll(batches: { text: string; specs: JevSpec[] }[], msg: string) {
    this.lastError = msg;
    for (const b of batches) {
      this.run.requestsDone++;
      this.run.cellsDone += b.specs.length;
      this.run.errors++;
      for (const s of b.specs) {
        this.inflight.delete(jevKey(s));
        this.resolve(jevKey(s), { error: "#JEV!", message: msg });
      }
    }
    this.onChange();
  }
}
