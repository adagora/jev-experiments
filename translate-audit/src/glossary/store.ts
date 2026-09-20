import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { GlossaryEntry, Lang, TermConflict, Variant } from "../types.ts";
import { fold, norm } from "../util/text.ts";

export type TermStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "context-dependent"
  | "do-not-translate";

export const HUMAN_STATUSES: TermStatus[] = ["approved", "rejected", "context-dependent", "do-not-translate"];

export const isDecided = (status: TermStatus): boolean => HUMAN_STATUSES.includes(status);

export type GlossaryRecord = {
  key: string;
  term: string;
  display: string;
  lang: Lang;
  canonical: string | null;
  status: TermStatus;
  source: "jev" | "code" | "human";
  confidence: number;
  severity: number;
  doNotTranslate: number;
  covered: number;
  variants: Variant[];
  entryIds: string[];
  guidance: string;
  note: string;
  decidedBy: string | null;
  decidedAt: string | null;
  firstSeen: string;
};

export type GlossaryFile = {
  version: number;
  updatedAt: string;
  terms: (Omit<GlossaryRecord, "severity" | "doNotTranslate" | "covered"> & {
    severity: number | null;
    doNotTranslate: number | null;
    covered: number | null;
  })[];
};

export const GLOSSARY_VERSION = 1;

export const termKey = (term: string, lang: Lang): string => `${term}\u0000${lang}`;

const unknownToNull = (n: number): number | null => (Number.isNaN(n) ? null : n);
const nullToUnknown = (n: number | null | undefined): number => (n === null || n === undefined ? NaN : n);

export function loadGlossary(path: string): GlossaryRecord[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as GlossaryFile;
  if (raw.version !== GLOSSARY_VERSION) {
    throw new Error(`${path} is glossary version ${raw.version}; this build reads ${GLOSSARY_VERSION}`);
  }
  return raw.terms.map((t) => ({
    ...t,
    severity: nullToUnknown(t.severity),
    doNotTranslate: nullToUnknown(t.doNotTranslate),
    covered: nullToUnknown(t.covered),
  }));
}

export function saveGlossary(path: string, terms: GlossaryRecord[]): void {
  const payload = {
    version: GLOSSARY_VERSION,
    updatedAt: new Date().toISOString(),
    terms: terms.map((t) => ({
      ...t,
      severity: unknownToNull(t.severity),
      doNotTranslate: unknownToNull(t.doNotTranslate),
      covered: unknownToNull(t.covered),
    })),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
}

export type MergeResult = {
  records: GlossaryRecord[];
  needArbitration: TermConflict[];
  reused: number;
  fresh: number;
  drifted: GlossaryRecord[];
};

export function mergeMined(
  saved: GlossaryRecord[],
  conflicts: TermConflict[],
  codeResolved: GlossaryEntry[],
  displayFor: (term: string) => string,
): MergeResult {
  const byKey = new Map(saved.map((r) => [r.key, { ...r }]));
  const now = new Date().toISOString();
  const needArbitration: TermConflict[] = [];
  const drifted: GlossaryRecord[] = [];
  let reused = 0;
  let fresh = 0;

  const observe = (key: string, variants: Variant[], entryIds: string[]): GlossaryRecord | undefined => {
    const rec = byKey.get(key);
    if (!rec) return undefined;
    const before = new Set(rec.variants.map((v) => fold(v.text)));
    const added = variants.filter((v) => !before.has(fold(v.text)));
    rec.variants = variants;
    rec.entryIds = entryIds;
    if (added.length && isDecided(rec.status)) drifted.push(rec);
    return rec;
  };

  for (const c of conflicts) {
    const key = termKey(c.term, c.lang);
    const rec = observe(key, c.variants, c.entryIds);
    if (rec && isDecided(rec.status)) {
      reused++;
      continue;
    }
    if (!rec) {
      fresh++;
      byKey.set(key, {
        key,
        term: c.term,
        display: displayFor(c.term),
        lang: c.lang,
        canonical: null,
        status: "proposed",
        source: "jev",
        confidence: 0,
        severity: NaN,
        doNotTranslate: NaN,
        covered: NaN,
        variants: c.variants,
        entryIds: c.entryIds,
        guidance: "",
        note: "",
        decidedBy: null,
        decidedAt: null,
        firstSeen: now,
      });
    }
    needArbitration.push(c);
  }

  for (const g of codeResolved) {
    const key = termKey(g.term, g.lang);
    const rec = observe(key, g.variants, g.entryIds);
    if (rec && isDecided(rec.status)) {
      reused++;
      continue;
    }
    if (rec) {
      rec.canonical = g.canonical;
      rec.confidence = g.confidence;
      rec.severity = g.severity;
      rec.source = "code";
      continue;
    }
    fresh++;
    byKey.set(key, {
      key,
      term: g.term,
      display: displayFor(g.term),
      lang: g.lang,
      canonical: g.canonical,
      status: "proposed",
      source: "code",
      confidence: g.confidence,
      severity: g.severity,
      doNotTranslate: g.doNotTranslate,
      covered: g.covered,
      variants: g.variants,
      entryIds: g.entryIds,
      guidance: "",
      note: "",
      decidedBy: null,
      decidedAt: null,
      firstSeen: now,
    });
  }

  return { records: [...byKey.values()], needArbitration, reused, fresh, drifted };
}

export function applyArbitration(records: GlossaryRecord[], answers: GlossaryEntry[]): GlossaryRecord[] {
  const byKey = new Map(records.map((r) => [r.key, r]));
  for (const a of answers) {
    const rec = byKey.get(termKey(a.term, a.lang));
    if (!rec || isDecided(rec.status)) continue;
    rec.canonical = a.canonical;
    rec.confidence = a.confidence;
    rec.severity = a.severity;
    rec.doNotTranslate = a.doNotTranslate;
    rec.covered = a.covered;
    rec.source = "jev";
    rec.status = "proposed";
  }
  return records;
}

export type TermPatch = {
  canonical?: string | null;
  status?: TermStatus;
  guidance?: string;
  note?: string;
};

export function decide(rec: GlossaryRecord, patch: TermPatch, who: string): GlossaryRecord {
  const next = { ...rec };
  if (patch.guidance !== undefined) next.guidance = patch.guidance;
  if (patch.note !== undefined) next.note = patch.note;

  if (patch.canonical !== undefined) {
    const typed = patch.canonical === null ? null : norm(patch.canonical) || null;
    next.canonical = typed;
    if (typed !== null) {
      next.source = "human";
      next.confidence = 1;
      next.status = patch.status ?? "approved";
    } else {
      next.status = patch.status ?? "proposed";
    }
  } else if (patch.status !== undefined) {
    next.status = patch.status;
    if (patch.status === "context-dependent" || patch.status === "rejected") next.canonical = null;
    if (patch.status === "do-not-translate") next.canonical = next.display;
  }

  if (patch.status !== undefined || patch.canonical !== undefined) {
    next.decidedBy = isDecided(next.status) ? who : null;
    next.decidedAt = isDecided(next.status) ? new Date().toISOString() : null;
  }
  return next;
}

export function manualTerm(term: string, lang: Lang, canonical: string, who: string, guidance = ""): GlossaryRecord {
  const folded = fold(term);
  const now = new Date().toISOString();
  return {
    key: termKey(folded, lang),
    term: folded,
    display: norm(term),
    lang,
    canonical: norm(canonical),
    status: "approved",
    source: "human",
    confidence: 1,
    severity: NaN,
    doNotTranslate: NaN,
    covered: 1,
    variants: [],
    entryIds: [],
    guidance,
    note: "",
    decidedBy: who,
    decidedAt: now,
    firstSeen: now,
  };
}

export function enforceable(records: GlossaryRecord[]): GlossaryEntry[] {
  return records
    .filter((r) => r.canonical && r.status !== "rejected" && r.status !== "context-dependent")
    .map((r) => ({
      term: r.term,
      lang: r.lang,
      canonical: r.canonical,
      confidence: r.confidence,
      interchangeable: NaN,
      doNotTranslate: r.status === "do-not-translate" ? 1 : r.doNotTranslate,
      covered: r.covered,
      severity: r.severity,
      variants: r.variants,
      entryIds: r.entryIds,
      origin: r.source === "code" ? "spacing-or-case" : "duplicate-source",
    }));
}

export function asGlossaryEntries(records: GlossaryRecord[]): GlossaryEntry[] {
  return records.map((r) => ({
    term: r.term,
    lang: r.lang,
    canonical: r.canonical,
    confidence: r.confidence,
    interchangeable: NaN,
    doNotTranslate: r.status === "do-not-translate" ? 1 : r.doNotTranslate,
    covered: r.covered,
    severity: r.severity,
    variants: r.variants,
    entryIds: r.entryIds,
    origin: r.source === "code" ? "spacing-or-case" : "duplicate-source",
  }));
}

export function guidanceByTerm(records: GlossaryRecord[]): Map<string, { lang: Lang; guidance: string }[]> {
  const out = new Map<string, { lang: Lang; guidance: string }[]>();
  for (const r of records) {
    if (!r.guidance.trim()) continue;
    const list = out.get(r.term);
    const item = { lang: r.lang, guidance: r.guidance.trim() };
    if (list) list.push(item);
    else out.set(r.term, [item]);
  }
  return out;
}

export function glossaryStats(records: GlossaryRecord[]) {
  const byStatus = new Map<TermStatus, number>();
  for (const r of records) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const decided = records.filter((r) => isDecided(r.status)).length;
  return {
    total: records.length,
    decided,
    proposed: records.length - decided,
    withGuidance: records.filter((r) => r.guidance.trim()).length,
    byStatus: [...byStatus.entries()].sort((a, b) => b[1] - a[1]),
    keysCovered: new Set(records.flatMap((r) => r.entryIds)).size,
  };
}
