/**
 * Glue between the pure Workbook, the Jev batcher and React. One recalc tick
 * per animation frame: evaluate dirty cells, hand the pending judgments to the
 * runner, bump a version so subscribed components re-render.
 */
import { Workbook } from "../engine/workbook.ts";
import { cellKey, parseKey } from "../engine/refs.ts";
import { shiftFormula } from "../engine/parser.ts";
import { buildWorkbook, SEED_PREDICTIONS } from "../data/workbook.ts";
import { JevRunner } from "./jevClient.ts";
import { formulaFor, type Schema } from "./predict.ts";

const MIN_PREDICTED_COL_W = 170;

export type Prediction = {
  sheet: string;
  col: number;
  textCol: number;
  header: string;
  schema: Schema;
  rows: number;
  accepted: boolean;
  startedAt: number;
  /** Elapsed ms of the Jev burst this prediction triggered, once it finished. */
  elapsedMs: number | null;
  cells: number;
  requests: number;
  latencies: number[];
};

export type Health = { ok: boolean; mode: "live" | "mock" | "nokey" | "offline"; model: string; concurrency: number };

export class Store {
  wb: Workbook;
  runner: JevRunner;
  version = 0;
  health: Health = { ok: false, mode: "offline", model: "jev-latest", concurrency: 0 };
  lastTick = { evaluated: 0, pending: 0, requests: 0, cacheHits: 0 };
  predictions = new Map<string, Prediction>();
  private listeners = new Set<() => void>();
  private scheduled = false;

  constructor() {
    this.wb = buildWorkbook();
    for (const p of SEED_PREDICTIONS) {
      this.predictions.set(this.predKey(p.sheet, p.col), {
        ...p,
        accepted: true,
        startedAt: 0,
        elapsedMs: null,
        cells: 0,
        requests: 0,
        latencies: [],
      });
    }
    this.runner = new JevRunner(
      (key, value) => {
        this.wb.resolveJev(key, value);
        this.schedule();
      },
      () => {
        const run = this.runner.run;
        if (!run.active && this.wasActive) {
          for (const p of this.predictions.values()) {
            if (p.elapsedMs !== null) continue;
            p.elapsedMs = run.elapsedMs;
            p.cells = run.cells;
            p.requests = run.requests;
            p.latencies = run.latencies.slice();
          }
        }
        this.wasActive = run.active;
        this.emit();
      },
    );
  }
  private wasActive = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getVersion = () => this.version;

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.tick();
    });
  }

  tick() {
    const r = this.wb.recalc();
    const requests = r.pending.length ? this.runner.submit(r.pending, r.cacheHits) : 0;
    this.lastTick = { evaluated: r.evaluated, pending: r.pending.length, requests, cacheHits: r.cacheHits };
    if (!this.runner.run.active) {
      // nothing left to ask Jev: every cell of a fresh prediction came from the cache
      for (const p of this.predictions.values()) if (p.elapsedMs === null) p.elapsedMs = 0;
    }
    this.emit();
  }

  private predKey(sheet: string, col: number) {
    return `${sheet}:${col}`;
  }
  prediction(sheet: string, col: number): Prediction | undefined {
    return this.predictions.get(this.predKey(sheet, col));
  }
  /** The newest prediction on a sheet that the user has not accepted or dismissed yet. */
  openPrediction(sheet: string): Prediction | undefined {
    let best: Prediction | undefined;
    for (const p of this.predictions.values())
      if (p.sheet === sheet && !p.accepted && (!best || p.startedAt > best.startedAt)) best = p;
    return best;
  }

  /**
   * The column of free text a predicted column reads from: the column left of
   * `col` with the longest average text (skipping other predicted columns).
   */
  findTextColumn(sheet: string, col: number): number {
    const sh = this.wb.getSheet(sheet);
    const len = new Map<number, { sum: number; n: number }>();
    for (const [k, cell] of sh.cells) {
      const p = parseKey(k);
      if (p.row === 0 || p.col >= col || cell.raw.startsWith("=")) continue;
      const e = len.get(p.col) ?? { sum: 0, n: 0 };
      e.sum += cell.raw.length;
      e.n++;
      len.set(p.col, e);
    }
    let best = -1;
    let bestAvg = 0;
    for (const [c, e] of len) {
      const avg = e.sum / e.n;
      if (avg > bestAvg) {
        bestAvg = avg;
        best = c;
      }
    }
    return best;
  }

  /** Whether typing a header in row 0 of `col` should predict the column. */
  isPredictable(sheet: string, col: number): boolean {
    if (this.prediction(sheet, col)) return true;
    if (this.findTextColumn(sheet, col) < 0) return false;
    for (const k of this.wb.getSheet(sheet).cells.keys()) {
      const p = parseKey(k);
      if (p.col === col && p.row > 0) return false;
    }
    return true;
  }

  sampleTexts(sheet: string, textCol: number, n = 3): string[] {
    const out: string[] = [];
    for (let r = 1; out.length < n && r < 50; r++) {
      const t = this.wb.getRaw(sheet, r, textCol);
      if (t) out.push(t);
    }
    return out;
  }

  /** Fill `col` with the schema's formula for every row of the text column. */
  predictColumn(sheet: string, col: number, header: string, schema: Schema): Prediction {
    const prev = this.prediction(sheet, col);
    const textCol = prev?.textCol ?? this.findTextColumn(sheet, col);
    const last = this.lastUsedRowIn(sheet, textCol);
    let changed = 0;
    for (let r = 1; r <= last; r++) {
      const raw = this.wb.getRaw(sheet, r, textCol) ? formulaFor(schema, header, textCol, r) : "";
      if (this.wb.getRaw(sheet, r, col) !== raw) {
        this.wb.setCell(sheet, r, col, raw);
        changed++;
      }
    }
    const pred: Prediction = {
      sheet,
      col,
      textCol,
      header,
      schema,
      rows: last,
      accepted: false,
      startedAt: performance.now(),
      elapsedMs: null,
      cells: 0,
      requests: 0,
      latencies: [],
    };
    if (changed === 0 && prev) pred.elapsedMs = 0;
    const sh = this.wb.getSheet(sheet);
    if ((sh.colWidths.get(col) ?? 0) < MIN_PREDICTED_COL_W) sh.colWidths.set(col, MIN_PREDICTED_COL_W);
    this.predictions.set(this.predKey(sheet, col), pred);
    this.schedule();
    return pred;
  }

  acceptPrediction(sheet: string, col: number) {
    const p = this.prediction(sheet, col);
    if (p) p.accepted = true;
    this.emit();
  }

  dismissPrediction(sheet: string, col: number) {
    const p = this.prediction(sheet, col);
    if (!p) return;
    for (let r = 1; r <= p.rows; r++) if (this.wb.getRaw(sheet, r, col)) this.wb.setCell(sheet, r, col, "");
    this.predictions.delete(this.predKey(sheet, col));
    this.schedule();
  }

  clearPrediction(sheet: string, col: number) {
    this.predictions.delete(this.predKey(sheet, col));
  }

  setCell(sheet: string, row: number, col: number, raw: string) {
    this.wb.setCell(sheet, row, col, raw);
    this.schedule();
  }

  /** Copy the formula/value of (row, col) down through `toRow`, shifting relative refs. */
  fillDown(sheet: string, row: number, col: number, toRow: number) {
    const src = this.wb.getRaw(sheet, row, col);
    let n = 0;
    for (let r = row + 1; r <= toRow; r++) {
      const raw = src.startsWith("=") ? shiftFormula(src, r - row, 0) : src;
      if (this.wb.getRaw(sheet, r, col) !== raw) {
        this.wb.setCell(sheet, r, col, raw);
        n++;
      }
    }
    this.schedule();
    return n;
  }

  /** Last row that holds any content in the sheet (0 if empty). */
  lastUsedRow(sheet: string): number {
    let max = 0;
    for (const k of this.wb.getSheet(sheet).cells.keys()) {
      const { row } = parseKey(k);
      if (row > max) max = row;
    }
    return max;
  }

  /** Last row with content in a specific column. */
  lastUsedRowIn(sheet: string, col: number): number {
    let max = -1;
    for (const k of this.wb.getSheet(sheet).cells.keys()) {
      const p = parseKey(k);
      if (p.col === col && p.row > max) max = p.row;
    }
    return max;
  }

  /** Forget every cached judgment used by a sheet so it re-asks Jev. */
  rejudgeSheet(sheet: string) {
    const keys = new Set<string>();
    for (const cell of this.wb.getSheet(sheet).cells.values()) for (const k of cell.jevKeys) keys.add(k);
    this.wb.invalidateJev(keys);
    this.schedule();
  }

  jevCellCount(sheet: string): number {
    let n = 0;
    for (const cell of this.wb.getSheet(sheet).cells.values()) if (cell.jevKeys.size) n++;
    return n;
  }

  setColWidth(sheet: string, col: number, width: number) {
    this.wb.getSheet(sheet).colWidths.set(col, Math.max(40, Math.round(width)));
    this.emit();
  }

  async fetchHealth() {
    try {
      const res = await fetch("/api/health");
      const j = (await res.json()) as Health;
      this.health = { ...j, ok: true };
    } catch {
      this.health = { ok: false, mode: "offline", model: "jev-latest", concurrency: 0 };
    }
    this.emit();
  }

  key(sheet: string, row: number, col: number) {
    return cellKey(sheet, row, col);
  }
}
