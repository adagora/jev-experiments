import { Workbook } from "../engine/workbook.ts";
import { generateLeads, generateReviews } from "./generate.ts";
import { formulaFor, schemaById, type Schema } from "../lib/predict.ts";

export const ROWS = 400;
export const COLS = 26;
export const REVIEW_COUNT = 300;
export const LEAD_COUNT = 150;

/** Columns that ship already predicted (and accepted) so the sheet opens populated. */
export type SeedPrediction = { sheet: string; col: number; textCol: number; header: string; schema: Schema; rows: number };

export const SEED_PREDICTIONS: SeedPrediction[] = [
  { sheet: "Reviews", col: 3, textCol: 2, header: "Sentiment", schema: schemaById("sentiment")!, rows: REVIEW_COUNT },
  { sheet: "Leads", col: 4, textCol: 3, header: "Intent", schema: schemaById("intent")!, rows: LEAD_COUNT },
];

const set = (wb: Workbook, sheet: string, cell: string, raw: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(cell)!;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  wb.setCell(sheet, Number(m[2]) - 1, col - 1, raw);
};

export function buildWorkbook(): Workbook {
  const wb = new Workbook();

  // ---------------------------------------------------------------- Reviews
  const reviews = wb.addSheet("Reviews", ROWS, COLS);
  reviews.colWidths.set(0, 64);
  reviews.colWidths.set(1, 190);
  reviews.colWidths.set(2, 640);
  reviews.colWidths.set(3, 190);
  reviews.colWidths.set(4, 190);
  reviews.colWidths.set(5, 40);
  reviews.colWidths.set(6, 200);
  reviews.colWidths.set(7, 90);
  reviews.colWidths.set(8, 80);

  ["ID", "Product", "Review"].forEach((h, c) => wb.setCell("Reviews", 0, c, h));
  generateReviews(REVIEW_COUNT).forEach((r, i) => {
    const row = i + 1;
    wb.setCell("Reviews", row, 0, r.id);
    wb.setCell("Reviews", row, 1, r.product);
    wb.setCell("Reviews", row, 2, r.text);
  });

  const last = REVIEW_COUNT + 1;
  set(wb, "Reviews", "G1", "Summary");
  set(wb, "Reviews", "G2", "Rows judged");
  set(wb, "Reviews", "H2", `=COUNT(D2:D${last})`);
  set(wb, "Reviews", "G3", "Average score (0–4)");
  set(wb, "Reviews", "H3", `=ROUND(AVERAGE(D2:D${last}),2)`);
  set(wb, "Reviews", "G4", "Low (score < 1.5)");
  set(wb, "Reviews", "H4", `=COUNTIF(D2:D${last},"<1.5")`);
  set(wb, "Reviews", "I4", '=IF(H2>0,ROUND(100*H4/H2,0)&"%","")');
  set(wb, "Reviews", "G5", "High (score ≥ 2.5)");
  set(wb, "Reviews", "H5", `=COUNTIF(D2:D${last},">=2.5")`);
  set(wb, "Reviews", "I5", '=IF(H2>0,ROUND(100*H5/H2,0)&"%","")');

  // ------------------------------------------------------------------ Leads
  const leads = wb.addSheet("Leads", ROWS, COLS);
  leads.colWidths.set(0, 64);
  leads.colWidths.set(1, 180);
  leads.colWidths.set(2, 90);
  leads.colWidths.set(3, 640);
  leads.colWidths.set(4, 170);
  leads.colWidths.set(5, 190);
  leads.colWidths.set(6, 40);
  leads.colWidths.set(7, 200);
  leads.colWidths.set(8, 80);

  ["ID", "Company", "Channel", "Message"].forEach((h, c) => wb.setCell("Leads", 0, c, h));
  generateLeads(LEAD_COUNT).forEach((l, i) => {
    const row = i + 1;
    wb.setCell("Leads", row, 0, l.id);
    wb.setCell("Leads", row, 1, l.company);
    wb.setCell("Leads", row, 2, l.channel);
    wb.setCell("Leads", row, 3, l.text);
  });
  const lastLead = LEAD_COUNT + 1;
  set(wb, "Leads", "H1", "Summary");
  set(wb, "Leads", "H2", "Rows judged");
  set(wb, "Leads", "I2", `=COUNTA(E2:E${lastLead})`);
  set(wb, "Leads", "H3", "Pricing or demo");
  set(wb, "Leads", "I3", `=COUNTIF(E2:E${lastLead},"pricing")+COUNTIF(E2:E${lastLead},"demo request")`);
  set(wb, "Leads", "H4", "Support");
  set(wb, "Leads", "I4", `=COUNTIF(E2:E${lastLead},"support")`);
  set(wb, "Leads", "H5", "Spam");
  set(wb, "Leads", "I5", `=COUNTIF(E2:E${lastLead},"spam")`);

  // ------------------------------------------------- pre-predicted columns
  for (const p of SEED_PREDICTIONS) {
    wb.setCell(p.sheet, 0, p.col, p.header);
    for (let r = 1; r <= p.rows; r++) wb.setCell(p.sheet, r, p.col, formulaFor(p.schema, p.header, p.textCol, r));
  }

  return wb;
}
