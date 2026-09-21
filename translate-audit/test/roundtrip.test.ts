import { afterAll, describe, expect, it } from "vitest";
import type { RuleId } from "../src/policy/rules.ts";
import ExcelJS from "exceljs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Corpus, Finding } from "../src/types.ts";
import { writeWorkbook, readDecisions, DECISIONS } from "../src/report/xlsx.ts";
import { selectChanges, writeReimportCsv } from "../src/report/reimport.ts";

const dir = mkdtempSync(join(tmpdir(), "translate-audit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const corpus: Corpus = {
  sourceLang: "pl",
  langs: ["pl", "de", "uk"],
  entries: [
    { id: "k1", project: "p", keyName: "usun", source: "Usuń", description: "", context: "", tags: [], tr: { pl: "Usuń", de: "Entfernen", uk: "Видалити" }, status: {} },
    { id: "k2", project: "p", keyName: "zapisz", source: "Zapisz", description: "", context: "", tags: [], tr: { pl: "Zapisz", de: "Speichern", uk: "" }, status: {} },
  ],
  origin: "test",
};

const findings: Finding[] = [
  {
    entryId: "k1", project: "p", keyName: "usun", lang: "de",
    source: "Usuń", current: "Entfernen", suggested: "Löschen",
    reasons: [
      { rule: "canonical-not-used" as const, p: 0.2, threshold: 0.4, terms: [{ term: "usun", canonical: "Löschen" }] },
    ],
    category: "consistency", severity: 2, action: "auto-fix", confidence: 0.82, substitutionOk: 0.91, judged: true,
  },
  {
    entryId: "k2", project: "p", keyName: "zapisz", lang: "uk",
    source: "Zapisz", current: "", suggested: null,
    reasons: [{ rule: "no-translation" as const }],
    category: "completeness", severity: 2, action: "needs human", confidence: 1, substitutionOk: null, judged: true,
  },
];

const path = join(dir, "audit.xlsx");

const report = {
  corpus,
  findings,
  glossary: [],
  lintIssues: [],
  summary: {
    findings: 2, entriesTouched: 2, entriesTotal: 2,
    bySeverity: [0, 0, 2, 0],
    byLang: [["de", 1], ["uk", 1]] as [string, number][],
    byAction: [["auto-fix", 1], ["needs human", 1]] as ["auto-fix" | "needs human", number][],
    byCategory: [["consistency", 1], ["completeness", 1]] as ["consistency" | "completeness", number][],
    byReason: [["does not use the canonical term", 1], ["no translation", 1]] as [string, number][],
    byRule: [["canonical-not-used", 1], ["no-translation", 1]] as [RuleId, number][],
  },
  stages: [{ name: "audit", requests: 2, judgments: 6, errors: 0, skipped: 0, reused: 0, retries: 0, wallMs: 100, latencies: [40, 60], inputTokens: 900, outputTokens: 60 }],
  registerNorms: new Map([["de", { formalShare: 0.9, n: 80 }]]),
  pricing: { inputPerM: 0.4, outputPerM: 2 },
  startedAt: new Date("2026-09-20T10:00:00Z"),
  policyNote: "test policy",
};

describe("workbook round-trip", () => {
  it("writes every sheet a reviewer needs", async () => {
    await writeWorkbook(path, report);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Dashboard", "Findings", "Glossary", "Keys", "Automated checks", "Run",
    ]);
  });

  it("puts the Decision dropdown on the column apply reads", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws = wb.getWorksheet("Findings")!;
    expect(ws.getCell(1, 9).value).toBe("Decision");
    const dv = ws.getCell(2, 9).dataValidation;
    expect(dv?.type).toBe("list");
    expect(dv?.formulae?.[0]).toBe(`"${DECISIONS.filter(Boolean).join(",")}"`);
  });

  it("reads back only the rows a reviewer decided", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws = wb.getWorksheet("Findings")!;
    ws.getCell(2, 9).value = "accept";
    ws.getCell(2, 10).value = "Löschen";
    await wb.xlsx.writeFile(path);

    const rows = await readDecisions(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entryId: "k1",
      lang: "de",
      keyName: "usun",
      decision: "accept",
      current: "Entfernen",
      suggested: "Löschen",
      final: "Löschen",
    });
  });

  it("emits a re-import row only where the text actually changed", async () => {
    const rows = await readDecisions(path);
    const changes = selectChanges(rows);
    expect(changes).toEqual([
      { entryId: "k1", keyName: "usun", lang: "de", before: "Entfernen", after: "Löschen" },
    ]);

    const csvPath = join(dir, "reimport.csv");
    writeReimportCsv(csvPath, changes);
    const csv = readFileSync(csvPath, "utf8");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("k1,usun,de,Löschen,Entfernen");
  });

  it("drops a decision that changes nothing", () => {
    expect(
      selectChanges([
        { entryId: "x", lang: "de", keyName: "k", decision: "accept", current: "Tor", suggested: "Tor", final: "Tor" },
        { entryId: "y", lang: "de", keyName: "k", decision: "reject", current: "A", suggested: "B", final: "B" },
        { entryId: "z", lang: "de", keyName: "k", decision: "edited", current: "A", suggested: "B", final: "C" },
      ]),
    ).toEqual([{ entryId: "z", keyName: "k", lang: "de", before: "A", after: "C" }]);
  });
});
