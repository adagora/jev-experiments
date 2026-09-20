#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { PRICING, flagBool, flagList, flagNum, loadEnv, parseArgs, type Args } from "./config.ts";
import { JevClient, percentile } from "./jev/client.ts";
import { langName } from "./jev/questions.ts";
import { lintCorpus } from "./lint.ts";
import { mineGlossary } from "./mine.ts";
import { arbitrate } from "./arbitrate.ts";
import { audit, registerNorm } from "./audit.ts";
import { POLICY, compose, summarise } from "./compose.ts";
import { proposeSubstitutions, verifySubstitutions } from "./substitute.ts";
import { loadFromMongo } from "./sources/mongo.ts";
import { loadFromCsv } from "./sources/csv.ts";
import { generateSynthetic } from "./sources/synthetic.ts";
import { readDecisions, writeWorkbook } from "./report/xlsx.ts";
import { saveCache } from "./cache.ts";
import { policyNote, renderFromCache } from "./report/render.ts";
import { runReview } from "./commands/review.ts";
import { probeOrder, probeScope, orderStats, scopeStats } from "./commands/probe.ts";
import { baseRate, brier, ece, operatingPoints, reliability, reliabilityTable, type Point } from "./calibrate.ts";
import {
  applyArbitration,
  asGlossaryEntries,
  enforceable,
  guidanceByTerm,
  loadGlossary,
  mergeMined,
  saveGlossary,
} from "./glossary/store.ts";
import { fold, norm } from "./util/text.ts";
import { selectChanges, writeMongoScript, writeReimportCsv } from "./report/reimport.ts";
import { Progress, fmtMs, fmtUsd } from "./util/progress.ts";
import type { Corpus, StageStats } from "./types.ts";

loadEnv();

const USAGE = `
translate-audit — translation consistency for corpora with no glossary

  run     --mongo <db> [--projects a,b] [--langs de,uk] [--limit N]
          --csv <file> [--source pl]
          --synthetic <N>
          [--out audit.xlsx] [--save run.json] [--glossary g.json] [--register] [--no-fix] [--dry-run]
          [--concurrency 12] [--max-terms N] [--only-flagged]

  report  <run.json> [--out audit.xlsx] [--meaning-bad 0.35] [--adherence-bad 0.4]
          [--min-severity 2] [--only integrity,meaning,consistency]
          re-renders the workbook from saved judgments. No API calls, no cost.

  review  [<run.json>] [--port 8788] [--glossary g.json] [--decisions d.json]
          opens the run in a browser for translators: review queue, glossary
          curation, and a live Jev check on anything they type.

  apply   <audit.xlsx> [--out lokalise-reimport.csv] [--mongo-script apply.js --mongo-db <db>]

  score   --synthetic <N> [--langs de,uk,fr,hu]
          precision/recall against known defects, plus a reliability diagram:
          when it says 0.9, is it right nine times out of ten?

  probe   [--order N] [--scope N] [--synthetic N]
          the two properties that fail silently — does a Choice answer the same
          thing when the options are shuffled, and does it take the no-match
          outcome when the right answer was never in the list?

Environment: TYPESAFE_API_KEY (required for run/score), MONGO_URI, JEV_CONCURRENCY,
             JEV_PRICE_IN, JEV_PRICE_OUT
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "run":
      return void (await cmdRun(args));
    case "report":
      return void (await cmdReport(args));
    case "review":
      return void (await cmdReviewCmd(args));
    case "apply":
      return void (await cmdApply(args));
    case "score":
      return void (await cmdScore(args));
    case "probe":
      return void (await cmdProbe(args));
    default:
      process.stdout.write(USAGE);
      process.exitCode = args.command === "help" || args.flags.has("help") ? 0 : 1;
  }
}

async function loadCorpus(args: Args): Promise<{ corpus: Corpus; notes: string[] }> {
  const notes: string[] = [];
  const sourceLang = args.flags.get("source") ?? "pl";
  const langs = flagList(args, "langs");

  if (args.flags.has("synthetic")) {
    const n = flagNum(args, "synthetic", 2000);
    const { corpus } = generateSynthetic({
      keys: n,
      langs: langs.length ? langs : ["de", "en", "uk", "fr", "hu"],
      seed: flagNum(args, "seed", 20250920),
      defectRate: flagNum(args, "defect-rate", 0.08),
    });
    return { corpus, notes };
  }

  if (args.flags.has("csv")) {
    const path = args.flags.get("csv")!;
    if (!existsSync(path)) throw new Error(`no such file: ${path}`);
    const { corpus, encoding, lossy } = loadFromCsv({ path, sourceLang });
    if (encoding !== "utf-8") notes.push(`${path} is ${encoding}, not UTF-8 — decoded accordingly.`);
    if (lossy > 0) {
      notes.push(
        `${lossy} character${lossy === 1 ? "" : "s"} in ${path} are already "?" where a letter belongs. ` +
          `That loss happened upstream and cannot be recovered here — re-export as UTF-8 before trusting this as a reference.`,
      );
    }
    return { corpus, notes };
  }

  const db = args.flags.get("mongo");
  if (!db) throw new Error("pick a source: --mongo <db>, --csv <file> or --synthetic <N>");
  const corpus = await loadFromMongo({
    uri: process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017",
    db,
    sourceLang,
    projects: flagList(args, "projects"),
    langs,
    limit: args.flags.has("limit") ? flagNum(args, "limit", 0) : undefined,
  });
  return { corpus, notes };
}

async function cmdRun(args: Args): Promise<void> {
  const startedAt = new Date();
  const t0 = performance.now();
  const { corpus, notes } = await loadCorpus(args);
  const targets = corpus.langs.filter((l) => l !== corpus.sourceLang);

  console.log(`\n  ${corpus.origin}`);
  console.log(`  ${corpus.entries.length} keys · source ${langName(corpus.sourceLang)} · targets ${targets.join(", ")}\n`);
  for (const n of notes) console.log(`  ! ${n}`);
  if (notes.length) console.log("");

  const lint = lintCorpus(corpus);
  console.log(`  automated checks  ${lint.issues.length} exact defects`);
  for (const [code, n] of Object.entries(lint.counts).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(n).padStart(6)}  ${code}`);
  }

  const mined = mineGlossary(corpus);
  const maxTerms = args.flags.has("max-terms") ? flagNum(args, "max-terms", 0) : 0;
  const conflicts = maxTerms > 0 ? mined.conflicts.slice(0, maxTerms) : mined.conflicts;
  console.log(
    `\n  mined             ${mined.termCount} terms → ${mined.conflicts.length} contested (term, language) pairs` +
      `${maxTerms > 0 && mined.conflicts.length > maxTerms ? `, arbitrating the top ${maxTerms}` : ""}`,
  );
  console.log(`                    ${mined.resolved.length} resolved in code (spacing or case only — no request spent)`);
  console.log(`                    ${mined.agreed.size} already consistent everywhere\n`);

  if (flagBool(args, "dry-run", false)) {
    console.log("  --dry-run: stopping before any TypeSafe request.\n");
    for (const c of conflicts.slice(0, 15)) {
      console.log(`    [${c.lang}] ${c.term}: ${c.variants.map((v) => `${JSON.stringify(v.text)}×${v.count}`).join(" vs ")}`);
    }
    return;
  }

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const client = new JevClient({ apiKey, concurrency: flagNum(args, "concurrency", 12) });
  const stages: StageStats[] = [];
  const entries = new Map(corpus.entries.map((e) => [e.id, e]));
  const domain = args.flags.get("domain") ?? "a B2B product configurator and order portal for building joinery (gates, doors, fences, windows)";

  const glossaryPath = args.flags.get("glossary") ?? `${(args.flags.get("out") ?? "audit.xlsx").replace(/\.xlsx$/, "")}.glossary.json`;
  const saved = loadGlossary(glossaryPath);
  const displayFor = (term: string): string => {
    for (const e of corpus.entries) if (fold(e.source) === term) return norm(e.source);
    return term;
  };
  const merged = mergeMined(saved, conflicts, mined.resolved, displayFor);

  if (saved.length) {
    console.log(
      `  glossary          ${saved.length} terms remembered · ${merged.reused} decisions reused (no request spent)` +
        `${merged.fresh ? ` · ${merged.fresh} new` : ""}${merged.drifted.length ? ` · ${merged.drifted.length} drifted` : ""}`,
    );
    for (const d of merged.drifted.slice(0, 5)) {
      console.log(`      ! "${d.display}" [${d.lang}] was decided as "${d.canonical}" but the corpus now also uses others`);
    }
  }

  let records = merged.records;
  if (merged.needArbitration.length) {
    const p = new Progress("arbitrate");
    const r = await arbitrate(client, merged.needArbitration, entries, corpus.sourceLang, domain, (d, t) => p.update(d, t));
    p.done();
    records = applyArbitration(records, r.glossary);
    stages.push(r.stats);
  }
  saveGlossary(glossaryPath, records);

  const glossary = enforceable(records);
  const glossaryForReport = asGlossaryEntries(records);
  console.log(`                    ${glossary.length} enforceable terms of ${records.length} known`);

  const only = flagBool(args, "only-flagged", false)
    ? new Set([...lint.hardByEntry.keys(), ...glossary.flatMap((g) => g.entryIds)])
    : undefined;
  const pa = new Progress("audit");
  const auditRes = await audit(
    client,
    corpus,
    glossary,
    lint.issues,
    { register: flagBool(args, "register", true), only, guidance: guidanceByTerm(records) },
    (d, t) => pa.update(d, t),
  );
  pa.done();
  stages.push(auditRes.stats);

  const norms = registerNorm(auditRes.judgments, targets);

  let findings = compose({ corpus, lintIssues: lint.issues, judgments: auditRes.judgments, glossary, registerNorms: norms });

  if (flagBool(args, "fix", true)) {
    const proposals = proposeSubstitutions(findings, glossary);
    if (proposals.length) {
      const ps = new Progress("substitute");
      const sub = await verifySubstitutions(client, proposals, langName(corpus.sourceLang), (d, t) => ps.update(d, t));
      ps.done();
      stages.push(sub.stats);
      console.log(`                    ${sub.applied} substitutions verified, ${sub.rejected} sent to a human`);
    }
  }

  for (const f of findings) {
    if (f.action === "auto-fix" && !f.suggested) f.action = "needs human";
  }

  const summary = summarise(findings, corpus);

  const savePath = args.flags.get("save") ?? `${(args.flags.get("out") ?? "audit.xlsx").replace(/\.xlsx$/, "")}.run.json`;
  saveCache(savePath, {
    corpus,
    lintIssues: lint.issues,
    glossary: glossaryForReport,
    judgments: [...auditRes.judgments],
    registerNorms: [...norms],
    stages,
    substitutions: findings
      .filter((f) => f.suggested !== null)
      .map((f) => ({
        entryId: f.entryId,
        lang: f.lang,
        suggested: f.suggested!,
        check: f.substitutionOk ?? NaN,
        note: f.reasons.find((r) => r.startsWith("substitution")) ?? "",
      })),
  });

  const out = args.flags.get("out") ?? "audit.xlsx";
  await writeWorkbook(out, {
    corpus,
    findings,
    glossary: glossaryForReport,
    lintIssues: lint.issues,
    summary,
    stages,
    registerNorms: norms,
    pricing: PRICING,
    startedAt,
    policyNote: policyNote(POLICY),
  });

  printRun(stages, summary, out, performance.now() - t0);
  console.log(`  → ${savePath}   (re-render for free: translate-audit report ${savePath})\n`);
}

function printRun(stages: StageStats[], summary: ReturnType<typeof summarise>, out: string, wallMs: number): void {
  const requests = stages.reduce((n, s) => n + s.requests, 0);
  const judgments = stages.reduce((n, s) => n + s.judgments, 0);
  const errors = stages.reduce((n, s) => n + s.errors, 0);
  const cost = stages.reduce(
    (c, s) => c + (s.inputTokens / 1e6) * PRICING.inputPerM + (s.outputTokens / 1e6) * PRICING.outputPerM,
    0,
  );
  const lat = stages.flatMap((s) => s.latencies);

  console.log(`\n  ─────────────────────────────────────────────────────────`);
  console.log(`  ${requests} requests · ${judgments} judgments · ${errors} errors`);
  console.log(`  p50 ${Math.round(percentile(lat, 50))} ms · p95 ${Math.round(percentile(lat, 95))} ms · ${fmtMs(wallMs)} wall · ${fmtUsd(cost)}`);
  console.log(`  one LLM call per judgment at 3 s ≈ ${((judgments * 3) / 3600).toFixed(1)} h`);
  console.log(`\n  ${summary.findings} findings on ${summary.entriesTouched} of ${summary.entriesTotal} keys`);
  console.log(
    `      severity 3 ${summary.bySeverity[3]} · 2 ${summary.bySeverity[2]} · 1 ${summary.bySeverity[1]} · 0 ${summary.bySeverity[0]}`,
  );
  for (const [action, n] of summary.byAction) console.log(`      ${String(n).padStart(6)}  ${action}`);
  console.log(`\n  → ${out}`);
}

async function cmdReport(args: Args): Promise<void> {
  const path = args.positional[0] ?? args.flags.get("in");
  if (!path) throw new Error("usage: translate-audit report <run.json>");
  const only = flagList(args, "only");
  const minSeverity = flagNum(args, "min-severity", 0);

  const r = await renderFromCache({
    cachePath: path,
    out: args.flags.get("out") ?? path.replace(/\.run\.json$|\.json$/, "") + ".xlsx",
    policy: {
      meaningBad: flagNum(args, "meaning-bad", POLICY.meaningBad),
      meaningDoubtful: flagNum(args, "meaning-doubtful", POLICY.meaningDoubtful),
      adherenceBad: flagNum(args, "adherence-bad", POLICY.adherenceBad),
      uiStringMin: flagNum(args, "ui-string-min", POLICY.uiStringMin),
    },
    minSeverity,
    only: new Set(only),
    pricing: PRICING,
  });

  console.log(`\n  ${path}  (judgments saved ${r.cache.savedAt.slice(0, 19).replace("T", " ")})`);
  console.log(
    `  ${r.composed} findings composed, ${r.kept} kept` +
      `${minSeverity ? ` at severity >= ${minSeverity}` : ""}${only.length ? `, categories ${only.join(", ")}` : ""}`,
  );
  console.log(
    `      severity 3 ${r.summary.bySeverity[3]} · 2 ${r.summary.bySeverity[2]} · ` +
      `1 ${r.summary.bySeverity[1]} · 0 ${r.summary.bySeverity[0]}`,
  );
  for (const [cat, n] of r.summary.byCategory) console.log(`      ${String(n).padStart(6)}  ${cat}`);
  console.log(`\n  → ${r.out}   (0 requests, $0.00)\n`);
}

async function cmdReviewCmd(args: Args): Promise<void> {
  await runReview({
    cache: args.positional[0] ?? args.flags.get("in") ?? "audit.run.json",
    glossary: args.flags.get("glossary"),
    decisions: args.flags.get("decisions"),
    port: flagNum(args, "port", 8788),
    apiKey: process.env.TYPESAFE_API_KEY,
    concurrency: flagNum(args, "concurrency", 6),
  });
}

async function cmdApply(args: Args): Promise<void> {
  const path = args.positional[0] ?? args.flags.get("in");
  if (!path) throw new Error("usage: translate-audit apply <audit.xlsx>");
  const rows = await readDecisions(path);
  const changes = selectChanges(rows);

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.decision, (counts.get(r.decision) ?? 0) + 1);

  console.log(`\n  ${rows.length} decisions in ${path}`);
  for (const [d, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(6)}  ${d}`);
  console.log(`  ${changes.length} translations actually change\n`);

  if (!changes.length) {
    console.log("  Nothing to write.\n");
    return;
  }

  const out = args.flags.get("out") ?? "lokalise-reimport.csv";
  writeReimportCsv(out, changes);
  console.log(`  → ${out}`);

  const script = args.flags.get("mongo-script");
  if (script) {
    const targetDb = args.flags.get("mongo-db") ?? args.flags.get("mongo");
    if (!targetDb) throw new Error("--mongo-script needs --mongo-db <db> to know where to write");
    writeMongoScript(script, changes, targetDb);
    console.log(`  → ${script}  (review, then: mongosh --file ${script})`);
  }
  console.log("");
}

async function cmdScore(args: Args): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const n = flagNum(args, "synthetic", 400);
  const langs = flagList(args, "langs");
  const { corpus, truth } = generateSynthetic({
    keys: n,
    langs: langs.length ? langs : ["de", "en", "uk", "fr", "hu"],
    seed: flagNum(args, "seed", 20250920),
    defectRate: flagNum(args, "defect-rate", 0.1),
  });
  console.log(`\n  ${corpus.origin}\n`);

  const client = new JevClient({ apiKey, concurrency: flagNum(args, "concurrency", 12) });
  const lint = lintCorpus(corpus);
  const mined = mineGlossary(corpus);
  const entries = new Map(corpus.entries.map((e) => [e.id, e]));

  const pa = new Progress("arbitrate");
  const { glossary: arbitrated, stats: s1 } = await arbitrate(client, mined.conflicts, entries, corpus.sourceLang, "a product configurator for gates, doors and fences", (d, t) => pa.update(d, t));
  pa.done();
  const glossary = [...mined.resolved, ...arbitrated];

  const pb = new Progress("audit");
  const auditRes = await audit(client, corpus, glossary, lint.issues, { register: true }, (d, t) => pb.update(d, t));
  pb.done();

  const norms = registerNorm(auditRes.judgments, corpus.langs.filter((l) => l !== corpus.sourceLang));
  const findings = compose({ corpus, lintIssues: lint.issues, judgments: auditRes.judgments, glossary, registerNorms: norms });

  const flagged = new Set(findings.map((f) => `${f.entryId}\u0000${f.lang}`));
  const truthSet = new Set(truth.map((t) => `${t.entryId}\u0000${t.lang}`));
  const caught = [...truthSet].filter((k) => flagged.has(k)).length;
  const extra = [...flagged].filter((k) => !truthSet.has(k)).length;

  console.log(`\n  injected defects : ${truthSet.size}`);
  console.log(`  caught           : ${caught}  (recall ${((100 * caught) / Math.max(1, truthSet.size)).toFixed(1)}%)`);
  console.log(`  flagged total    : ${flagged.size}`);
  console.log(`  not injected     : ${extra}  (precision ${((100 * caught) / Math.max(1, flagged.size)).toFixed(1)}%)`);

  const extraReasons = new Map<string, number>();
  const extraSeverity = [0, 0, 0, 0];
  for (const f of findings) {
    if (truthSet.has(`${f.entryId}\u0000${f.lang}`)) continue;
    extraSeverity[Math.min(3, Math.round(f.severity))]++;
    for (const r of f.reasons) {
      const head = r.split(" —")[0].split(" (")[0];
      extraReasons.set(head, (extraReasons.get(head) ?? 0) + 1);
    }
  }
  console.log("\n  what the not-injected flags were:");
  for (const [r, n] of [...extraReasons].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(5)}  ${r}`);
  console.log(`      severity 3 ${extraSeverity[3]} · 2 ${extraSeverity[2]} · 1 ${extraSeverity[1]} · 0 ${extraSeverity[0]}`);

  const actionable = findings.filter((f) => f.severity >= 2);
  const actionableHits = actionable.filter((f) => truthSet.has(`${f.entryId}\u0000${f.lang}`)).length;
  console.log(
    `\n  at severity >= 2 only: ${actionable.length} findings, ${actionableHits} injected ` +
      `(precision ${((100 * actionableHits) / Math.max(1, actionable.length)).toFixed(1)}%, ` +
      `recall ${((100 * actionableHits) / Math.max(1, truthSet.size)).toFixed(1)}%)`,
  );

  const byDefect = new Map<string, { n: number; caught: number }>();
  for (const t of truth) {
    const rec = byDefect.get(t.defect) ?? { n: 0, caught: 0 };
    rec.n++;
    if (flagged.has(`${t.entryId}\u0000${t.lang}`)) rec.caught++;
    byDefect.set(t.defect, rec);
  }
  console.log("\n  by defect type:");
  for (const [d, r] of [...byDefect].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`      ${d.padEnd(22)} ${String(r.caught).padStart(4)}/${String(r.n).padEnd(4)} ${((100 * r.caught) / r.n).toFixed(0)}%`);
  }

  const MEANING_DEFECTS = new Set(["negation-dropped", "term-inconsistency"]);
  const meaningTruth = new Set(
    truth.filter((t) => MEANING_DEFECTS.has(t.defect)).map((t) => `${t.entryId}\u0000${t.lang}`),
  );
  const points: Point[] = [];
  for (const [entryId, j] of auditRes.judgments) {
    for (const [l, p] of Object.entries(j.meaning)) {
      if (!Number.isFinite(p)) continue;
      points.push({ p, outcome: !meaningTruth.has(`${entryId}\u0000${l}`), tag: l });
    }
  }

  const bins = reliability(points);
  console.log("\n  calibration of `meaning` — when it says 0.9, is it right 9 times in 10?");
  for (const line of reliabilityTable(bins)) console.log("  " + line);
  console.log(
    `    expected calibration error ${ece(bins).toFixed(3)} · Brier ${brier(points).toFixed(3)} · ` +
      `base rate ${baseRate(points).toFixed(3)}`,
  );

  console.log("\n  if strings above a `meaning` threshold skipped review:");
  console.log("      threshold   unreviewed   of traffic   correct   wrong   to a human");
  for (const op of operatingPoints(points, [0.5, 0.8, 0.9, 0.95, 0.99])) {
    const wrong = op.automated - op.correct;
    console.log(
      `      ${op.threshold.toFixed(2)}        ${String(op.automated).padStart(6)}      ` +
        `${(100 * op.automatedShare).toFixed(1).padStart(5)}%     ` +
        `${(100 * op.accuracy).toFixed(1).padStart(5)}%   ${String(wrong).padStart(5)}   ${String(op.toHuman).padStart(6)}`,
    );
  }

  const cost = [s1, auditRes.stats].reduce(
    (c, s) => c + (s.inputTokens / 1e6) * PRICING.inputPerM + (s.outputTokens / 1e6) * PRICING.outputPerM,
    0,
  );
  console.log(`\n  ${s1.requests + auditRes.stats.requests} requests · ${fmtUsd(cost)}\n`);
}

async function cmdProbe(args: Args): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const client = new JevClient({ apiKey, concurrency: flagNum(args, "concurrency", 8) });

  const { corpus } = generateSynthetic({
    keys: flagNum(args, "synthetic", 600),
    langs: flagList(args, "langs").length ? flagList(args, "langs") : ["de", "uk", "fr"],
    seed: flagNum(args, "seed", 20250920),
    defectRate: 0.35,
  });
  const entries = new Map(corpus.entries.map((e) => [e.id, e]));
  const mined = mineGlossary(corpus);
  const usable = mined.conflicts.filter((c) => c.variants.length >= 2);
  console.log(`\n  ${corpus.origin}`);
  console.log(`  ${usable.length} contested terms available to probe\n`);

  const orderN = Math.min(flagNum(args, "order", 40), usable.length);
  if (orderN > 0) {
    const po = new Progress("order");
    const { probes, ms } = await probeOrder(client, usable.slice(0, orderN), entries, corpus.sourceLang, (d, t) =>
      po.update(d, t),
    );
    po.done();
    const st = orderStats(probes);
    console.log(`\n  option order — the same question twice, options reversed`);
    console.log(`      same answer both ways   ${st.agreed}/${st.n}  (${(100 * st.agreementRate).toFixed(1)}%)`);
    console.log(
      `      when either was >=0.80  ${st.confidentN ? `${(100 * st.confidentAgreementRate).toFixed(1)}%` : "—"}` +
        `  over ${st.confidentN} terms`,
    );
    console.log(`      probability drift       median ${st.medianDrift.toFixed(3)} · p95 ${st.p95Drift.toFixed(3)}`);
    for (const p of probes.filter((x) => !x.agree).slice(0, 5)) {
      console.log(`      ! ${p.id}: "${p.first}" (${p.confidenceFirst.toFixed(2)}) vs "${p.second}" (${p.confidenceSecond.toFixed(2)})`);
    }
    console.log(`      ${fmtMs(ms)}`);
  }

  const scopeN = Math.min(flagNum(args, "scope", 40), usable.length);
  if (scopeN > 0) {
    const byLang = new Map<string, typeof usable>();
    for (const c of usable) {
      const list = byLang.get(c.lang);
      if (list) list.push(c);
      else byLang.set(c.lang, [c]);
    }
    const cases = usable
      .slice(0, scopeN)
      .map((c) => {
        const others = (byLang.get(c.lang) ?? []).filter((o) => o.term !== c.term);
        const distractors = others.slice(0, 3).map((o) => o.variants[0]);
        return distractors.length >= 2
          ? { id: `${c.term}/${c.lang}`, lang: c.lang, term: c.term, keep: distractors }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const ps = new Progress("scope");
    const { probes, ms } = await probeScope(client, cases, (d, t) => ps.update(d, t));
    ps.done();
    const st = scopeStats(probes);
    console.log(`\n  out of scope — the best rendering removed from the options`);
    console.log(`      took the no-match option        ${st.caught}/${st.n}  (${(100 * st.caughtRate).toFixed(1)}%)`);
    console.log(`      a separate yes/no noticed it    ${st.presenceCaught}/${st.presenceN}  (${(100 * st.presenceRate).toFixed(1)}%)`);
    console.log(`      picked a loser at >=0.80        ${st.confidentlyWrong}`);
    console.log(`      mean confidence when it picked  ${st.meanConfidenceWhenWrong.toFixed(2)}`);
    console.log(
      `\n      A Choice is relative — it always points at something, so confidence means\n` +
        `      "this option beat the others", not "this option is good". Only the explicit\n` +
        `      no-match outcome, or a separate presence question, can report a missing answer.`,
    );
    console.log(`      ${fmtMs(ms)}`);
  }
  console.log("");
}

main().catch((e: unknown) => {
  console.error(`\n  error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
