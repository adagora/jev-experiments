export type Primitive = number | string | boolean | null;

export type ErrorCode = "#VALUE!" | "#DIV/0!" | "#NAME?" | "#REF!" | "#CYCLE!" | "#N/A" | "#PENDING" | "#JEV!";
export type ErrorValue = { error: ErrorCode; message?: string };

export type JevKind = "judge" | "pick" | "rate";

/** A judgment returned by Jev, rich enough for the grid to draw heat/confidence. */
export type JevValue = {
  jev: JevKind;
  value: number | string;
  /** Choice/Score confidence (0..1). For JUDGE this is |p - 0.5| * 2. */
  confidence: number;
  probabilities?: Record<string, number>;
  levels?: string[];
};

export type Value = Primitive | ErrorValue | JevValue;
export type RangeValue = Value[][];

export const PENDING: ErrorValue = { error: "#PENDING" };

export const isError = (v: unknown): v is ErrorValue =>
  typeof v === "object" && v !== null && "error" in v;
export const isJev = (v: unknown): v is JevValue => typeof v === "object" && v !== null && "jev" in v;
export const isPending = (v: unknown): boolean => isError(v) && v.error === "#PENDING";

export const err = (error: ErrorCode, message?: string): ErrorValue => ({ error, message });

/** Collapse a rich value into the primitive that operators and functions use. */
export function prim(v: Value): Primitive | ErrorValue {
  return isJev(v) ? v.value : v;
}

export function toNumber(v: Value): number | ErrorValue {
  const p = prim(v);
  if (isError(p)) return p;
  if (p === null) return 0;
  if (typeof p === "number") return p;
  if (typeof p === "boolean") return p ? 1 : 0;
  const trimmed = p.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed);
  if (Number.isNaN(n)) return err("#VALUE!", `"${p}" is not a number`);
  return trimmed.endsWith("%") ? n / 100 : n;
}

export function toText(v: Value): string | ErrorValue {
  const p = prim(v);
  if (isError(p)) return p;
  if (p === null) return "";
  if (typeof p === "boolean") return p ? "TRUE" : "FALSE";
  if (typeof p === "number") return formatNumber(p);
  return p;
}

export function toBool(v: Value): boolean | ErrorValue {
  const p = prim(v);
  if (isError(p)) return p;
  if (p === null) return false;
  if (typeof p === "boolean") return p;
  if (typeof p === "number") return p !== 0;
  const u = p.trim().toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  return err("#VALUE!", `"${p}" is not a boolean`);
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 3;
  return n.toFixed(digits).replace(/\.?0+$/, "");
}
