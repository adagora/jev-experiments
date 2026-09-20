import { describe, it, expect } from "vitest";
import { formulaFor, instructionsFor, intentQuestion, intentState, pickSchema, SCHEMAS, schemaById } from "./predict.ts";
import { Workbook } from "../engine/workbook.ts";
import { parseFormula } from "../engine/parser.ts";

describe("predictive columns", () => {
  it("every schema is a distinct choice option for the intent question", () => {
    const q = intentQuestion();
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria).length).toBe(SCHEMAS.length);
    expect(new Set(SCHEMAS.map((s) => s.id)).size).toBe(SCHEMAS.length);
  });

  it("picks the most probable schema", () => {
    const urgency = schemaById("urgency")!;
    const probs = Object.fromEntries(SCHEMAS.map((s) => [s.describe, 0.01]));
    probs[urgency.describe] = 0.9;
    const r = pickSchema(probs);
    expect(r.schema.id).toBe("urgency");
    expect(r.confidence).toBeCloseTo(0.9);
  });

  it("builds parseable formulas that reference the text column absolutely", () => {
    const f = formulaFor(schemaById("sentiment")!, "Sentiment", 2, 4);
    expect(f.startsWith('=RATE($C5,"Overall sentiment')).toBe(true);
    expect(() => parseFormula(f.slice(1))).not.toThrow();
    const j = formulaFor(schemaById("refund")!, "Refund risk?", 2, 1);
    expect(j).toMatch(/^=JUDGE\(\$C2,"/);
    const p = formulaFor(schemaById("topic")!, "Topic", 3, 1);
    expect(p).toContain('"shipping|quality|price|support|other"');
  });

  it("free-form headers become the question itself", () => {
    expect(instructionsFor(schemaById("yesno")!, "mentions a competitor")).toBe(
      "Answer this question about the text: mentions a competitor?",
    );
    expect(instructionsFor(schemaById("scale")!, "Humour")).toBe("Rate this text for: Humour");
    expect(intentState("Urgency", ["a".repeat(200), "b"])).toContain('Column header: "Urgency"');
  });

  it("predicted cells evaluate to pending Jev specs in a workbook", () => {
    const wb = new Workbook();
    wb.addSheet("S", 10, 5);
    wb.setCell("S", 1, 0, "The box arrived crushed and the lid was cracked.");
    wb.setCell("S", 1, 1, formulaFor(schemaById("defect")!, "Defect?", 0, 1));
    const r = wb.recalc();
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0]).toMatchObject({ kind: "judge", text: "The box arrived crushed and the lid was cracked." });
  });
});
