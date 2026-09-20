export type Point = {
  p: number;
  outcome: boolean;
  tag?: string;
};

export type Bin = {
  lo: number;
  hi: number;
  n: number;
  declared: number;
  observed: number;
};

export function reliability(points: Point[], binCount = 10): Bin[] {
  const bins: Bin[] = Array.from({ length: binCount }, (_, i) => ({
    lo: i / binCount,
    hi: (i + 1) / binCount,
    n: 0,
    declared: 0,
    observed: 0,
  }));
  for (const pt of points) {
    if (!Number.isFinite(pt.p)) continue;
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor(pt.p * binCount)));
    const b = bins[idx];
    b.n++;
    b.declared += pt.p;
    b.observed += pt.outcome ? 1 : 0;
  }
  for (const b of bins) {
    if (b.n > 0) {
      b.declared /= b.n;
      b.observed /= b.n;
    }
  }
  return bins;
}

export function ece(bins: Bin[]): number {
  const total = bins.reduce((n, b) => n + b.n, 0);
  if (total === 0) return NaN;
  return bins.reduce((sum, b) => sum + (b.n / total) * Math.abs(b.declared - b.observed), 0);
}

export function brier(points: Point[]): number {
  const usable = points.filter((p) => Number.isFinite(p.p));
  if (usable.length === 0) return NaN;
  return usable.reduce((s, p) => s + (p.p - (p.outcome ? 1 : 0)) ** 2, 0) / usable.length;
}

export function baseRate(points: Point[]): number {
  if (points.length === 0) return NaN;
  return points.filter((p) => p.outcome).length / points.length;
}

export type Operating = {
  threshold: number;
  automated: number;
  automatedShare: number;
  correct: number;
  accuracy: number;
  toHuman: number;
};

export function operatingPoints(points: Point[], thresholds: number[]): Operating[] {
  return thresholds.map((threshold) => {
    const acted = points.filter((p) => Number.isFinite(p.p) && p.p >= threshold);
    const correct = acted.filter((p) => p.outcome).length;
    return {
      threshold,
      automated: acted.length,
      automatedShare: points.length ? acted.length / points.length : 0,
      correct,
      accuracy: acted.length ? correct / acted.length : NaN,
      toHuman: points.length - acted.length,
    };
  });
}

export function reliabilityTable(bins: Bin[], width = 28): string[] {
  const lines: string[] = [];
  const total = bins.reduce((n, b) => n + b.n, 0);
  lines.push("    declared    n     observed   gap    " + "claimed vs actual".padEnd(width));
  for (const b of bins) {
    if (b.n === 0) continue;
    const gap = b.observed - b.declared;
    const dPos = Math.round(b.declared * width);
    const oPos = Math.round(b.observed * width);
    const bar = Array.from({ length: width + 1 }, (_, i) =>
      i === dPos && i === oPos ? "┃" : i === dPos ? "│" : i === oPos ? "●" : "·",
    ).join("");
    lines.push(
      `    ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}  ${String(b.n).padStart(6)}   ` +
        `${b.observed.toFixed(3)}   ${(gap >= 0 ? "+" : "") + gap.toFixed(3)}   ${bar}`,
    );
  }
  lines.push(`    ${total.toLocaleString()} points · │ claimed  ● actual  ┃ both`);
  return lines;
}

export type OrderProbe = {
  id: string;
  first: string | null;
  second: string | null;
  agree: boolean;
  confidenceFirst: number;
  confidenceSecond: number;
  maxDrift: number;
};

export function orderStats(probes: OrderProbe[]) {
  const n = probes.length;
  const agreed = probes.filter((p) => p.agree).length;
  const confident = probes.filter((p) => Math.max(p.confidenceFirst, p.confidenceSecond) >= 0.8);
  const confidentAgreed = confident.filter((p) => p.agree).length;
  const drift = probes.map((p) => p.maxDrift).sort((a, b) => a - b);
  return {
    n,
    agreed,
    agreementRate: n ? agreed / n : NaN,
    confidentN: confident.length,
    confidentAgreementRate: confident.length ? confidentAgreed / confident.length : NaN,
    medianDrift: drift.length ? drift[Math.floor(drift.length / 2)] : NaN,
    p95Drift: drift.length ? drift[Math.min(drift.length - 1, Math.ceil(0.95 * drift.length) - 1)] : NaN,
  };
}
