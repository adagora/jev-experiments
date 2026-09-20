import ExcelJS from "exceljs";
import type { Corpus, Finding, GlossaryEntry, Lang, LintIssue, StageStats } from "../types.ts";
import type { Summary } from "../compose.ts";
import { langName } from "../jev/questions.ts";
import { percentile } from "../jev/client.ts";
import { norm } from "../util/text.ts";

export const DECISIONS = ["", "accept", "reject", "edited", "defer"] as const;
export type Decision = (typeof DECISIONS)[number];

const SEVERITY_FILL = ["FFFFFFFF", "FFFFF6DA", "FFFCE3CD", "FFF6CFCF"];
const SEVERITY_LABEL = ["cosmetic", "minor", "confusing", "breaks meaning"];
const HEADER_FILL = "FF1F3B57";

const CATEGORY_COLOR: Record<string, string> = {
  integrity: "FFB3261E",
  meaning: "FFA34700",
  consistency: "FF1F3B57",
  completeness: "FF5B6570",
  style: "FF7A7A7A",
};

const CATEGORY_NOTE: Record<string, string> = {
  integrity: "placeholders or markup differ — the product will render wrong",
  meaning: "says something other than the source says",
  consistency: "right meaning, different wording than everywhere else",
  completeness: "missing, or still in the source language",
  style: "casing, punctuation or formality",
};

type SheetSpec = { header: string[]; widths: number[] };

function addHeader(ws: ExcelJS.Worksheet, spec: SheetSpec): void {
  ws.addRow(spec.header);
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  row.alignment = { vertical: "middle" };
  row.height = 22;
  spec.widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.header.length } };
}

export type ReportInput = {
  corpus: Corpus;
  findings: Finding[];
  glossary: GlossaryEntry[];
  lintIssues: LintIssue[];
  summary: Summary;
  stages: StageStats[];
  registerNorms: Map<Lang, { formalShare: number; n: number }>;
  pricing: { inputPerM: number; outputPerM: number };
  startedAt: Date;
  policyNote: string;
};

export async function writeWorkbook(path: string, input: ReportInput): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "translate-audit";
  wb.created = input.startedAt;

  dashboardSheet(wb, input);
  findingsSheet(wb, input);
  glossarySheet(wb, input);
  keysSheet(wb, input);
  lintSheet(wb, input);
  runSheet(wb, input);

  await wb.xlsx.writeFile(path);
}

function dashboardSheet(wb: ExcelJS.Workbook, input: ReportInput): void {
  const ws = wb.addWorksheet("Dashboard", { properties: { defaultRowHeight: 18 } });
  ws.getColumn(1).width = 42;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 58;

  const title = ws.addRow(["Translation consistency audit"]);
  title.font = { bold: true, size: 16 };
  ws.addRow([input.corpus.origin]).font = { color: { argb: "FF666666" } };
  ws.addRow([`${input.startedAt.toISOString().replace("T", " ").slice(0, 19)} · source language ${langName(input.corpus.sourceLang)}`])
    .font = { color: { argb: "FF666666" } };
  ws.addRow([]);

  const section = (name: string) => {
    const r = ws.addRow([name]);
    r.font = { bold: true, size: 12 };
    r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDF2F7" } };
  };
  const kv = (k: string, v: string | number, note = "") => ws.addRow([k, v, note]);

  section("Corpus");
  kv("Keys", input.corpus.entries.length);
  kv("Target languages", input.corpus.langs.filter((l) => l !== input.corpus.sourceLang).map(langName).join(", "));
  kv("Translations examined", input.corpus.entries.reduce((n, e) => n + Object.keys(e.tr).length, 0));
  ws.addRow([]);

  section("Findings");
  kv("Total", input.summary.findings);
  kv("Keys affected", `${input.summary.entriesTouched} of ${input.summary.entriesTotal}`,
    `${((100 * input.summary.entriesTouched) / Math.max(1, input.summary.entriesTotal)).toFixed(1)}% of the corpus`);
  for (let s = 3; s >= 0; s--) {
    const row = kv(`  severity ${s} — ${SEVERITY_LABEL[s]}`, input.summary.bySeverity[s]);
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: SEVERITY_FILL[s] } };
  }
  ws.addRow([]);

  section("What kind of problem");
  for (const [cat, n] of input.summary.byCategory) {
    kv(`  ${cat}`, n, CATEGORY_NOTE[cat] ?? "");
  }
  ws.addRow([]);

  section("Recommended action");
  for (const [action, n] of input.summary.byAction) kv(`  ${action}`, n);
  ws.addRow([]);

  section("By language");
  for (const [lang, n] of input.summary.byLang) kv(`  ${langName(lang)} (${lang})`, n);
  ws.addRow([]);

  section("Why findings were raised");
  for (const [reason, n] of input.summary.byReason.slice(0, 14)) kv(`  ${reason}`, n);
  ws.addRow([]);

  if (input.registerNorms.size) {
    section("Formality norm (measured, not assumed)");
    for (const [lang, n] of input.registerNorms) {
      kv(`  ${langName(lang)}`, `${Math.round(n.formalShare * 100)}% formal`, `over ${n.n} prose strings`);
    }
    ws.addRow([]);
  }

  section("Policy");
  ws.addRow(["", "", input.policyNote]).getCell(3).alignment = { wrapText: true };
}

function findingsSheet(wb: ExcelJS.Workbook, input: ReportInput): void {
  const ws = wb.addWorksheet("Findings", { properties: { defaultRowHeight: 16 } });
  addHeader(ws, {
    header: [
      "Severity", "Category", "Lang", "Project", "Key", "Source", "Current translation",
      "Suggested", "Decision", "Final translation", "Why", "Confidence", "Sub. check", "Entry id",
    ],
    widths: [10, 14, 8, 14, 30, 46, 46, 46, 13, 46, 62, 11, 10, 26],
  });

  for (const f of input.findings) {
    const sev = Math.min(3, Math.max(0, Math.round(f.severity)));
    const row = ws.addRow([
      sev,
      f.category,
      f.lang,
      f.project,
      f.keyName.slice(0, 200),
      f.source,
      f.current,
      f.suggested ?? "",
      "",
      { formula: `IF($I${ws.rowCount + 1}="accept",$H${ws.rowCount + 1},$G${ws.rowCount + 1})`, result: f.current },
      f.reasons.join("\n"),
      Number(f.confidence.toFixed(3)),
      f.substitutionOk === null ? "" : Number(f.substitutionOk.toFixed(3)),
      f.entryId,
    ]);
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: SEVERITY_FILL[sev] } };
    row.getCell(1).alignment = { horizontal: "center" };
    row.getCell(2).font = { color: { argb: CATEGORY_COLOR[f.category] } };
    for (const c of [6, 7, 8, 10, 11]) row.getCell(c).alignment = { wrapText: true, vertical: "top" };
    if (f.action === "auto-fix" && f.suggested) {
      row.getCell(8).font = { color: { argb: "FF1B7F3B" } };
    }
  }

  for (let r = 2; r <= input.findings.length + 1; r++) {
    ws.getCell(r, 9).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`"${DECISIONS.filter(Boolean).join(",")}"`],
      showErrorMessage: true,
      errorTitle: "Decision",
      error: "Choose accept, reject, edited or defer.",
    };
    ws.getCell(r, 9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F9FC" } };
  }
  ws.views = [{ state: "frozen", xSplit: 3, ySplit: 1 }];
}

function glossarySheet(wb: ExcelJS.Workbook, input: ReportInput): void {
  const ws = wb.addWorksheet("Glossary", { properties: { defaultRowHeight: 16 } });
  addHeader(ws, {
    header: [
      "Term (source)", "Lang", "Canonical", "Confidence", "Severity", "Interchangeable",
      "Do not translate", "Right one is listed", "Variants observed", "Keys", "Found by",
    ],
    widths: [30, 8, 34, 12, 10, 15, 16, 18, 62, 8, 20],
  });

  const ordered = [...input.glossary].sort(
    (a, b) =>
      (Number.isNaN(b.severity) ? 0 : b.severity) - (Number.isNaN(a.severity) ? 0 : a.severity) ||
      b.entryIds.length - a.entryIds.length ||
      a.term.localeCompare(b.term) ||
      a.lang.localeCompare(b.lang),
  );

  for (const g of ordered) {
    const row = ws.addRow([
      g.term,
      g.lang,
      g.canonical ?? "— context-dependent —",
      Number(g.confidence.toFixed(3)),
      Number.isNaN(g.severity) ? "" : Number(g.severity.toFixed(2)),
      Number.isNaN(g.interchangeable) ? "" : Number(g.interchangeable.toFixed(3)),
      Number.isNaN(g.doNotTranslate) ? "" : Number(g.doNotTranslate.toFixed(3)),
      Number.isNaN(g.covered) ? "" : Number(g.covered.toFixed(3)),
      g.variants.map((v) => `${v.text} (${v.count})`).join("  |  "),
      g.entryIds.length,
      g.origin,
    ]);
    row.getCell(9).alignment = { wrapText: true, vertical: "top" };
    if (!g.canonical) row.getCell(3).font = { italic: true, color: { argb: "FF8A6D00" } };
    const sev = Number.isNaN(g.severity) ? 0 : Math.min(3, Math.round(g.severity));
    row.getCell(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: SEVERITY_FILL[sev] } };
    if (!Number.isNaN(g.doNotTranslate) && g.doNotTranslate >= 0.5) {
      row.getCell(7).font = { bold: true, color: { argb: "FF1F3B57" } };
    }
  }
}

function keysSheet(wb: ExcelJS.Workbook, input: ReportInput): void {
  const ws = wb.addWorksheet("Keys", { properties: { defaultRowHeight: 16 } });
  const targets = input.corpus.langs.filter((l) => l !== input.corpus.sourceLang);
  addHeader(ws, {
    header: ["Project", "Key", `Source (${input.corpus.sourceLang})`, ...targets, "Findings", "Worst severity"],
    widths: [14, 30, 44, ...targets.map(() => 38), 10, 14],
  });

  const worst = new Map<string, { n: number; sev: number; langs: Set<Lang> }>();
  for (const f of input.findings) {
    let rec = worst.get(f.entryId);
    if (!rec) worst.set(f.entryId, (rec = { n: 0, sev: 0, langs: new Set() }));
    rec.n++;
    rec.sev = Math.max(rec.sev, f.severity);
    rec.langs.add(f.lang);
  }

  for (const e of input.corpus.entries) {
    const rec = worst.get(e.id);
    const row = ws.addRow([
      e.project,
      e.keyName.slice(0, 200),
      norm(e.source),
      ...targets.map((l) => norm(e.tr[l] ?? "")),
      rec?.n ?? 0,
      rec ? Math.min(3, Math.round(rec.sev)) : 0,
    ]);
    if (rec) {
      const sev = Math.min(3, Math.round(rec.sev));
      row.getCell(3 + targets.length + 2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: SEVERITY_FILL[sev] } };
      targets.forEach((l, i) => {
        if (rec.langs.has(l)) row.getCell(4 + i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: SEVERITY_FILL[sev] } };
      });
    }
  }
  ws.views = [{ state: "frozen", xSplit: 3, ySplit: 1 }];
}

function lintSheet(wb: ExcelJS.Workbook, input: ReportInput): void {
  const ws = wb.addWorksheet("Automated checks", { properties: { defaultRowHeight: 16 } });
  addHeader(ws, { header: ["Check", "Lang", "Key", "Detail", "Entry id"], widths: [28, 8, 34, 70, 26] });
  const byEntry = new Map(input.corpus.entries.map((e) => [e.id, e]));
  for (const i of input.lintIssues) {
    const e = byEntry.get(i.entryId);
    const row = ws.addRow([i.code, i.lang, e ? e.keyName.slice(0, 200) : "", i.detail, i.entryId]);
    row.getCell(4).alignment = { wrapText: true, vertical: "top" };
  }
}

function runSheet(wb: ExcelJS.Workbook, input: ReportInput): void {
  const ws = wb.addWorksheet("Run", { properties: { defaultRowHeight: 16 } });
  addHeader(ws, {
    header: ["Stage", "Requests", "Judgments", "Wall time (s)", "p50 (ms)", "p95 (ms)", "Req/s", "Errors", "Retries", "Input tokens", "Output tokens", "Cost (USD)"],
    widths: [16, 11, 12, 14, 10, 10, 9, 9, 9, 14, 14, 12],
  });

  let cost = 0;
  let requests = 0;
  let judgments = 0;
  let wall = 0;
  for (const s of input.stages) {
    const c = (s.inputTokens / 1e6) * input.pricing.inputPerM + (s.outputTokens / 1e6) * input.pricing.outputPerM;
    cost += c;
    requests += s.requests;
    judgments += s.judgments;
    wall += s.wallMs;
    ws.addRow([
      s.name,
      s.requests,
      s.judgments,
      Number((s.wallMs / 1000).toFixed(2)),
      Math.round(percentile(s.latencies, 50)),
      Math.round(percentile(s.latencies, 95)),
      Number((s.requests / Math.max(0.001, s.wallMs / 1000)).toFixed(1)),
      s.errors,
      s.retries,
      s.inputTokens,
      s.outputTokens,
      Number(c.toFixed(4)),
    ]);
  }
  const total = ws.addRow([
    "total", requests, judgments, Number((wall / 1000).toFixed(2)), "", "",
    Number((requests / Math.max(0.001, wall / 1000)).toFixed(1)), "", "", "", "", Number(cost.toFixed(4)),
  ]);
  total.font = { bold: true };

  ws.addRow([]);
  ws.addRow(["One LLM call per judgment at 3 s would take", Number(((judgments * 3) / 3600).toFixed(1)), "hours"]).font = { italic: true };
  ws.addRow(["Pricing used (USD per 1M tokens)", input.pricing.inputPerM, input.pricing.outputPerM]).font = { color: { argb: "FF666666" } };
}

export type ReviewedRow = {
  entryId: string;
  lang: Lang;
  keyName: string;
  decision: Decision;
  current: string;
  suggested: string;
  final: string;
};

export async function readDecisions(path: string): Promise<ReviewedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet("Findings");
  if (!ws) throw new Error(`${path}: no "Findings" sheet — is this a translate-audit workbook?`);

  const out: ReviewedRow[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const cellText = (i: number): string => {
      const v = row.getCell(i).value;
      if (v === null || v === undefined) return "";
      if (typeof v === "object" && "result" in v) return String((v as ExcelJS.CellFormulaValue).result ?? "");
      if (typeof v === "object" && "richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
      return String(v);
    };
    const decision = cellText(9).trim().toLowerCase() as Decision;
    if (!decision) return;
    const current = cellText(7);
    const suggested = cellText(8);
    const final = cellText(10) || (decision === "accept" ? suggested : current);
    out.push({ entryId: cellText(14), lang: cellText(3), keyName: cellText(5), decision, current, suggested, final });
  });
  return out;
}
