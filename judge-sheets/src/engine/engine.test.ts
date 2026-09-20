import { describe, it, expect } from "vitest";
import { parseFormula, shiftFormula, tokenize } from "./parser.ts";
import { colToName, nameToCol, parseA1 } from "./refs.ts";
import { makeCriterion } from "./functions.ts";
import { Workbook } from "./workbook.ts";
import { batchSpecs, jevKey, splitOptions, type JevSpec } from "./jev.ts";
import { isError, isPending, type JevValue } from "./values.ts";

describe("refs", () => {
  it("round-trips column names", () => {
    expect(colToName(0)).toBe("A");
    expect(colToName(25)).toBe("Z");
    expect(colToName(26)).toBe("AA");
    expect(nameToCol("AA")).toBe(26);
    expect(nameToCol("Z")).toBe(25);
  });
  it("parses absolute refs", () => {
    expect(parseA1("$C2")).toEqual({ col: 2, row: 1, absCol: true, absRow: false });
    expect(parseA1("D$1")).toEqual({ col: 3, row: 0, absCol: false, absRow: true });
    expect(parseA1("SUM")).toBeNull();
  });
});

describe("parser", () => {
  it("tokenizes strings with escaped quotes and operators", () => {
    const t = tokenize('CONCAT("a""b", A1) <> 3');
    expect(t.map((x) => x.kind)).toEqual(["ident", "lparen", "str", "comma", "ref", "rparen", "op", "num"]);
    expect((t[2] as { value: string }).value).toBe('a"b');
  });
  it("respects precedence", () => {
    const ast = parseFormula("1 + 2 * 3 ^ 2");
    expect(ast).toMatchObject({ type: "binary", op: "+", right: { op: "*", right: { op: "^" } } });
  });
  it("parses ranges and sheet refs", () => {
    expect(parseFormula("SUM(Leads!A1:B2)")).toMatchObject({
      type: "call",
      name: "SUM",
      args: [{ type: "range", sheet: "Leads", start: { row: 0, col: 0 }, end: { row: 1, col: 1 } }],
    });
  });
  it("shifts relative refs for fill-down but keeps absolute ones", () => {
    expect(shiftFormula('RATE($C2,"sentiment",$L$1)', 5, 0)).toBe('RATE($C7,"sentiment",$L$1)');
    expect(shiftFormula("A1+B$1", 2, 1)).toBe("B3+C$1");
    expect(shiftFormula("Leads!A1", 1, 0)).toBe("Leads!A2");
  });
});

describe("criteria", () => {
  it("handles comparison and wildcard criteria", () => {
    expect(makeCriterion(">0.5")(0.7)).toBe(true);
    expect(makeCriterion(">0.5")(0.5)).toBe(false);
    expect(makeCriterion("<>quality")("price")).toBe(true);
    expect(makeCriterion("quality")("Quality")).toBe(true);
    expect(makeCriterion("qual*")("quality")).toBe(true);
    expect(makeCriterion(3)(3)).toBe(true);
    expect(makeCriterion(">2")({ jev: "rate", value: 2.6, confidence: 0.9 })).toBe(true);
  });
});

function wb() {
  const w = new Workbook();
  w.addSheet("S", 50, 10);
  return w;
}

describe("workbook", () => {
  it("evaluates standard functions and literals", () => {
    const w = wb();
    w.setCell("S", 0, 0, "10");
    w.setCell("S", 1, 0, "20");
    w.setCell("S", 2, 0, "=SUM(A1:A2)*2");
    w.setCell("S", 3, 0, '=IF(A3>50,"HOT","")');
    w.setCell("S", 4, 0, '=UPPER(CONCAT("x",LEN("abc")))');
    w.setCell("S", 5, 0, "=AVERAGE(A1:A2)");
    w.setCell("S", 6, 0, '=COUNTIF(A1:A2,">15")');
    w.setCell("S", 7, 0, "=AND(TRUE,A1=10)");
    w.setCell("S", 8, 0, "=OR(FALSE,A1=11)");
    w.recalc();
    expect(w.getValue("S", 2, 0)).toBe(60);
    expect(w.getValue("S", 3, 0)).toBe("HOT");
    expect(w.getValue("S", 4, 0)).toBe("X3");
    expect(w.getValue("S", 5, 0)).toBe(15);
    expect(w.getValue("S", 6, 0)).toBe(1);
    expect(w.getValue("S", 7, 0)).toBe(true);
    expect(w.getValue("S", 8, 0)).toBe(false);
  });

  it("only recalculates dirty cells and propagates through the dependency graph", () => {
    const w = wb();
    w.setCell("S", 0, 0, "1");
    w.setCell("S", 0, 1, "=A1+1");
    w.setCell("S", 0, 2, "=B1+1");
    w.setCell("S", 5, 5, "=99");
    expect(w.recalc().evaluated).toBe(4);
    w.setCell("S", 0, 0, "5");
    const r = w.recalc();
    expect(r.evaluated).toBe(3);
    expect(w.getValue("S", 0, 2)).toBe(7);
    expect(r.changed.has("S!5:5")).toBe(false);
  });

  it("marks range dependents dirty when a cell inside the range changes", () => {
    const w = wb();
    w.setCell("S", 0, 0, "1");
    w.setCell("S", 1, 0, "2");
    w.setCell("S", 9, 0, "=SUM(A1:A5)");
    w.recalc();
    expect(w.getValue("S", 9, 0)).toBe(3);
    w.setCell("S", 3, 0, "10");
    expect(w.recalc().evaluated).toBe(2);
    expect(w.getValue("S", 9, 0)).toBe(13);
  });

  it("reports cycles and errors", () => {
    const w = wb();
    w.setCell("S", 0, 0, "=B1");
    w.setCell("S", 0, 1, "=A1");
    w.setCell("S", 0, 2, "=1/0");
    w.setCell("S", 0, 3, "=NOPE(1)");
    w.recalc();
    expect(w.getValue("S", 0, 0)).toMatchObject({ error: "#CYCLE!" });
    expect(w.getValue("S", 0, 2)).toMatchObject({ error: "#DIV/0!" });
    expect(w.getValue("S", 0, 3)).toMatchObject({ error: "#NAME?" });
  });

  it("collects pending Jev specs, resolves them, and caches by (text, question)", () => {
    const w = wb();
    w.setCell("S", 0, 0, "Great blender, broke after a week");
    w.setCell("S", 0, 1, '=JUDGE(A1,"Does it mention a defect?")');
    w.setCell("S", 0, 2, '=PICK(A1,"Main topic","shipping|quality|price")');
    w.setCell("S", 0, 3, '=RATE(A1,"Sentiment","negative|neutral|positive")');
    w.setCell("S", 0, 4, '=IF(D1>1,"POS","NEG")');
    w.setCell("S", 2, 1, "=AVERAGE(B1:B2)");
    const r1 = w.recalc();
    expect(r1.pending).toHaveLength(3);
    expect(isPending(w.getValue("S", 0, 1))).toBe(true);
    expect(isPending(w.getValue("S", 0, 4))).toBe(true);
    // aggregates skip pending cells instead of erroring
    expect(w.getValue("S", 2, 1)).toMatchObject({ error: "#DIV/0!" });

    const spec = r1.pending.find((s) => s.kind === "rate")!;
    expect(spec.options).toEqual(["negative", "neutral", "positive"]);
    const rate: JevValue = { jev: "rate", value: 1.8, confidence: 0.8 };
    w.resolveJev(jevKey(spec), rate);
    const judgeSpec = r1.pending.find((s) => s.kind === "judge")!;
    w.resolveJev(jevKey(judgeSpec), { jev: "judge", value: 0.93, confidence: 0.86 });
    const r2 = w.recalc();
    expect(r2.pending).toHaveLength(0); // PICK is still in flight, not re-requested
    expect(w.getValue("S", 0, 3)).toEqual(rate);
    expect(w.getValue("S", 0, 4)).toBe("POS");
    expect(w.getValue("S", 2, 1)).toBeCloseTo(0.93);

    // Same text + same question elsewhere is a cache hit: nothing pending.
    w.setCell("S", 5, 5, '=JUDGE(A1,"Does it mention a defect?")');
    const r3 = w.recalc();
    expect(r3.pending.filter((s) => s.kind === "judge")).toHaveLength(0);
    expect(w.getValue("S", 5, 5)).toMatchObject({ value: 0.93 });

    // Editing the question text is a miss.
    w.setCell("S", 5, 5, '=JUDGE(A1,"Does it mention shipping damage?")');
    expect(w.recalc().pending.some((s) => s.instructions.includes("shipping"))).toBe(true);
  });

  it("returns blank for empty text and errors for bad option lists", () => {
    const w = wb();
    w.setCell("S", 0, 1, '=JUDGE(A1,"question?")');
    w.setCell("S", 0, 2, '=PICK("hello","q","onlyone")');
    const r = w.recalc();
    expect(r.pending).toHaveLength(0);
    expect(w.getValue("S", 0, 1)).toBeNull();
    expect(isError(w.getValue("S", 0, 2))).toBe(true);
  });
});

describe("batching", () => {
  it("groups questions about the same text into one request", () => {
    const specs: JevSpec[] = [
      { kind: "judge", text: "t1", instructions: "q1", options: [] },
      { kind: "pick", text: "t1", instructions: "q2", options: ["a", "b"] },
      { kind: "judge", text: "t2", instructions: "q1", options: [] },
    ];
    const batches = batchSpecs(specs);
    expect(batches).toHaveLength(2);
    expect(batches[0].specs).toHaveLength(2);
    expect(splitOptions(" a | b|c ")).toEqual(["a", "b", "c"]);
  });
});
