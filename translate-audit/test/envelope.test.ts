import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { envelope, render, type Envelope } from "../src/report/envelope.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(ROOT, "src/cli.ts");
const NODE_ARGS = ["--experimental-strip-types", "--no-warnings", CLI];

/**
 * The human text is rendered from the envelope rather than written beside it, so a test
 * on the rendering is a test on the machine-readable shape too. Under `--json` stdout is
 * the envelope and nothing else — that is what makes the tool drivable by a caller that
 * does not want to parse paragraphs.
 */
describe("render is a projection of the envelope", () => {
  const fixture: Envelope = envelope("report", {
    inputs: { run: "audit.run.json", model: "jev-latest" },
    coverage: { attempted: 100, answered: 90, failed: 10, skipped: 4 },
    counts: { composed: 12, kept: 7 },
    groups: { "by severity": [["severity 3", 2], ["severity 2", 5]] },
    tables: [
      {
        title: "by stage",
        columns: ["stage", "requests", "cost"],
        rows: [
          ["audit", 90, "$1.20"],
          ["arbitrate", 10, "$0.10"],
        ],
        note: "cost at the prices this run used",
      },
    ],
    outputs: { workbook: "audit.xlsx" },
    warnings: [{ code: "partial-coverage", detail: "10 requests never came back" }],
    next: ["translate-audit review audit.run.json"],
  });

  it("renders every section, in order", () => {
    expect(render(fixture)).toBe(
      [
        "",
        "  run  audit.run.json",
        "  model  jev-latest",
        "",
        "  ! 10 requests never came back",
        "",
        "  coverage 90.0% — 90 of 100 answered, 10 never came back. Counts below are a floor.",
        "",
        "  composed  12",
        "  kept      7",
        "",
        "  by severity",
        "    severity 3       2",
        "    severity 2       5",
        "",
        "  by stage",
        // numeric columns right-align, headers included
        "    stage      requests   cost",
        "    audit            90  $1.20",
        "    arbitrate        10  $0.10",
        "    cost at the prices this run used",
        "",
        "  → audit.xlsx   (workbook)",
        "",
        "  next",
        "    translate-audit review audit.run.json",
        "",
      ].join("\n"),
    );
  });

  it("says coverage is complete without qualifying the counts", () => {
    const full = envelope("run", { coverage: { attempted: 50, answered: 50, failed: 0, skipped: 3 } });
    expect(render(full)).toContain("coverage 100.0% — 50 of 50 answered, 3 skipped");
    expect(render(full)).not.toContain("floor");
  });

  it("leaves out sections that carry nothing", () => {
    const bare = envelope("apply", { counts: { decisions: 0 } });
    expect(render(bare).trim()).toBe("decisions  0");
  });
});

describe("stdout carries the envelope and nothing else", () => {
  // `run --dry-run` spends nothing and needs no API key.
  const args = [...NODE_ARGS, "run", "--synthetic", "80", "--langs", "de,uk", "--dry-run"];

  it("emits one parseable JSON object under --json", async () => {
    const { stdout, stderr } = await run(process.execPath, [...args, "--json"], { cwd: ROOT });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("run");
    expect(parsed.inputs.mode).toBe("dry-run");
    expect(parsed.counts["exact defects"]).toBeGreaterThan(0);
    expect(Array.isArray(parsed.next)).toBe(true);
    // the narration went somewhere, and it was not stdout
    expect(stderr).toContain("automated checks");
    expect(stdout).not.toContain("automated checks");
  });

  it("renders the same envelope as text without --json", async () => {
    const { stdout } = await run(process.execPath, args, { cwd: ROOT });
    expect(stdout).toContain("exact defects");
    expect(stdout).toContain("contested terms (first 15)");
    expect(() => JSON.parse(stdout)).toThrow();
  });

  it("reports a bad invocation as a failed envelope rather than a stack trace", async () => {
    const bad = [...NODE_ARGS, "report", "--json"];
    const { stdout } = await run(process.execPath, bad, { cwd: ROOT }).catch((e: { stdout: string }) => e);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.warnings[0].detail).toContain("usage: translate-audit report");
  });
}, 30_000);
