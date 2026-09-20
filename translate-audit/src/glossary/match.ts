import { containsTerm, fold } from "../util/text.ts";

export const tokensOf = (folded: string): string[] => folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export class TermIndex<T> {
  private byFirstWord = new Map<string, { term: string; value: T }[]>();
  readonly size: number;

  constructor(terms: Iterable<readonly [string, T]>) {
    let n = 0;
    for (const [term, value] of terms) {
      const first = tokensOf(term)[0];
      if (!first) continue;
      const list = this.byFirstWord.get(first);
      if (list) list.push({ term, value });
      else this.byFirstWord.set(first, [{ term, value }]);
      n++;
    }
    this.size = n;
  }

  matches(source: string): { term: string; value: T }[] {
    const folded = fold(source);
    const out: { term: string; value: T }[] = [];
    const seen = new Set<string>();
    for (const token of tokensOf(folded)) {
      const candidates = this.byFirstWord.get(token);
      if (!candidates) continue;
      for (const c of candidates) {
        if (seen.has(c.term)) continue;
        if (containsTerm(folded, c.term)) {
          seen.add(c.term);
          out.push(c);
        }
      }
    }
    return out;
  }

  matchingTerms(source: string): string[] {
    return this.matches(source).map((m) => m.term);
  }
}

export function indexByTerm<T>(items: T[], termOf: (item: T) => string): TermIndex<T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const t = termOf(item);
    const list = grouped.get(t);
    if (list) list.push(item);
    else grouped.set(t, [item]);
  }
  return new TermIndex(grouped);
}
