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

/**
 * Whether a term may be enforced against the corpus.
 *
 * Enforcement is gated on *status*, never on the canonical being absent. A term that a
 * human suspended — `context-dependent`, `rejected` — keeps whatever rendering was
 * proposed for it, because a decision a translator can undo is worth more than one that
 * silently costs a re-arbitration to reverse.
 *
 * Every place that turns records into rules asks this one question. Two conditions that
 * drift apart is how a suspended term gets quietly enforced somewhere.
 */
export const isEnforceable = (rec: GlossaryRecord): boolean =>
  rec.canonical !== null && rec.status !== "rejected" && rec.status !== "context-dependent";

/**
 * A term, and everything known about it.
 *
 * There is one shape, not two. A record *is* a `GlossaryEntry` — the level-4 view the
 * audit enforces — plus what a human settled and when. That makes `view` below a
 * projection rather than a reconstruction: it can only drop fields, never invent them,
 * and the type checker says so. The two used to be converted in both directions by hand,
 * and both directions lost something: `interchangeable` was discarded on every pass, and
 * `origin` was guessed back from `source`.
 */
export type GlossaryRecord = GlossaryEntry & {
  key: string;
  display: string;
  status: TermStatus;
  source: "jev" | "code" | "human";
  guidance: string;
  note: string;
  decidedBy: string | null;
  decidedAt: string | null;
  firstSeen: string;
};

/** The level-4 view: what the audit is allowed to enforce, and nothing about who said so. */
const view = (r: GlossaryRecord): GlossaryEntry => ({
  term: r.term,
  lang: r.lang,
  canonical: r.canonical,
  confidence: r.confidence,
  interchangeable: r.interchangeable,
  doNotTranslate: r.doNotTranslate,
  covered: r.covered,
  severity: r.severity,
  variants: r.variants,
  entryIds: r.entryIds,
  origin: r.origin,
});

/** The record is already JSON-shaped, so the file is the record. */
export type GlossaryFile = {
  version: number;
  updatedAt: string;
  terms: GlossaryRecord[];
};

export const GLOSSARY_VERSION = 2;

export const termKey = (term: string, lang: Lang): string => `${term}\u0000${lang}`;

export function loadGlossary(path: string): GlossaryRecord[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as GlossaryFile;
  if (raw.version !== GLOSSARY_VERSION && raw.version !== 1) {
    throw new Error(`${path} is glossary version ${raw.version}; this build reads ${GLOSSARY_VERSION}`);
  }
  return raw.terms.map((t) => ({
    ...t,
    severity: t.severity ?? null,
    doNotTranslate: t.doNotTranslate ?? null,
    covered: t.covered ?? null,
    // A version 1 file predates the record carrying these. It genuinely does not know
    // whether the renderings were interchangeable, and it recorded how a term was found
    // only as `source`. This is the one place that says so; everywhere else they are read,
    // never derived.
    interchangeable: t.interchangeable ?? null,
    origin: t.origin ?? (t.source === "code" ? "spacing-or-case" : t.source === "human" ? "human" : "duplicate-source"),
  }));
}

export function saveGlossary(path: string, terms: GlossaryRecord[]): void {
  const payload: GlossaryFile = {
    version: GLOSSARY_VERSION,
    updatedAt: new Date().toISOString(),
    terms,
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
        interchangeable: null,
        severity: null,
        doNotTranslate: null,
        covered: null,
        variants: c.variants,
        entryIds: c.entryIds,
        origin: c.origin,
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
      rec.interchangeable = g.interchangeable;
      rec.origin = g.origin;
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
      interchangeable: g.interchangeable,
      severity: g.severity,
      doNotTranslate: g.doNotTranslate,
      covered: g.covered,
      variants: g.variants,
      entryIds: g.entryIds,
      origin: g.origin,
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
    // Every answer is kept, including the ones only the workbook reads. `interchangeable`
    // was paid for and dropped here for as long as the record was a different shape.
    rec.interchangeable = a.interchangeable;
    rec.doNotTranslate = a.doNotTranslate;
    rec.covered = a.covered;
    rec.origin = a.origin;
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
    // The canonical is kept. `isEnforceable` reads the status, so suspending a term stops
    // it governing the queue without throwing away what arbitration proposed — which is
    // what makes putting the status back an undo rather than a re-run.
    if (patch.status === "do-not-translate") {
      next.canonical = next.display;
      // The record carries what the decision means, so the level-4 view stays a pick.
      next.doNotTranslate = 1;
    }
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
    interchangeable: null,
    severity: null,
    doNotTranslate: null,
    covered: 1,
    variants: [],
    entryIds: [],
    origin: "human",
    guidance,
    note: "",
    decidedBy: who,
    decidedAt: now,
    firstSeen: now,
  };
}

/** What the audit may enforce: the records `isEnforceable` admits, projected. */
export function enforceable(records: GlossaryRecord[]): GlossaryEntry[] {
  return records.filter(isEnforceable).map(view);
}

/** Every term the glossary knows, enforceable or not — what the workbook reports. */
export function asGlossaryEntries(records: GlossaryRecord[]): GlossaryEntry[] {
  return records.map(view);
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
