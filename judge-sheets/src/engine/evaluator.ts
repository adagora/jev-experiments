import type { Node, RefNode } from "./parser.ts";
import { FUNCTIONS, type Arg } from "./functions.ts";
import {
  type Value,
  type JevKind,
  isError,
  err,
  prim,
  toNumber,
  toText,
} from "./values.ts";
import { splitOptions, type JevSpec } from "./jev.ts";

export type EvalContext = {
  /** Value of another cell (already evaluated, or PENDING/#CYCLE!). */
  getCell: (sheet: string | undefined, row: number, col: number) => Value;
  /** Ask the Jev cache; returns PENDING when the judgment is not available yet. */
  jev: (spec: JevSpec) => Value;
};

const JEV_FUNCS: Record<string, JevKind> = { JUDGE: "judge", PICK: "pick", RATE: "rate" };

const scalar = (a: Arg): Value => (Array.isArray(a) ? (a[0]?.[0] ?? null) : a);

export function evaluate(node: Node, ctx: EvalContext): Value {
  const v = evalNode(node, ctx);
  return Array.isArray(v) ? scalar(v) : v;
}

function evalNode(node: Node, ctx: EvalContext): Arg {
  switch (node.type) {
    case "num":
      return node.value;
    case "str":
      return node.value;
    case "bool":
      return node.value;
    case "ref":
      return ctx.getCell(node.sheet, node.row, node.col);
    case "range":
      return evalRange(node.start, node.end, node.sheet, ctx);
    case "unary": {
      const n = toNumber(scalar(evalNode(node.operand, ctx)));
      if (isError(n)) return n;
      return node.op === "-" ? -n : n;
    }
    case "binary":
      return binary(node.op, scalar(evalNode(node.left, ctx)), scalar(evalNode(node.right, ctx)));
    case "call": {
      const kind = JEV_FUNCS[node.name];
      if (kind) return jevCall(kind, node, ctx);
      const fn = FUNCTIONS[node.name];
      if (!fn) return err("#NAME?", `Unknown function ${node.name}`);
      return fn(node.args.map((a) => evalNode(a, ctx)));
    }
  }
}

function evalRange(start: RefNode, end: RefNode, sheet: string | undefined, ctx: EvalContext): Value[][] {
  const r1 = Math.min(start.row, end.row);
  const r2 = Math.max(start.row, end.row);
  const c1 = Math.min(start.col, end.col);
  const c2 = Math.max(start.col, end.col);
  const out: Value[][] = [];
  for (let r = r1; r <= r2; r++) {
    const row: Value[] = [];
    for (let c = c1; c <= c2; c++) row.push(ctx.getCell(sheet, r, c));
    out.push(row);
  }
  return out;
}

function jevCall(kind: JevKind, node: Node & { type: "call" }, ctx: EvalContext): Value {
  const argc = kind === "judge" ? 2 : 3;
  if (node.args.length < argc) {
    return err(
      "#N/A",
      kind === "judge"
        ? 'JUDGE(text, "yes/no question")'
        : kind === "pick"
          ? 'PICK(text, "instructions", "opt1|opt2|opt3")'
          : 'RATE(text, "instructions", "level0|level1|level2")',
    );
  }
  const raw = node.args.map((a) => scalar(evalNode(a, ctx)));
  for (const r of raw) if (isError(r)) return r;
  const text = toText(raw[0]);
  const instructions = toText(raw[1]);
  if (isError(text)) return text;
  if (isError(instructions)) return instructions;
  if (text.trim() === "") return null;
  if (instructions.trim() === "") return err("#VALUE!", "instructions are empty");
  let options: string[] = [];
  if (kind !== "judge") {
    const o = toText(raw[2]);
    if (isError(o)) return o;
    options = splitOptions(o);
    if (options.length < 2) return err("#VALUE!", 'need at least two options separated by "|"');
  }
  return ctx.jev({ kind, text, instructions, options });
}

function binary(op: string, l: Value, r: Value): Value {
  const lp = prim(l);
  const rp = prim(r);
  if (isError(lp)) return lp;
  if (isError(rp)) return rp;
  if (op === "&") {
    const a = toText(lp);
    const b = toText(rp);
    if (isError(a)) return a;
    if (isError(b)) return b;
    return a + b;
  }
  if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    return compare(op, lp, rp);
  }
  const a = toNumber(lp);
  const b = toNumber(rp);
  if (isError(a)) return a;
  if (isError(b)) return b;
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return b === 0 ? err("#DIV/0!") : a / b;
    case "^": return a ** b;
  }
  return err("#VALUE!", `Unknown operator ${op}`);
}

function compare(op: string, a: Value, b: Value): boolean {
  const ap = prim(a);
  const bp = prim(b);
  let cmp: number;
  if (typeof ap === "string" || typeof bp === "string") {
    const as = String(toText(ap ?? "")).toLowerCase();
    const bs = String(toText(bp ?? "")).toLowerCase();
    cmp = as < bs ? -1 : as > bs ? 1 : 0;
  } else {
    const an = toNumber(ap);
    const bn = toNumber(bp);
    const x = isError(an) ? 0 : an;
    const y = isError(bn) ? 0 : bn;
    cmp = x < y ? -1 : x > y ? 1 : 0;
  }
  switch (op) {
    case "=": return cmp === 0;
    case "<>": return cmp !== 0;
    case "<": return cmp < 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    default: return cmp >= 0;
  }
}
