import type { Corpus, Entry, GlossaryEntry, Lang, TermConflict, Variant } from "./types.ts";
import { containsTerm, fold, looksLikeIdentifier, norm, triviallyEquivalent, wordCount } from "./util/text.ts";

export const MAX_TERM_WORDS = 4;
const STEM = 5;

export type MineResult = {
  conflicts: TermConflict[];
  resolved: GlossaryEntry[];
  agreed: Map<string, string>;
  termCount: number;
};

const vkey = (term: string, lang: Lang) => `${term}\u0000${lang}`;

function headStem(s: string): string {
  const tokens = fold(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
  if (tokens.length === 0) return "";
  const head = tokens.reduce((a, b) => (b.length > a.length ? b : a));
  return head.slice(0, STEM);
}

function isGlossaryTerm(source: string): boolean {
  const t = norm(source);
  if (t.length < 3 || wordCount(t) === 0 || wordCount(t) > MAX_TERM_WORDS) return false;
  if (looksLikeIdentifier(t)) return false;
  if (!/\p{L}{3}/u.test(t)) return false;
  return true;
}

export function mineGlossary(corpus: Corpus): MineResult {
  const termEntries = new Map<string, Entry[]>();
  for (const e of corpus.entries) {
    if (!isGlossaryTerm(e.source)) continue;
    const k = fold(e.source);
    const list = termEntries.get(k);
    if (list) list.push(e);
    else termEntries.set(k, [e]);
  }

  const conflicts: TermConflict[] = [];
  const resolved: GlossaryEntry[] = [];
  const agreed = new Map<string, string>();
  const variantsByTerm = new Map<string, Variant[]>();

  for (const [term, group] of termEntries) {
    for (const lang of corpus.langs) {
      if (lang === corpus.sourceLang) continue;
      const byText = new Map<string, string[]>();
      for (const e of group) {
        const v = norm(e.tr[lang] ?? "");
        if (!v) continue;
        const ids = byText.get(v);
        if (ids) ids.push(e.id);
        else byText.set(v, [e.id]);
      }
      if (byText.size === 0) continue;

      const variants: Variant[] = [...byText.entries()]
        .map(([text, ids]) => ({ text, count: ids.length, examples: ids.slice(0, 5) }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

      variantsByTerm.set(vkey(term, lang), variants);

      if (variants.length === 1) {
        agreed.set(vkey(term, lang), variants[0].text);
        continue;
      }

      const entryIds = group.map((e) => e.id);
      const trivial = triviallyEquivalent(variants.map((v) => v.text));
      if (trivial) {
        resolved.push({
          term,
          lang,
          canonical: variants[0].text,
          confidence: 1,
          interchangeable: 1,
          doNotTranslate: 0,
          covered: 1,
          severity: 0.5,
          variants,
          entryIds,
          origin: "spacing-or-case",
        });
        continue;
      }
      conflicts.push({ term, lang, variants, entryIds, origin: "duplicate-source", trivial });
    }
  }

  const longEntries = corpus.entries.filter((e) => wordCount(e.source) > MAX_TERM_WORDS);
  const contested = [...variantsByTerm.entries()].filter(([, v]) => v.length > 1);

  if (contested.length > 0 && longEntries.length > 0) {
    const byTermLang = new Map<string, TermConflict>();
    for (const c of conflicts) byTermLang.set(vkey(c.term, c.lang), c);

    const foldedSource = new Map<string, string>();
    for (const e of longEntries) foldedSource.set(e.id, fold(e.source));

    for (const [key, variants] of contested) {
      const [term, lang] = key.split("\u0000");
      const conflict = byTermLang.get(key);
      if (!conflict) continue;
      const stems = variants.map((v) => headStem(v.text)).filter(Boolean);
      if (new Set(stems).size < 2) continue;

      for (const e of longEntries) {
        if (!containsTerm(foldedSource.get(e.id)!, term)) continue;
        const value = fold(e.tr[lang] ?? "");
        if (!value) continue;
        if (stems.some((s) => value.includes(s))) conflict.entryIds.push(e.id);
      }
    }
  }

  for (const c of conflicts) c.entryIds = [...new Set(c.entryIds)];
  conflicts.sort((a, b) => b.entryIds.length - a.entryIds.length || a.term.localeCompare(b.term));

  resolved.sort((a, b) => b.entryIds.length - a.entryIds.length || a.term.localeCompare(b.term));
  return { conflicts, resolved, agreed, termCount: termEntries.size };
}

export function entriesUnderConflict(conflicts: TermConflict[]): Set<string> {
  const out = new Set<string>();
  for (const c of conflicts) for (const id of c.entryIds) out.add(id);
  return out;
}

export function termsForEntry(entry: Entry, conflicts: TermConflict[]): TermConflict[] {
  const folded = fold(entry.source);
  return conflicts.filter((c) => containsTerm(folded, c.term));
}
