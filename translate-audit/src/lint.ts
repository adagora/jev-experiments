import type { Corpus, Entry, LintIssue, Lang } from "./types.ts";
import {
  PLACEHOLDER_RE,
  triviallyEquivalent,
  caseShape,
  fold,
  multiset,
  multisetDiff,
  norm,
  tagNames,
  terminalPunct,
  wordCount,
} from "./util/text.ts";

const COPY_SUSPICION_MIN_WORDS = 3;

export type LintReport = {
  issues: LintIssue[];
  hardByEntry: Map<string, Set<Lang>>;
  counts: Record<string, number>;
};

export function lintCorpus(corpus: Corpus): LintReport {
  const issues: LintIssue[] = [];
  const hardByEntry = new Map<string, Set<Lang>>();
  const push = (i: LintIssue, hard = false) => {
    issues.push(i);
    if (!hard) return;
    let s = hardByEntry.get(i.entryId);
    if (!s) hardByEntry.set(i.entryId, (s = new Set()));
    s.add(i.lang);
  };

  for (const e of corpus.entries) {
    const srcPH = multiset(e.source, PLACEHOLDER_RE);
    const srcTags = tagNames(e.source);
    const srcCase = caseShape(e.source);
    const srcPunct = terminalPunct(e.source);
    const srcWords = wordCount(e.source);

    for (const lang of corpus.langs) {
      const value = e.tr[lang];
      if (value === undefined) continue;
      if (norm(value) === "") {
        push({ entryId: e.id, lang, code: "empty-translation", detail: "no translation" });
        continue;
      }

      const phDiff = multisetDiff(srcPH, multiset(value, PLACEHOLDER_RE));
      if (phDiff.length) {
        push({ entryId: e.id, lang, code: "placeholder-mismatch", detail: phDiff.join("; ") }, true);
      }

      const tagDiff = multisetDiff(srcTags, tagNames(value));
      if (tagDiff.length) {
        push({ entryId: e.id, lang, code: "tag-mismatch", detail: tagDiff.join("; ") }, true);
      }

      if (value !== value.trim() && e.source === e.source.trim()) {
        push({ entryId: e.id, lang, code: "whitespace", detail: "leading or trailing whitespace" });
      }

      const valCase = caseShape(value);
      if (srcCase !== "mixed" && valCase !== "mixed" && srcCase !== valCase) {
        push({ entryId: e.id, lang, code: "case-inconsistent", detail: `source is ${srcCase}, translation is ${valCase}` });
      }

      const valPunct = terminalPunct(value);
      if (srcPunct !== valPunct) {
        push({
          entryId: e.id,
          lang,
          code: "terminal-punctuation",
          detail: `source ends "${srcPunct || "∅"}", translation ends "${valPunct || "∅"}"`,
        });
      }

      if (lang !== corpus.sourceLang && srcWords >= COPY_SUSPICION_MIN_WORDS && fold(value) === fold(e.source)) {
        push({ entryId: e.id, lang, code: "untranslated-copy", detail: `identical to the ${corpus.sourceLang} source` });
      }
    }
  }

  issues.push(...duplicateSourceIssues(corpus));

  const counts: Record<string, number> = {};
  for (const i of issues) counts[i.code] = (counts[i.code] ?? 0) + 1;
  return { issues, hardByEntry, counts };
}

function duplicateSourceIssues(corpus: Corpus): LintIssue[] {
  const out: LintIssue[] = [];
  for (const [, group] of groupBySource(corpus.entries)) {
    if (group.length < 2) continue;
    for (const lang of corpus.langs) {
      if (lang === corpus.sourceLang) continue;
      const variants = new Map<string, string[]>();
      for (const e of group) {
        const v = norm(e.tr[lang] ?? "");
        if (!v) continue;
        const list = variants.get(v);
        if (list) list.push(e.id);
        else variants.set(v, [e.id]);
      }
      if (variants.size < 2) continue;
      const code = triviallyEquivalent([...variants.keys()]) ? "spacing-variant" : "duplicate-source-divergent";
      const detail = [...variants.keys()].map((v) => JSON.stringify(v)).join(" vs ");

      const ranked = [...variants.entries()].sort((a, b) => b[1].length - a[1].length);
      const strictMajority = ranked.length > 1 && ranked[0][1].length > ranked[1][1].length;
      const majority = strictMajority ? ranked[0][0] : null;
      for (const [text, ids] of variants) {
        if (majority !== null && text === majority) continue;
        for (const id of ids) out.push({ entryId: id, lang, code, detail });
      }
    }
  }
  return out;
}

export function groupBySource(entries: Entry[]): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = fold(e.source);
    if (!k) continue;
    const list = out.get(k);
    if (list) list.push(e);
    else out.set(k, [e]);
  }
  return out;
}
