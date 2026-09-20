import {
  type Value,
  type Primitive,
  type ErrorValue,
  isError,
  isPending,
  err,
  prim,
  toNumber,
  toText,
  toBool,
} from "./values.ts";

/** A function argument is either a scalar value or a 2-D range. */
export type Arg = Value | Value[][];

const isRange = (a: Arg): a is Value[][] => Array.isArray(a);

function flatten(args: Arg[]): Value[] {
  const out: Value[] = [];
  for (const a of args) {
    if (isRange(a)) for (const row of a) for (const v of row) out.push(v);
    else out.push(a);
  }
  return out;
}

/**
 * Numbers for aggregates. Blanks, text and *pending Jev cells* are skipped so
 * summary blocks update live while a column is still being judged.
 */
function numbers(args: Arg[]): number[] | ErrorValue {
  const out: number[] = [];
  for (const v of flatten(args)) {
    if (isPending(v)) continue;
    if (isError(v)) return v;
    const p = prim(v);
    if (typeof p === "number") out.push(p);
    else if (typeof p === "boolean") out.push(p ? 1 : 0);
  }
  return out;
}

function scalar(a: Arg): Value {
  return isRange(a) ? (a[0]?.[0] ?? null) : a;
}

function num(a: Arg): number | ErrorValue {
  return toNumber(scalar(a));
}

/** COUNTIF-style criterion: ">0.5", "<>quality", "=HOT", "qual*", 3, TRUE. */
export function makeCriterion(crit: Value): (v: Value) => boolean {
  const p = prim(crit);
  if (isError(p)) return () => false;
  if (typeof p === "string") {
    const m = /^(<>|>=|<=|=|<|>)(.*)$/.exec(p);
    if (m) {
      const [, op, rhsText] = m;
      const rhsNum = rhsText.trim() === "" ? NaN : Number(rhsText);
      return (v) => {
        const x = prim(v);
        if (isError(x)) return false;
        if (!Number.isNaN(rhsNum)) {
          const n = typeof x === "number" ? x : typeof x === "boolean" ? (x ? 1 : 0) : typeof x === "string" && x.trim() !== "" && !Number.isNaN(Number(x)) ? Number(x) : null;
          if (n === null) return op === "<>";
          switch (op) {
            case ">": return n > rhsNum;
            case "<": return n < rhsNum;
            case ">=": return n >= rhsNum;
            case "<=": return n <= rhsNum;
            case "=": return n === rhsNum;
            default: return n !== rhsNum;
          }
        }
        const s = x === null ? "" : String(toText(x)).toLowerCase();
        const eq = s === rhsText.toLowerCase();
        return op === "<>" ? !eq : op === "=" ? eq : false;
      };
    }
    const rx = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
    return (v) => {
      const x = prim(v);
      if (isError(x) || x === null) return false;
      return rx.test(String(toText(x)));
    };
  }
  return (v) => {
    const x = prim(v);
    if (isError(x)) return false;
    if (typeof p === "number") return typeof x === "number" ? x === p : Number(x) === p;
    if (typeof p === "boolean") return x === p;
    return x === null || x === "";
  };
}

type Fn = (args: Arg[]) => Value;

const wrapText = (f: (s: string) => Primitive): Fn => (args) => {
  const t = toText(scalar(args[0] ?? null));
  return isError(t) ? t : f(t);
};

export const FUNCTIONS: Record<string, Fn> = {
  SUM: (args) => {
    const ns = numbers(args);
    return isError(ns) ? ns : ns.reduce((a, b) => a + b, 0);
  },
  AVERAGE: (args) => {
    const ns = numbers(args);
    if (isError(ns)) return ns;
    if (ns.length === 0) return err("#DIV/0!");
    return ns.reduce((a, b) => a + b, 0) / ns.length;
  },
  MIN: (args) => {
    const ns = numbers(args);
    return isError(ns) ? ns : ns.length ? Math.min(...ns) : 0;
  },
  MAX: (args) => {
    const ns = numbers(args);
    return isError(ns) ? ns : ns.length ? Math.max(...ns) : 0;
  },
  COUNT: (args) => {
    const ns = numbers(args);
    return isError(ns) ? ns : ns.length;
  },
  COUNTA: (args) => flatten(args).filter((v) => !isPending(v) && prim(v) !== null && prim(v) !== "").length,
  COUNTIF: (args) => {
    if (args.length < 2) return err("#N/A", "COUNTIF(range, criterion)");
    const test = makeCriterion(scalar(args[1]));
    return flatten([args[0]]).filter((v) => !isPending(v) && test(v)).length;
  },
  SUMIF: (args) => {
    if (args.length < 2) return err("#N/A", "SUMIF(range, criterion, [sum_range])");
    const test = makeCriterion(scalar(args[1]));
    const range = isRange(args[0]) ? args[0] : [[args[0]]];
    const sumRange = args[2] !== undefined ? (isRange(args[2]) ? args[2] : [[args[2]]]) : range;
    let total = 0;
    range.forEach((row, r) =>
      row.forEach((v, c) => {
        if (isPending(v) || !test(v)) return;
        const n = toNumber(sumRange[r]?.[c] ?? null);
        if (!isError(n)) total += n;
      }),
    );
    return total;
  },
  IF: (args) => {
    if (args.length < 2) return err("#N/A", "IF(test, then, [else])");
    const c = toBool(scalar(args[0]));
    if (isError(c)) return c;
    return scalar(c ? args[1] : (args[2] ?? null));
  },
  AND: (args) => {
    for (const v of flatten(args)) {
      const b = toBool(v);
      if (isError(b)) return b;
      if (!b) return false;
    }
    return true;
  },
  OR: (args) => {
    for (const v of flatten(args)) {
      const b = toBool(v);
      if (isError(b)) return b;
      if (b) return true;
    }
    return false;
  },
  NOT: (args) => {
    const b = toBool(scalar(args[0] ?? null));
    return isError(b) ? b : !b;
  },
  LEN: wrapText((s) => s.length),
  UPPER: wrapText((s) => s.toUpperCase()),
  LOWER: wrapText((s) => s.toLowerCase()),
  TRIM: wrapText((s) => s.trim().replace(/\s+/g, " ")),
  CONCAT: (args) => {
    let out = "";
    for (const v of flatten(args)) {
      const t = toText(v);
      if (isError(t)) return t;
      out += t;
    }
    return out;
  },
  ROUND: (args) => {
    const n = num(args[0] ?? null);
    const d = args[1] === undefined ? 0 : num(args[1]);
    if (isError(n)) return n;
    if (isError(d)) return d;
    const f = 10 ** d;
    return Math.round(n * f) / f;
  },
  ABS: (args) => {
    const n = num(args[0] ?? null);
    return isError(n) ? n : Math.abs(n);
  },
  ISBLANK: (args) => prim(scalar(args[0] ?? null)) === null,
  ISNUMBER: (args) => typeof prim(scalar(args[0] ?? null)) === "number",
};

FUNCTIONS.CONCATENATE = FUNCTIONS.CONCAT;
