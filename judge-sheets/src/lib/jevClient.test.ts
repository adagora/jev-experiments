import { describe, it, expect } from "vitest";
import { answerToValue, percentile, summarize, toQuestion } from "./jevClient.ts";
import type { JevSpec } from "../engine/jev.ts";

describe("jevClient pure helpers", () => {
  it("builds typed questions from specs", () => {
    const j: JevSpec = { kind: "judge", text: "t", instructions: "Is it good?", options: [] };
    const p: JevSpec = { kind: "pick", text: "t", instructions: "Topic?", options: ["a", "b"] };
    const r: JevSpec = { kind: "rate", text: "t", instructions: "Rate", options: ["low", "high"] };
    expect(toQuestion(j)).toEqual({ type: "noul", instructions: "Is it good?" });
    expect(toQuestion(p)).toEqual({ type: "choice", instructions: "Topic?", criteria: { a: null, b: null } });
    expect(toQuestion(r)).toEqual({ type: "score", instructions: "Rate", criteria: ["low", "high"] });
  });

  it("maps answers to JevValues and rejects mismatched types", () => {
    const j: JevSpec = { kind: "judge", text: "t", instructions: "q", options: [] };
    expect(answerToValue(j, { type: "noul", noul: 0.9 })).toEqual({ jev: "judge", value: 0.9, confidence: 0.8 });
    const p: JevSpec = { kind: "pick", text: "t", instructions: "q", options: ["a", "b"] };
    expect(
      answerToValue(p, { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.8 }),
    ).toMatchObject({ jev: "pick", value: "b", confidence: 0.8 });
    const r: JevSpec = { kind: "rate", text: "t", instructions: "q", options: ["lo", "hi"] };
    expect(
      answerToValue(r, { type: "score", score: 1, legend: {}, probabilities: { "0": 0.1, "1": 0.9 }, confidence: 0.9 }),
    ).toMatchObject({ jev: "rate", value: 1, levels: ["lo", "hi"] });
    expect(answerToValue(j, { type: "choice", choice: "a", probabilities: {}, confidence: 1 })).toMatchObject({
      error: "#JEV!",
    });
  });

  it("computes percentiles", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([100], 95)).toBe(100);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(summarize([300, 100, 200])).toEqual({ p50: 200, p95: 300, min: 100, max: 300 });
  });
});
