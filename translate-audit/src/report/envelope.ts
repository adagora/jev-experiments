import type { Coverage } from "../types.ts";
import { completeness } from "../compose.ts";

/**
 * The one shape every command returns.
 *
 * The human text is `render`ed *from* this object rather than written beside it, so the
 * two cannot drift and the machine-readable path is the tested one rather than the
 * neglected one. Under `--json` the envelope is the whole of stdout; narration and
 * progress go to stderr, so a caller can always pipe stdout into a parser.
 */
export type Warning = { code: string; detail: string };

export type Table = {
  title: string;
  columns: string[];
  rows: (string | number)[][];
  /** Printed under the table, e.g. what the numbers mean. */
  note?: string;
};

/**
 * What the command spent.
 *
 * `requests` is what was *sent*, not what was asked about: a unit answered from the
 * evidence store made no request, waited for nothing and cost nothing, and it is counted
 * in `reused` instead. Every other field here is already about attempts only — `errors`,
 * `retries` and the latency percentiles all exclude reused units — so counting them as
 * requests was the one number in this object that described work nobody did. It is what
 * makes a warm run legible: `0 requests · 6,968 reused · $0.00`.
 *
 * The per-stage table keeps both, under `requests` (units attempted) and `reused`.
 */
export type Cost = {
  requests: number;
  reused: number;
  judgments: number;
  errors: number;
  retries: number;
  usd: number;
  wallMs: number;
  p50Ms: number;
  p95Ms: number;
};

export type Envelope = {
  ok: boolean;
  command: string;
  /** What the command was pointed at and configured by. */
  inputs: Record<string, unknown>;
  coverage?: Coverage;
  counts?: Record<string, number | string>;
  /** Ordered breakdowns: by severity, category, language, rule. */
  groups?: Record<string, [string, number][]>;
  tables?: Table[];
  cost?: Cost;
  /** Files written, by role. */
  outputs?: Record<string, string>;
  warnings: Warning[];
  /** What an operator would sensibly run next. Shell-ready. */
  next: string[];
};

export const envelope = (command: string, parts: Partial<Envelope> = {}): Envelope => ({
  ok: true,
  command,
  inputs: {},
  warnings: [],
  next: [],
  ...parts,
});

const PAD = "  ";

const fmtValue = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

export const fmtUsd = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

function renderTable(t: Table): string[] {
  const body = t.rows.map((r) => r.map((c) => String(c)));
  const widths = t.columns.map((c, i) => Math.max(c.length, ...body.map((r) => (r[i] ?? "").length)));
  const numeric = t.columns.map((_, i) => body.every((r) => r[i] === undefined || /^-?[\d.$%]+$/.test(r[i])));
  const line = (cells: string[]): string =>
    PAD + PAD + cells.map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ").trimEnd();

  const out = [`${PAD}${t.title}`, line(t.columns)];
  for (const r of body) out.push(line(r));
  if (t.note) out.push(`${PAD}${PAD}${t.note}`);
  return out;
}

/** The human view. Every line of it comes from the envelope above. */
export function render(e: Envelope): string {
  const out: string[] = [""];

  for (const [k, v] of Object.entries(e.inputs)) out.push(`${PAD}${k}  ${fmtValue(v)}`);
  if (Object.keys(e.inputs).length) out.push("");

  for (const w of e.warnings) out.push(`${PAD}! ${w.detail}`);
  if (e.warnings.length) out.push("");

  if (e.coverage && e.coverage.attempted > 0) {
    const c = e.coverage;
    const pct = (100 * completeness(c)).toFixed(1);
    out.push(
      c.failed > 0
        ? `${PAD}coverage ${pct}% — ${c.answered} of ${c.attempted} answered, ${c.failed} never came back. ` +
            `Counts below are a floor.`
        : `${PAD}coverage ${pct}% — ${c.answered} of ${c.attempted} answered` +
            (c.skipped ? `, ${c.skipped} skipped` : ""),
    );
    out.push("");
  }

  if (e.counts && Object.keys(e.counts).length) {
    const w = Math.max(...Object.keys(e.counts).map((k) => k.length));
    for (const [k, v] of Object.entries(e.counts)) out.push(`${PAD}${k.padEnd(w)}  ${v}`);
    out.push("");
  }

  for (const [title, rows] of Object.entries(e.groups ?? {})) {
    if (!rows.length) continue;
    out.push(`${PAD}${title}`);
    const w = Math.max(...rows.map(([k]) => k.length));
    for (const [k, n] of rows) out.push(`${PAD}${PAD}${k.padEnd(w)}  ${String(n).padStart(6)}`);
    out.push("");
  }

  for (const t of e.tables ?? []) {
    out.push(...renderTable(t));
    out.push("");
  }

  if (e.cost) {
    const c = e.cost;
    out.push(
      `${PAD}${c.requests} requests${c.reused ? ` · ${c.reused} reused` : ""} · ${c.judgments} judgments · ` +
        `${c.errors} errors · ${c.retries} retries`,
    );
    out.push(`${PAD}p50 ${c.p50Ms} ms · p95 ${c.p95Ms} ms · ${fmtMs(c.wallMs)} wall · ${fmtUsd(c.usd)}`);
    if (c.judgments > 0) {
      out.push(`${PAD}one LLM call per judgment at 3 s ≈ ${((c.judgments * 3) / 3600).toFixed(1)} h`);
    }
    out.push("");
  }

  for (const [role, path] of Object.entries(e.outputs ?? {})) out.push(`${PAD}→ ${path}   (${role})`);
  if (Object.keys(e.outputs ?? {}).length) out.push("");

  if (e.next.length) {
    out.push(`${PAD}next`);
    for (const n of e.next) out.push(`${PAD}${PAD}${n}`);
    out.push("");
  }

  return out.join("\n");
}

/** stdout carries the result and nothing else, so it can always be piped into a parser. */
export function emit(e: Envelope, asJson: boolean): void {
  process.stdout.write(asJson ? JSON.stringify(e, null, 2) + "\n" : render(e));
  if (!e.ok) process.exitCode = 1;
}

/** Narration during a command. Never stdout — that belongs to the envelope. */
export const note = (line = ""): void => void process.stderr.write(line + "\n");
