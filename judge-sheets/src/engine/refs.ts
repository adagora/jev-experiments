export type Addr = { row: number; col: number }; // 0-based

export function colToName(col: number): string {
  let s = "";
  let c = col;
  for (;;) {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
    if (c < 0) break;
  }
  return s;
}

export function nameToCol(name: string): number {
  let c = 0;
  for (const ch of name.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}

export const addrToA1 = (a: Addr): string => `${colToName(a.col)}${a.row + 1}`;

export const cellKey = (sheet: string, row: number, col: number): string => `${sheet}!${row}:${col}`;

export function parseKey(key: string): { sheet: string; row: number; col: number } {
  const bang = key.lastIndexOf("!");
  const [r, c] = key.slice(bang + 1).split(":");
  return { sheet: key.slice(0, bang), row: Number(r), col: Number(c) };
}

const A1_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;

export function parseA1(text: string): { row: number; col: number; absRow: boolean; absCol: boolean } | null {
  const m = A1_RE.exec(text);
  if (!m) return null;
  return { col: nameToCol(m[2]), row: Number(m[4]) - 1, absCol: m[1] === "$", absRow: m[3] === "$" };
}
