import { performance } from "node:perf_hooks";
import type { StageStats } from "../types.ts";
import { EvidenceStore, fingerprint } from "../evidence/store.ts";

export const TYPESAFE_URL = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1/systemone";
export const MODEL = process.env.JEV_MODEL ?? "jev-latest";


export type NoulQuestion = { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type SystemOneResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};

export const noul = (instructions: string, criteria?: NoulQuestion["criteria"]): NoulQuestion =>
  criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };

export const choice = (instructions: string, options: Record<string, string | null> | string[]): ChoiceQuestion => ({
  type: "choice",
  instructions,
  criteria: Array.isArray(options) ? Object.fromEntries(options.map((o) => [o, null])) : options,
});

export const score = (instructions: string, levels: string[]): ScoreQuestion => ({
  type: "score",
  instructions,
  criteria: levels,
});

export class JevError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type JevRequest<T> = {
  tag: T;
  state: unknown;
  questions: Record<string, Question>;
  /** A readable name for the unit, stored with the evidence. */
  unit?: string;
};
export type JevResult<T> =
  | { tag: T; answers: Record<string, Answer>; ms: number; attempts: number; usage: SystemOneResponse["usage"] }
  | { tag: T; error: string; status: number; ms: number };

export type ClientOptions = {
  apiKey: string;
  concurrency?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** From the profile. Defaults keep the env-derived values for callers that have no profile. */
  model?: string;
  baseUrl?: string;
  /** Judgments already bought. A hit costs nothing and is indistinguishable downstream. */
  evidence?: EvidenceStore | null;
};

export class JevClient {
  private apiKey: string;
  private maxAttempts: number;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  readonly model: string;
  readonly baseUrl: string;
  readonly evidence: EvidenceStore | null;
  concurrency: number;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.concurrency = opts.concurrency ?? Number(process.env.JEV_CONCURRENCY ?? 12);
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.JEV_TIMEOUT_MS ?? 20000);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.model = opts.model ?? MODEL;
    this.baseUrl = opts.baseUrl ?? TYPESAFE_URL;
    this.evidence = opts.evidence ?? null;
  }

  /**
   * One request, served from evidence when its fingerprint is already on disk.
   *
   * `stage` and `unit` only label the record; they are not part of the address, so
   * renaming a stage never invalidates a judgment.
   */
  async one(
    state: unknown,
    questions: Record<string, Question>,
    label: { stage: string; unit: string } = { stage: "one", unit: "" },
  ): Promise<{ response: SystemOneResponse; ms: number; attempts: number; reused: boolean }> {
    const fp = this.evidence ? fingerprint(this.model, state, questions) : null;
    if (fp && this.evidence) {
      const hit = this.evidence.take(fp);
      if (hit) return { response: EvidenceStore.asResponse(hit), ms: 0, attempts: 0, reused: true };
    }

    const t0 = performance.now();
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.baseUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ state, model: this.model, questions }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (attempt >= this.maxAttempts) throw new JevError(0, (e as Error).message);
        await sleep(Math.min(4000, 200 * 2 ** (attempt - 1)) + Math.random() * 100);
        continue;
      }
      if (res.ok) {
        const response = (await res.json()) as SystemOneResponse;
        const ms = performance.now() - t0;
        if (fp && this.evidence) {
          this.evidence.append(
            {
              fp,
              model: this.model,
              stage: label.stage,
              unit: label.unit,
              answers: response.answers,
              usage: response.usage ?? { input_tokens: 0, output_tokens: 0 },
              ms: Math.round(ms),
              at: new Date().toISOString(),
            },
            state,
          );
        }
        return { response, ms, attempts: attempt, reused: false };
      }
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      if (!retryable || attempt >= this.maxAttempts) throw new JevError(res.status, text || res.statusText);
      await sleep(Math.min(4000, 200 * 2 ** (attempt - 1)) + Math.random() * 100);
    }
  }

  async run<T>(
    name: string,
    requests: JevRequest<T>[],
    onResult: (r: JevResult<T>) => void,
    onProgress?: (done: number, total: number) => void,
  ): Promise<StageStats> {
    const stats: StageStats = {
      name,
      requests: requests.length,
      judgments: requests.reduce((n, r) => n + Object.keys(r.questions).length, 0),
      errors: 0,
      skipped: 0,
      reused: 0,
      retries: 0,
      wallMs: 0,
      latencies: [],
      inputTokens: 0,
      outputTokens: 0,
    };
    const t0 = performance.now();
    let next = 0;
    let done = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(this.concurrency, requests.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= requests.length) return;
        const req = requests[i];
        const started = performance.now();
        try {
          const { response, ms, attempts, reused } = await this.one(req.state, req.questions, {
            stage: name,
            unit: req.unit ?? "",
          });
          if (reused) {
            // Attempted and answered, but nothing was spent and nothing was waited for.
            stats.reused++;
          } else {
            stats.latencies.push(ms);
            stats.retries += attempts - 1;
            stats.inputTokens += response.usage?.input_tokens ?? 0;
            stats.outputTokens += response.usage?.output_tokens ?? 0;
          }
          onResult({ tag: req.tag, answers: response.answers, ms, attempts, usage: response.usage });
        } catch (e) {
          stats.errors++;
          const status = e instanceof JevError ? e.status : 0;
          onResult({ tag: req.tag, error: e instanceof Error ? e.message : String(e), status, ms: performance.now() - started });
        }
        onProgress?.(++done, requests.length);
      }
    });
    await Promise.all(lanes);
    stats.wallMs = performance.now() - t0;
    return stats;
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export const asNoul = (a: Answer | undefined): number | null => (a?.type === "noul" ? a.noul : null);
export const asChoice = (a: Answer | undefined): ChoiceAnswer | null => (a?.type === "choice" ? a : null);
export const asScore = (a: Answer | undefined): ScoreAnswer | null => (a?.type === "score" ? a : null);
