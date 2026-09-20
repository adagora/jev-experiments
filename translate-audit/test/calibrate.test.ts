import { describe, expect, it } from "vitest";
import {
  baseRate,
  brier,
  ece,
  operatingPoints,
  orderStats,
  reliability,
  reliabilityTable,
  type OrderProbe,
  type Point,
} from "../src/calibrate.ts";

const honest = (p: number, n: number): Point[] =>
  Array.from({ length: n }, (_, i) => ({ p, outcome: i < Math.round(p * n) }));

describe("reliability", () => {
  it("puts each point in the bin its probability falls in", () => {
    const bins = reliability([{ p: 0.05, outcome: true }, { p: 0.95, outcome: false }], 10);
    expect(bins[0].n).toBe(1);
    expect(bins[9].n).toBe(1);
    expect(bins.filter((b) => b.n > 0)).toHaveLength(2);
  });

  it("puts 1.0 in the last bin rather than off the end", () => {
    const bins = reliability([{ p: 1, outcome: true }], 10);
    expect(bins[9].n).toBe(1);
    expect(bins[9].observed).toBe(1);
  });

  it("reports observed frequency, not the claim", () => {
    const bins = reliability(honest(0.8, 100), 10);
    const b = bins.find((x) => x.n > 0)!;
    expect(b.declared).toBeCloseTo(0.8, 5);
    expect(b.observed).toBeCloseTo(0.8, 2);
  });

  it("ignores points with no probability", () => {
    expect(reliability([{ p: NaN, outcome: true }, { p: 0.5, outcome: true }]).reduce((n, b) => n + b.n, 0)).toBe(1);
  });
});

describe("expected calibration error", () => {
  it("is zero for a perfectly honest predictor", () => {
    const points = [...honest(0.1, 100), ...honest(0.5, 100), ...honest(0.9, 100)];
    expect(ece(reliability(points))).toBeLessThan(0.01);
  });

  it("is large for a confidently wrong one", () => {
    const points: Point[] = Array.from({ length: 100 }, () => ({ p: 0.99, outcome: false }));
    expect(ece(reliability(points))).toBeGreaterThan(0.9);
  });

  it("weights bins by how many points fell in them", () => {
    const points = [...honest(0.9, 999), { p: 0.99, outcome: false }];
    expect(ece(reliability(points))).toBeLessThan(0.1);
  });

  it("is NaN when there is nothing to grade", () => {
    expect(Number.isNaN(ece(reliability([])))).toBe(true);
  });
});

describe("brier and base rate", () => {
  it("rewards being both right and sure", () => {
    const sure: Point[] = Array.from({ length: 50 }, () => ({ p: 1, outcome: true }));
    const hedged: Point[] = Array.from({ length: 50 }, () => ({ p: 0.6, outcome: true }));
    expect(brier(sure)).toBeCloseTo(0, 6);
    expect(brier(hedged)).toBeCloseTo(0.16, 6);
  });

  it("punishes being sure and wrong hardest", () => {
    expect(brier([{ p: 1, outcome: false }])).toBeCloseTo(1, 6);
  });

  it("base rate is the share of outcomes that happened", () => {
    expect(baseRate([{ p: 0.1, outcome: true }, { p: 0.1, outcome: false }])).toBe(0.5);
  });
});

describe("operating points", () => {
  const points: Point[] = [
    ...Array.from({ length: 60 }, () => ({ p: 0.95, outcome: true })),
    ...Array.from({ length: 10 }, () => ({ p: 0.85, outcome: true })),
    ...Array.from({ length: 5 }, () => ({ p: 0.85, outcome: false })),
    ...Array.from({ length: 25 }, () => ({ p: 0.3, outcome: false })),
  ];

  it("reports how much work goes away and how often it was wrong", () => {
    const [at90, at80] = operatingPoints(points, [0.9, 0.8]);
    expect(at90.automated).toBe(60);
    expect(at90.accuracy).toBe(1);
    expect(at90.toHuman).toBe(40);

    expect(at80.automated).toBe(75);
    expect(at80.correct).toBe(70);
    expect(at80.accuracy).toBeCloseTo(70 / 75, 6);
  });

  it("a threshold nothing clears automates nothing", () => {
    const [op] = operatingPoints(points, [0.99]);
    expect(op.automated).toBe(0);
    expect(op.toHuman).toBe(points.length);
    expect(Number.isNaN(op.accuracy)).toBe(true);
  });

  it("raising the threshold never lowers accuracy here", () => {
    const ops = operatingPoints(points, [0.2, 0.5, 0.9]);
    expect(ops[0].accuracy).toBeLessThanOrEqual(ops[2].accuracy);
  });
});

describe("order probes", () => {
  const probe = (over: Partial<OrderProbe> = {}): OrderProbe => ({
    id: "t/de",
    first: "A",
    second: "A",
    agree: true,
    confidenceFirst: 0.9,
    confidenceSecond: 0.9,
    maxDrift: 0.01,
    ...over,
  });

  it("separates overall agreement from agreement when confident", () => {
    const st = orderStats([
      probe(),
      probe({ id: "b", first: "A", second: "B", agree: false, confidenceFirst: 0.4, confidenceSecond: 0.4 }),
    ]);
    expect(st.agreementRate).toBe(0.5);
    expect(st.confidentN).toBe(1);
    expect(st.confidentAgreementRate).toBe(1);
  });

  it("reports drift at the median and the tail", () => {
    const st = orderStats([probe({ maxDrift: 0.01 }), probe({ maxDrift: 0.02 }), probe({ maxDrift: 0.9 })]);
    expect(st.medianDrift).toBe(0.02);
    expect(st.p95Drift).toBe(0.9);
  });
});

describe("the table", () => {
  it("draws only the bins that have points, plus a legend", () => {
    const lines = reliabilityTable(reliability([...honest(0.9, 10), ...honest(0.1, 10)]));
    expect(lines[0]).toContain("declared");
    expect(lines).toHaveLength(2 + 2);
    expect(lines[lines.length - 1]).toContain("claimed");
  });
});
