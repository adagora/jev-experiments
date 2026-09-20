import { colToName, parseA1 } from "./refs.ts";

export type Token =
  | { kind: "num"; value: number; text: string }
  | { kind: "str"; value: string; text: string }
  | { kind: "ident"; text: string }
  | { kind: "ref"; text: string; sheet?: string }
  | { kind: "op"; text: string }
  | { kind: "lparen" | "rparen" | "comma" | "colon"; text: string };

export type RefNode = {
  type: "ref";
  sheet?: string;
  row: number;
  col: number;
  absRow: boolean;
  absCol: boolean;
};

export type Node =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "bool"; value: boolean }
  | RefNode
  | { type: "range"; sheet?: string; start: RefNode; end: RefNode }
  | { type: "call"; name: string; args: Node[] }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "unary"; op: string; operand: Node };

export class ParseError extends Error {}

const OPS = ["<>", "<=", ">=", "+", "-", "*", "/", "^", "&", "=", "<", ">"];

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= src.length) throw new ParseError("Unterminated string");
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          break;
        }
        value += src[j++];
      }
      tokens.push({ kind: "str", value, text: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      // 'Sheet name'!A1
      const end = src.indexOf("'", i + 1);
      if (end < 0 || src[end + 1] !== "!") throw new ParseError("Bad sheet reference");
      const sheet = src.slice(i + 1, end);
      let j = end + 2;
      while (j < src.length && /[A-Za-z0-9$]/.test(src[j])) j++;
      const refText = src.slice(end + 2, j);
      if (!parseA1(refText)) throw new ParseError(`Bad reference ${refText}`);
      tokens.push({ kind: "ref", text: refText, sheet });
      i = j;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      if (/[eE]/.test(src[j] ?? "") && /[0-9+-]/.test(src[j + 1] ?? "")) {
        j += 2;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const text = src.slice(i, j);
      const value = Number(text);
      if (Number.isNaN(value)) throw new ParseError(`Bad number ${text}`);
      tokens.push({ kind: "num", value, text });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$.]/.test(src[j])) j++;
      let text = src.slice(i, j);
      if (src[j] === "!" ) {
        // Sheet!A1
        const sheet = text;
        let k = j + 1;
        while (k < src.length && /[A-Za-z0-9$]/.test(src[k])) k++;
        const refText = src.slice(j + 1, k);
        if (!parseA1(refText)) throw new ParseError(`Bad reference ${refText}`);
        tokens.push({ kind: "ref", text: refText, sheet });
        i = k;
        continue;
      }
      if (parseA1(text)) tokens.push({ kind: "ref", text });
      else {
        text = text.toUpperCase();
        tokens.push({ kind: "ident", text });
      }
      i = j;
      continue;
    }
    if (ch === "(") tokens.push({ kind: "lparen", text: ch });
    else if (ch === ")") tokens.push({ kind: "rparen", text: ch });
    else if (ch === "," || ch === ";") tokens.push({ kind: "comma", text: ch });
    else if (ch === ":") tokens.push({ kind: "colon", text: ch });
    else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) throw new ParseError(`Unexpected character ${ch}`);
      tokens.push({ kind: "op", text: op });
      i += op.length;
      continue;
    }
    i++;
  }
  return tokens;
}

const PREC: Record<string, number> = {
  "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1,
  "&": 2,
  "+": 3, "-": 3,
  "*": 4, "/": 4,
  "^": 5,
};

function toRef(tok: Token & { kind: "ref" }): RefNode {
  const p = parseA1(tok.text)!;
  return { type: "ref", sheet: tok.sheet, ...p };
}

/** Parse a formula body (without the leading "="). */
export function parseFormula(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr(minPrec = 0): Node {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (!t || t.kind !== "op" || PREC[t.text] === undefined || PREC[t.text] < minPrec) break;
      next();
      const prec = PREC[t.text];
      const right = parseExpr(t.text === "^" ? prec : prec + 1);
      left = { type: "binary", op: t.text, left, right };
    }
    return left;
  }

  function parseUnary(): Node {
    const t = peek();
    if (t && t.kind === "op" && (t.text === "-" || t.text === "+")) {
      next();
      return { type: "unary", op: t.text, operand: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): Node {
    const t = next();
    if (!t) throw new ParseError("Unexpected end of formula");
    switch (t.kind) {
      case "num":
        return { type: "num", value: t.value };
      case "str":
        return { type: "str", value: t.value };
      case "lparen": {
        const e = parseExpr();
        const close = next();
        if (!close || close.kind !== "rparen") throw new ParseError("Expected )");
        return e;
      }
      case "ref": {
        const start = toRef(t);
        if (peek()?.kind === "colon") {
          next();
          const e = next();
          if (!e || e.kind !== "ref") throw new ParseError("Expected range end");
          const end = toRef(e);
          return { type: "range", sheet: start.sheet, start, end };
        }
        return start;
      }
      case "ident": {
        if (t.text === "TRUE") return { type: "bool", value: true };
        if (t.text === "FALSE") return { type: "bool", value: false };
        const open = next();
        if (!open || open.kind !== "lparen") throw new ParseError(`Unknown name ${t.text}`);
        const args: Node[] = [];
        if (peek()?.kind === "rparen") {
          next();
          return { type: "call", name: t.text, args };
        }
        for (;;) {
          args.push(parseExpr());
          const sep = next();
          if (!sep) throw new ParseError("Expected )");
          if (sep.kind === "rparen") break;
          if (sep.kind !== "comma") throw new ParseError("Expected , or )");
        }
        return { type: "call", name: t.text, args };
      }
      default:
        throw new ParseError(`Unexpected ${t.text}`);
    }
  }

  const node = parseExpr();
  if (pos < tokens.length) throw new ParseError(`Unexpected ${tokens[pos].text}`);
  return node;
}

/** Shift every relative reference in a formula by (dRow, dCol) — used by fill-down. */
export function shiftFormula(src: string, dRow: number, dCol: number): string {
  const tokens = tokenize(src);
  return tokens
    .map((t) => {
      if (t.kind !== "ref") return t.text;
      const p = parseA1(t.text)!;
      const row = p.absRow ? p.row : p.row + dRow;
      const col = p.absCol ? p.col : p.col + dCol;
      if (row < 0 || col < 0) return "#REF!";
      const ref = `${p.absCol ? "$" : ""}${colToName(col)}${p.absRow ? "$" : ""}${row + 1}`;
      if (t.sheet) return /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.sheet) ? `${t.sheet}!${ref}` : `'${t.sheet}'!${ref}`;
      return ref;
    })
    .join("");
}
