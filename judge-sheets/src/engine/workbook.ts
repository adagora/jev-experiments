import { parseFormula, type Node } from "./parser.ts";
import { evaluate } from "./evaluator.ts";
import { cellKey, parseKey } from "./refs.ts";
import { JevCache, jevKey, type JevSpec } from "./jev.ts";
import { type Value, PENDING, err, isPending } from "./values.ts";

export type Cell = {
  raw: string;
  ast: Node | null;
  parseError: string | null;
  value: Value;
  /** Cells this cell reads directly. */
  precedents: Set<string>;
  /** Ranges this cell reads (sheet, r1, c1, r2, c2). */
  ranges: RangeDep[];
  /** Jev cache keys this cell's value came from / is waiting on. */
  jevKeys: Set<string>;
};

export type RangeDep = { sheet: string; r1: number; c1: number; r2: number; c2: number };

export type Sheet = {
  name: string;
  rows: number;
  cols: number;
  cells: Map<string, Cell>;
  colWidths: Map<number, number>;
};

export type RecalcResult = {
  evaluated: number;
  /** Judgments the engine needs but the cache does not have yet. */
  pending: JevSpec[];
  /** Cells whose value changed. */
  changed: Set<string>;
  /** Jev lookups served from the (text, question) cache during this tick. */
  cacheHits: number;
};

function parseLiteral(raw: string): Value {
  if (raw === "") return null;
  if (raw.startsWith("'")) return raw.slice(1);
  const t = raw.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  if (/^[+-]?(\d+\.?\d*|\.\d+)%$/.test(t)) return Number(t.slice(0, -1)) / 100;
  const u = t.toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  return raw;
}

function collectDeps(node: Node, sheet: string, precedents: Set<string>, ranges: RangeDep[]): void {
  switch (node.type) {
    case "ref":
      precedents.add(cellKey(node.sheet ?? sheet, node.row, node.col));
      return;
    case "range":
      ranges.push({
        sheet: node.sheet ?? sheet,
        r1: Math.min(node.start.row, node.end.row),
        c1: Math.min(node.start.col, node.end.col),
        r2: Math.max(node.start.row, node.end.row),
        c2: Math.max(node.start.col, node.end.col),
      });
      return;
    case "call":
      for (const a of node.args) collectDeps(a, sheet, precedents, ranges);
      return;
    case "binary":
      collectDeps(node.left, sheet, precedents, ranges);
      collectDeps(node.right, sheet, precedents, ranges);
      return;
    case "unary":
      collectDeps(node.operand, sheet, precedents, ranges);
      return;
    default:
      return;
  }
}

export class Workbook {
  sheets = new Map<string, Sheet>();
  cache = new JevCache();
  /** cellKey -> cells that reference it directly. */
  private dependents = new Map<string, Set<string>>();
  /** dependent cellKey -> ranges it reads. */
  private rangeDeps = new Map<string, RangeDep[]>();
  /** jevKey -> cells waiting on / derived from it. */
  private jevDependents = new Map<string, Set<string>>();
  private dirty = new Set<string>();
  /** Per-recalc memo of the cells evaluated so far. */
  private evaluating = new Set<string>();
  private pendingSpecs = new Map<string, JevSpec>();
  private cacheHits = 0;

  addSheet(name: string, rows: number, cols: number): Sheet {
    const sheet: Sheet = { name, rows, cols, cells: new Map(), colWidths: new Map() };
    this.sheets.set(name, sheet);
    return sheet;
  }

  getSheet(name: string): Sheet {
    const s = this.sheets.get(name);
    if (!s) throw new Error(`No sheet ${name}`);
    return s;
  }

  getCell(sheet: string, row: number, col: number): Cell | undefined {
    return this.sheets.get(sheet)?.cells.get(cellKey(sheet, row, col));
  }

  getValue(sheet: string, row: number, col: number): Value {
    return this.getCell(sheet, row, col)?.value ?? null;
  }

  getRaw(sheet: string, row: number, col: number): string {
    return this.getCell(sheet, row, col)?.raw ?? "";
  }

  /** Set a cell's raw text (formula if it starts with "="). Marks dependents dirty. */
  setCell(sheetName: string, row: number, col: number, raw: string): void {
    const sheet = this.getSheet(sheetName);
    const key = cellKey(sheetName, row, col);
    const old = sheet.cells.get(key);
    if (old) this.unlink(key, old);
    if (raw === "") {
      sheet.cells.delete(key);
      this.markDirty(key);
      return;
    }
    const cell: Cell = {
      raw,
      ast: null,
      parseError: null,
      value: null,
      precedents: new Set(),
      ranges: [],
      jevKeys: new Set(),
    };
    if (raw.startsWith("=") && raw.length > 1) {
      try {
        cell.ast = parseFormula(raw.slice(1));
        collectDeps(cell.ast, sheetName, cell.precedents, cell.ranges);
      } catch (e) {
        cell.parseError = e instanceof Error ? e.message : String(e);
      }
    } else {
      cell.value = parseLiteral(raw);
    }
    sheet.cells.set(key, cell);
    for (const p of cell.precedents) {
      let set = this.dependents.get(p);
      if (!set) this.dependents.set(p, (set = new Set()));
      set.add(key);
    }
    if (cell.ranges.length) this.rangeDeps.set(key, cell.ranges);
    this.markDirty(key);
  }

  private unlink(key: string, cell: Cell): void {
    for (const p of cell.precedents) this.dependents.get(p)?.delete(key);
    this.rangeDeps.delete(key);
    for (const j of cell.jevKeys) this.jevDependents.get(j)?.delete(key);
  }

  /** Mark a cell and everything downstream of it dirty. */
  markDirty(key: string): void {
    if (this.dirty.has(key)) return;
    this.dirty.add(key);
    const direct = this.dependents.get(key);
    if (direct) for (const d of direct) this.markDirty(d);
    const { sheet, row, col } = parseKey(key);
    for (const [dep, ranges] of this.rangeDeps) {
      if (this.dirty.has(dep)) continue;
      for (const r of ranges) {
        if (r.sheet === sheet && row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2) {
          this.markDirty(dep);
          break;
        }
      }
    }
  }

  /** Cells that read a given Jev judgment. */
  cellsForJev(key: string): Set<string> {
    return this.jevDependents.get(key) ?? new Set();
  }

  /** Called by the batcher when a judgment arrives; dependents become dirty. */
  resolveJev(key: string, value: Value): void {
    if (isPending(value)) return;
    this.cache.set(key, value as Parameters<JevCache["set"]>[1]);
    const cells = this.jevDependents.get(key);
    if (cells) for (const c of cells) this.markDirty(c);
  }

  /** Drop cached judgments so the next recalc re-asks Jev. */
  invalidateJev(keys?: Iterable<string>): void {
    const list = keys ? [...keys] : [...this.jevDependents.keys()];
    for (const k of list) {
      this.cache.delete(k);
      const cells = this.jevDependents.get(k);
      if (cells) for (const c of cells) this.markDirty(c);
    }
  }

  get dirtyCount(): number {
    return this.dirty.size;
  }

  /** Evaluate every dirty cell (and only those). Returns the judgments still needed. */
  recalc(): RecalcResult {
    const changed = new Set<string>();
    this.pendingSpecs.clear();
    this.cacheHits = 0;
    const todo = [...this.dirty];
    let evaluated = 0;
    for (const key of todo) {
      if (!this.dirty.has(key)) continue;
      this.evalCell(key, changed);
      evaluated++;
    }
    this.dirty.clear();
    this.evaluating.clear();
    return { evaluated, pending: [...this.pendingSpecs.values()], changed, cacheHits: this.cacheHits };
  }

  private evalCell(key: string, changed: Set<string>): Value {
    const { sheet: sheetName } = parseKey(key);
    const cell = this.sheets.get(sheetName)?.cells.get(key);
    if (!cell) {
      this.dirty.delete(key);
      changed.add(key);
      return null;
    }
    if (!this.dirty.has(key)) return cell.value;
    if (this.evaluating.has(key)) return err("#CYCLE!");
    this.evaluating.add(key);

    let value: Value;
    if (cell.parseError) value = err("#NAME?", cell.parseError);
    else if (!cell.ast) value = parseLiteral(cell.raw);
    else {
      for (const j of cell.jevKeys) this.jevDependents.get(j)?.delete(key);
      cell.jevKeys.clear();
      value = evaluate(cell.ast, {
        getCell: (s, r, c) => {
          const target = s ?? sheetName;
          if (!this.sheets.has(target)) return err("#REF!", `No sheet ${target}`);
          const k = cellKey(target, r, c);
          if (this.dirty.has(k)) return this.evalCell(k, changed);
          return this.sheets.get(target)!.cells.get(k)?.value ?? null;
        },
        jev: (spec) => {
          const k = jevKey(spec);
          cell.jevKeys.add(k);
          let set = this.jevDependents.get(k);
          if (!set) this.jevDependents.set(k, (set = new Set()));
          set.add(key);
          const hit = this.cache.get(k);
          if (hit) {
            this.cacheHits++;
            return hit;
          }
          this.pendingSpecs.set(k, spec);
          return PENDING;
        },
      });
    }
    if (JSON.stringify(cell.value) !== JSON.stringify(value)) changed.add(key);
    cell.value = value;
    this.dirty.delete(key);
    this.evaluating.delete(key);
    return value;
  }
}
