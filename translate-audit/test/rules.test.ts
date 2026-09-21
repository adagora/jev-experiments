import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_GATES } from "../src/config/profile.ts";
import { find, has, legacy, renderReason, ruleLabel, RULE_LABELS, type Reason, type RuleId } from "../src/policy/rules.ts";

/**
 * Reasons became data so that policy would stop parsing prose it had written.
 * The English must not have moved: these are the exact strings the string-building
 * version produced, so a reviewer's "Why" column is unchanged by the refactor.
 */
describe("rendered reasons are byte-identical to the prose they replaced", () => {
  const cases: [Reason, string][] = [
    [
      { rule: "lint", code: "placeholder-mismatch", detail: "{0}: 1→0" },
      "placeholder-mismatch — {0}: 1→0",
    ],
    [{ rule: "lint", code: "case-inconsistent", detail: "source is title, translation is lower" },
      "case-inconsistent — source is title, translation is lower"],
    [{ rule: "no-translation" }, "no translation"],
    [{ rule: "untranslated-copy", sourceLang: "pl" }, "identical to the pl source"],
    [
      { rule: "duplicate-source-divergent", detail: '"Löschen" vs "Entfernen"' },
      'same source translated differently elsewhere — "Löschen" vs "Entfernen"',
    ],
    [
      { rule: "spacing-variant", detail: '"a b" vs "a  b"' },
      'spacing or case varies between otherwise identical translations — "a b" vs "a  b"',
    ],
    [
      { rule: "meaning-not-preserved", p: 0.04, threshold: 0.35 },
      "meaning not preserved (p=0.04) — check negation, quantity and condition",
    ],
    [{ rule: "meaning-uncertain", p: 0.5, threshold: 0.7 }, "meaning uncertain (p=0.50)"],
    [
      { rule: "canonical-not-used", p: 0.22, threshold: 0.4, terms: [{ term: "usun", canonical: "Löschen" }] },
      'does not use the canonical term ("usun" → "Löschen") (p=0.22)',
    ],
    [
      {
        rule: "canonical-not-used",
        p: 0.22,
        threshold: 0.4,
        terms: [
          { term: "usun", canonical: "Löschen" },
          { term: "brama", canonical: "Tor" },
        ],
      },
      'does not use the canonical term ("usun" → "Löschen", "brama" → "Tor") (p=0.22)',
    ],
    // the group can be empty, and the parenthesis goes with it
    [{ rule: "canonical-not-used", p: 0.22, threshold: 0.4, terms: [] }, "does not use the canonical term (p=0.22)"],
    [
      { rule: "register-drift", lang: "de", house: "formal", observed: "informal", share: 0.95, confidence: 0.9 },
      "register drift — 95% of de strings that address the reader are formal, this one is informal (confidence 0.90)",
    ],
    [
      { rule: "not-user-facing", p: 0.1, threshold: 0.25 },
      "(not a user-facing string, p=0.10 — cosmetic checks only)",
    ],
    [
      { rule: "not-judged", stage: "audit" },
      "not judged — the audit request for this key did not come back, so only the exact checks ran",
    ],
    [
      { rule: "substitution-verified", from: "Entfernen", to: "Löschen", grammatical: 0.9, preserved: 0.95, improved: 0.8 },
      'substitution "Entfernen" → "Löschen" verified (grammatical 0.90, meaning 0.95, better 0.80)',
    ],
    [
      {
        rule: "substitution-rejected",
        from: "Entfernen",
        to: "Löschen",
        grammatical: 0.5,
        preserved: 0.9,
        improved: 0.3,
        gates: DEFAULT_GATES,
      },
      // only the gates that actually failed are named
      'substitution "Entfernen" → "Löschen" rejected (grammar 0.50, not an improvement 0.30)',
    ],
    [
      { rule: "substitution-unverified", from: "Entfernen", to: "Löschen" },
      'substitution proposed ("Entfernen" → "Löschen") but could not be verified',
    ],
    [legacy("something a v1 run said"), "something a v1 run said"],
  ];

  for (const [reason, expected] of cases) {
    it(reason.rule + ("code" in reason ? `/${reason.code}` : ""), () => {
      expect(renderReason(reason)).toBe(expected);
    });
  }

  it("renders every rule in the union", () => {
    const rendered = new Set(cases.map(([r]) => r.rule));
    expect(Object.keys(RULE_LABELS).filter((k) => !rendered.has(k as RuleId))).toEqual([]);
  });
});

describe("rules are the grouping key", () => {
  it("groups a lint reason by its code, not by one label for all of them", () => {
    expect(ruleLabel({ rule: "lint", code: "tag-mismatch", detail: "x" })).toBe("tag-mismatch");
    expect(ruleLabel({ rule: "meaning-uncertain", p: 0.5, threshold: 0.7 })).toBe("meaning uncertain");
  });

  it("finds a reason by rule with its arguments intact", () => {
    const reasons: Reason[] = [
      { rule: "no-translation" },
      { rule: "substitution-verified", from: "a", to: "b", grammatical: 0.9, preserved: 0.9, improved: 0.9 },
    ];
    expect(has(reasons, "substitution-verified")).toBe(true);
    expect(has(reasons, "substitution-rejected")).toBe(false);
    expect(find(reasons, "substitution-verified")?.to).toBe("b");
    expect(find(reasons, "meaning-uncertain")).toBeUndefined();
  });

  it("is unaffected by rewording, which is the whole point", () => {
    // Two reasons that render to very different English are still one rule.
    const a: Reason = { rule: "meaning-not-preserved", p: 0.04, threshold: 0.35 };
    const b: Reason = { rule: "meaning-not-preserved", p: 0.31, threshold: 0.35 };
    expect(renderReason(a)).not.toBe(renderReason(b));
    expect(a.rule).toBe(b.rule);
  });
});

describe("policy never reads a reason's text", () => {
  it("has no prose matching left in src or server", () => {
    const root = resolve(import.meta.dirname, "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (name === "node_modules" || name === ".git") return [];
        if (statSync(full).isDirectory()) return walk(full);
        return /\.tsx?$/.test(name) ? [full] : [];
      });

    // `reasons` being matched against a string literal is the bug this stage removed.
    const prosePatterns = [/reasons\s*\.\s*some\s*\(\s*\(?\w+\)?\s*=>\s*\w+\s*\.\s*(startsWith|includes)\s*\(/, /reasons\s*\.\s*includes\s*\(/];
    const offenders: string[] = [];
    for (const dir of ["src", "server"]) {
      for (const file of walk(join(root, dir))) {
        // comments quote the old code on purpose; only live code counts
        const code = readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (prosePatterns.some((re) => re.test(code))) offenders.push(file.slice(root.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
