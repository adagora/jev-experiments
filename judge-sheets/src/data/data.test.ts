import { describe, it, expect } from "vitest";
import { generateLeads, generateReviews } from "./generate.ts";
import { buildWorkbook, LEAD_COUNT, REVIEW_COUNT } from "./workbook.ts";
import { batchSpecs } from "../engine/jev.ts";

describe("fixtures", () => {
  it("are deterministic and mostly unique", () => {
    const a = generateReviews(300);
    const b = generateReviews(300);
    expect(a).toEqual(b);
    expect(new Set(a.map((r) => r.text)).size).toBeGreaterThan(250);
    const l = generateLeads(150);
    expect(new Set(l.map((r) => r.text)).size).toBeGreaterThan(120);
  });

  it("seeded workbook asks one request per distinct text with all questions fanned out", () => {
    const wb = buildWorkbook();
    const r = wb.recalc();
    const reviewSpecs = r.pending.filter((s) => s.text.length > 0);
    expect(reviewSpecs.length).toBeGreaterThan(0);
    const batches = batchSpecs(r.pending);
    const reviewTexts = new Set(generateReviews(REVIEW_COUNT).map((x) => x.text));
    const leadTexts = new Set(generateLeads(LEAD_COUNT).map((x) => x.text));
    expect(batches.length).toBe(reviewTexts.size + leadTexts.size);
    const reviewBatch = batches.find((b) => reviewTexts.has(b.text))!;
    expect(reviewBatch.specs.map((s) => s.kind)).toEqual(["rate"]);
    const leadBatch = batches.find((b) => leadTexts.has(b.text))!;
    expect(leadBatch.specs.map((s) => s.kind)).toEqual(["pick"]);
    // Summary block evaluates without Jev answers (pending cells are skipped)
    expect(wb.getValue("Reviews", 1, 7)).toBe(0);
  });
});
