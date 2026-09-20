export const PLACEHOLDER_RE =
  /\{\{[^{}]{0,60}\}\}|\{[^{}]{0,60}\}|\$\{[^{}]{0,60}\}|%\d+\$[sdf@]|%[sdf@]|_[A-Z][A-Z0-9_]{1,30}_|\[\[[^\]]{0,60}\]\]/g;

export const TAG_RE = /<\/?[a-zA-Z][^<>]{0,120}>/g;

export const norm = (s: string): string => s.normalize("NFC").replace(/\s+/g, " ").trim();

export const fold = (s: string): string =>
  norm(s)
    .toLocaleLowerCase("pl")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[ł]/g, "l");

export function multiset(s: string, re: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of s.normalize("NFC").matchAll(re)) out.set(m[0], (out.get(m[0]) ?? 0) + 1);
  return out;
}

export function multisetDiff(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    if (x !== y) out.push(`${k}: ${x}→${y}`);
  }
  return out.sort();
}

export const tagNames = (s: string): Map<string, number> => {
  const out = new Map<string, number>();
  for (const m of s.matchAll(TAG_RE)) {
    const name = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(m[0])?.[1]?.toLowerCase();
    if (!name) continue;
    const token = m[0].startsWith("</") ? `</${name}>` : `<${name}>`;
    out.set(token, (out.get(token) ?? 0) + 1);
  }
  return out;
};

export type CaseShape = "upper" | "lower" | "title" | "sentence" | "mixed";

export function caseShape(s: string): CaseShape {
  const letters = norm(s).replace(PLACEHOLDER_RE, " ").replace(TAG_RE, " ");
  const words = letters.split(/[^\p{L}]+/u).filter((w) => w.length > 1);
  if (words.length === 0) return "mixed";
  const hasLower = /\p{Ll}/u.test(letters);
  const hasUpper = /\p{Lu}/u.test(letters);
  if (!hasLower && hasUpper) return "upper";
  if (!hasUpper) return "lower";
  const capitalised = words.filter((w) => /^\p{Lu}/u.test(w)).length;
  if (capitalised === words.length) return "title";
  if (capitalised === 1 && /^\p{Lu}/u.test(words[0])) return "sentence";
  return "mixed";
}

export function terminalPunct(s: string): string {
  const t = norm(s).replace(PLACEHOLDER_RE, "").replace(TAG_RE, "").trim();
  const m = /([.:!?…])$/.exec(t);
  return m ? m[1] : "";
}

export function wordCount(s: string): number {
  return norm(s).replace(PLACEHOLDER_RE, " ").replace(TAG_RE, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
}

export function looksLikeIdentifier(s: string): boolean {
  const t = norm(s);
  if (!t || /\s/.test(t)) return false;
  if (/[_.~[\]/\\|]/.test(t)) return true;
  if (/\p{Ll}\p{Lu}/u.test(t)) return true;
  if (/\p{L}[-]?\d|\d[-]?\p{L}/u.test(t)) return true;
  return false;
}

export function containsTerm(haystackFolded: string, termFolded: string): boolean {
  if (!termFolded) return false;
  let from = 0;
  for (;;) {
    const i = haystackFolded.indexOf(termFolded, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : haystackFolded[i - 1];
    const after = haystackFolded[i + termFolded.length] ?? "";
    const boundary = (c: string) => c === "" || !/[\p{L}\p{N}]/u.test(c);
    if (boundary(before) && boundary(after)) return true;
    from = i + 1;
  }
}

export function replaceTerm(text: string, from: string, to: string): { text: string; count: number } {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=[^\\p{L}\\p{N}]|$)`, "giu");
  let count = 0;
  const out = text.replace(re, (_m, lead: string, hit: string) => {
    count++;
    return lead + matchCase(hit, to);
  });
  return { text: out, count };
}

export function matchCase(sample: string, replacement: string): string {
  const shape = caseShape(sample);
  if (shape === "upper") return replacement.toLocaleUpperCase();
  if (shape === "lower") return replacement.toLocaleLowerCase();
  if (shape === "title" || shape === "sentence") {
    return replacement.charAt(0).toLocaleUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export const foldHard = (s: string): string => fold(s).replace(/[^\p{L}\p{N}]+/gu, "");

export function triviallyEquivalent(texts: string[]): boolean {
  if (texts.length < 2) return true;
  const first = foldHard(texts[0]);
  return texts.every((t) => foldHard(t) === first);
}
