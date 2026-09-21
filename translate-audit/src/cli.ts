#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { flagBool, flagList, flagNum, loadEnv, parseArgs, type Args } from "./config/args.ts";
import { loadProfile, policyNote, type Profile } from "./config/profile.ts";
import { JevClient, percentile } from "./jev/client.ts";
import { langName, questionsFingerprint } from "./jev/questions.ts";
import { lintCorpus } from "./lint.ts";
import { mineGlossary } from "./mine.ts";
import { arbitrate } from "./arbitrate.ts";
import { audit, registerNorm } from "./audit.ts";
import { compose, summarise, totalCoverage } from "./compose.ts";
import { find, ruleLabel } from "./policy/rules.ts";
import { proposeSubstitutions, verifySubstitutions } from "./substitute.ts";
import { loadFromMongo } from "./sources/mongo.ts";
import { loadFromCsv } from "./sources/csv.ts";
import { generateSynthetic } from "./sources/synthetic.ts";
import { readDecisions, writeWorkbook } from "./report/xlsx.ts";
import { saveCache } from "./cache.ts";
import { EvidenceStore, evidencePathFor } from "./evidence/store.ts";
import { renderFromCache } from "./report/render.ts";
import {
  derivationTable,
  diffRuns,
  explain,
  inspect,
  planRun,
  planTable,
  status,
} from "./commands/observe.ts";
import { loadCache } from "./cache.ts";
import { RECALL_NOTE, buildCasebook, casebookStats } from "./review/casebook.ts";
import { loadDecisions } from "./review/decisions.ts";
import { resolvePaths } from "./commands/review.ts";
import {
  DEFAULT_LEDGER,
  appendLedger,
  diffEntries,
  entryFrom,
  findEntry,
  readLedger,
} from "./ledger/ledger.ts";
import { emit, envelope, note, type Cost, type Envelope, type Table } from "./report/envelope.ts";
import { runReview } from "./commands/review.ts";
import { probeOrder, probeScope, orderStats, scopeStats } from "./commands/probe.ts";
import { baseRate, brier, ece, operatingPoints, reliability, type Point } from "./calibrate.ts";
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
import { Progress } from "./util/progress.ts";
import type { Corpus, StageStats, Unjudged } from "./types.ts";

loadEnv();

const USAGE = `
translate-audit — translation consistency for corpora with no glossary

Observations — free, write nothing, safe to run at any time:

  status  [--dir .]
          what is in this directory, how fresh, and whether the pieces agree.

  plan    <same source flags as run>
          what a run would ask, what the evidence store already covers, and what
          the remainder would cost. Look here before spending.

  inspect <run.json> <entry-id | key name | source text>
          everything known about one key: translations, judgments, exact defects,
          findings and the glossary terms that apply.

  explain <run.json> <entry-id> <lang>
          why that row was raised — evidence, threshold, what it contributed, and
          the value that would flip it.

  diff    <a.run.json> <b.run.json>
          what changed between two runs, by rule and by severity.

  casebook <run.json> [--decisions d.json]
          what translators actually decided, as labelled cases. A reject on a
          finding is a false positive; an edit on a row nothing flagged is a miss.
          Measures precision on the real corpus, which no generator can synthesise.

  ledger  [--diff <idA> <idB>] [--ledger runs/ledger.jsonl]
          what previous runs and measurements produced. score and probe append to
          it, so "did that change help?" is a diff of two rows rather than a
          re-measurement of the past.

Actions — these spend:

  run     --mongo <db> [--projects a,b] [--langs de,uk] [--limit N]
          --csv <file> [--source pl]
          --synthetic <N>
          [--out audit.xlsx] [--save run.json] [--glossary g.json] [--register] [--no-fix] [--dry-run]
          [--concurrency 12] [--max-terms N] [--only-flagged]
          [--no-cache] [--evidence e.jsonl] [--keep-state]
          Judgments are addressed by (model, state, questions) and appended to
          <out>.evidence.jsonl, so an interrupted run resumes and an unchanged one
          costs nothing. Change a question and only the units asking it are re-asked.

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

Every command prints one result on stdout and its narration on stderr, so
  translate-audit <command> --json
gives a single JSON object a caller can parse. Progress never touches stdout.

Configuration: defaults, then translate-audit.config.json, then the environment, then
             flags. Every run states which of those layers spoke. The file takes
             { domain, policy, gates, model, baseUrl, pricing, concurrency }.

Environment: TYPESAFE_API_KEY (required for run/score/probe), MONGO_URI, JEV_MODEL,
             TYPESAFE_BASE_URL, JEV_CONCURRENCY, JEV_PRICE_IN, JEV_PRICE_OUT,
             TRANSLATE_AUDIT_DOMAIN
`;

const COMMANDS: Record<string, (args: Args) => Promise<Envelope>> = {
  status: cmdStatus,
  ledger: cmdLedger,
  casebook: cmdCasebook,
  plan: cmdPlan,
  inspect: cmdInspect,
  explain: cmdExplain,
  diff: cmdDiff,
  run: cmdRun,
  report: cmdReport,
  review: cmdReview,
  apply: cmdApply,
  score: cmdScore,
  probe: cmdProbe,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = COMMANDS[args.command];
  if (!command) {
    process.stdout.write(USAGE);
    process.exitCode = args.command === "help" || args.flags.has("help") ? 0 : 1;
    return;
  }
  emit(await command(args), flagBool(args, "json", false));
}

// ---------------------------------------------------------------- observations

const ledgerPath = (args: Args): string => args.flags.get("ledger") ?? DEFAULT_LEDGER;

/**
 * Appending is the only thing an action does to the ledger, and only when it measured
 * something worth keeping. Observations never write.
 */
function record(
  args: Args,
  e: Envelope,
  profile: Profile,
  extra: { corpus: string; keys: number; measurements?: Record<string, number> },
): Envelope {
  if (!flagBool(args, "ledger", true)) return e;
  const path = ledgerPath(args);
  const entry = entryFrom(e, profile, extra);
  appendLedger(path, entry);
  return {
    ...e,
    outputs: { ...e.outputs, ledger: `${path}#${entry.id}` },
    next: [...e.next, `translate-audit ledger --diff ${entry.id} <an earlier id>`],
  };
}

async function cmdLedger(args: Args): Promise<Envelope> {
  const path = ledgerPath(args);
  const rows = readLedger(path);
  // `--diff a b` puts `a` on the flag and `b` in the positionals; `--diff a,b` puts both
  // on the flag. Both are things people type, so both work.
  const pair = [...flagList(args, "diff"), ...args.positional].slice(0, 2);

  if (args.flags.has("diff") && pair.length === 2) {
    const [aRef, bRef] = pair;
    const a = findEntry(rows, aRef);
    const b = findEntry(rows, bRef);
    if (!a || !b) {
      return envelope("ledger", {
        ok: false,
        inputs: { ledger: path, entries: rows.length },
        warnings: [{ code: "no-such-entry", detail: `${!a ? aRef : bRef} is not an id or index in ${path}` }],
        next: ["translate-audit ledger"],
      });
    }
    const d = diffEntries(a, b);
    return envelope("ledger", {
      inputs: {
        ledger: path,
        left: `${a.id} ${a.command} ${a.at.slice(0, 19).replace("T", " ")}`,
        right: `${b.id} ${b.command} ${b.at.slice(0, 19).replace("T", " ")}`,
      },
      tables: [
        {
          title: "what changed in the configuration",
          columns: ["setting", "left", "right"],
          rows: d.configChanged,
          note: d.configChanged.length
            ? "a measurement that moved beside exactly one of these is a result"
            : "nothing differed — a measurement that moved anyway is noise",
        },
        {
          title: "what it did to the numbers",
          columns: ["measurement", "left", "right", "delta"],
          rows: d.measurements.map(([k, l, r, delta]) => [
            k,
            l === undefined ? "—" : l.toFixed(3),
            r === undefined ? "—" : r.toFixed(3),
            delta === undefined ? "—" : (delta >= 0 ? "+" : "") + delta.toFixed(3),
          ]),
        },
      ].filter((t) => t.rows.length > 0),
      warnings:
        d.left.corpus !== d.right.corpus
          ? [{ code: "different-corpus", detail: "these were measured on different corpora, so the delta is not attributable" }]
          : [],
      next: [],
    });
  }

  const limit = flagNum(args, "limit", 20);
  const recent = rows.slice(-limit).reverse();
  return envelope("ledger", {
    inputs: { ledger: path, entries: rows.length },
    tables: [
      {
        title: `the last ${recent.length} of ${rows.length}`,
        columns: ["id", "when", "command", "questions", "keys", "cost", "headline"],
        rows: recent.map((r) => [
          r.id,
          r.at.slice(0, 16).replace("T", " "),
          r.command,
          r.questions,
          r.keys,
          r.cost ? `$${r.cost.usd.toFixed(2)}` : "—",
          r.measurements
            ? Object.entries(r.measurements)
                .slice(0, 3)
                .map(([k, v]) => `${k} ${v.toFixed(2)}`)
                .join(" · ")
            : String(r.counts.findings ?? ""),
        ]),
      },
    ],
    warnings: rows.length ? [] : [{ code: "empty", detail: `${path} has no entries yet — run \`score\` to make one` }],
    next: rows.length >= 2 ? [`translate-audit ledger --diff ${recent[1].id} ${recent[0].id}`] : [],
  });
}

/**
 * Free, so it is an observation rather than a flag on `score`.
 *
 * `PLAN.md` had this as `score --casebook`, but the case book costs nothing to compute
 * and `score` costs ~$0.55 — bolting a free measurement onto a paid one means nobody runs
 * it casually, which is the opposite of what an accreting eval set needs.
 */
async function cmdCasebook(args: Args): Promise<Envelope> {
  const path = args.positional[0] ?? args.flags.get("in") ?? "audit.run.json";
  const profile = loadProfile(args);
  const paths = resolvePaths({ cache: path, decisions: args.flags.get("decisions"), port: 0 });
  const { cache, findings } = composedFrom(path, profile);
  const decisions = loadDecisions(paths.decisions);
  const cases = buildCasebook(cache, findings, decisions);
  const stats = casebookStats(cases);

  const pct = (x: number | null): string => (x === null ? "—" : `${(100 * x).toFixed(1)}%`);

  return envelope("casebook", {
    inputs: { run: path, decisions: paths.decisions, ...profileInputs(profile) },
    counts: {
      "decisions on file": decisions.size,
      "labelled cases": stats.cases,
      reviewers: stats.reviewers,
      "precision on reviewed rows": pct(stats.precision),
      "precision at severity >= 2": pct(stats.precisionAtSeverity2),
      "substitutions taken unchanged": pct(stats.substitutionPrecision),
      "edits on rows nothing flagged": stats.missed,
    },
    groups: {
      "by label": stats.byLabel.map(([l, n]) => [l, n] as [string, number]),
      "rules a human ruled against": stats.falsePositivesByRule.map(([r, n]) => [r, n] as [string, number]),
    },
    tables: cases.length
      ? [
          {
            title: "the most recent disagreements",
            columns: ["label", "lang", "source", "was", "became", "meaning", "why"],
            rows: cases
              .filter((c) => c.label === "false-positive" || c.label === "missed")
              .slice(-10)
              .map((c) => [
                c.label,
                c.lang,
                c.source.slice(0, 40),
                c.was.slice(0, 30),
                c.became.slice(0, 30),
                c.meaning === undefined ? "—" : c.meaning.toFixed(2),
                (c.why ?? []).join(" / ").slice(0, 60),
              ]),
            note: "each row is a case where a human and the pipeline disagreed, with the judgment that caused it",
          },
        ]
      : [],
    warnings: [
      { code: "no-recall", detail: RECALL_NOTE },
      ...(decisions.size === 0
        ? [
            {
              code: "no-decisions",
              detail: `${paths.decisions} has no decisions yet — this file fills up as translators use the review app`,
            },
          ]
        : []),
    ],
    next: stats.falsePositivesByRule.length
      ? [`translate-audit explain ${path} <entry-id> <lang>   (on a rule a human ruled against)`]
      : [`translate-audit review ${path}`],
  });
}

async function cmdStatus(args: Args): Promise<Envelope> {
  const dir = args.flags.get("dir") ?? process.cwd();
  const { artifacts, warnings } = status(dir);
  return envelope("status", {
    inputs: { directory: dir, ...profileInputs(loadProfile(args, dir)) },
    counts: { artifacts: artifacts.length },
    tables: [
      {
        title: "artifacts",
        columns: ["kind", "file", "modified", "what is in it"],
        rows: artifacts.map((a) => [a.kind, a.path, a.modified, a.detail]),
      },
    ],
    warnings,
    next: artifacts.some((a) => a.kind === "run")
      ? [`translate-audit report ${artifacts.find((a) => a.kind === "run")!.path} --min-severity 2`]
      : ["translate-audit plan --synthetic 200   (or point it at your corpus)"],
  });
}

async function cmdPlan(args: Args): Promise<Envelope> {
  const profile = loadProfile(args);
  const { corpus, notes } = await loadCorpus(args);
  const evidence = openEvidence(args, args.flags.get("out") ?? "audit.xlsx");
  const plan = planRun({
    corpus,
    profile,
    store: evidence,
    maxTerms: args.flags.has("max-terms") ? flagNum(args, "max-terms", 0) : 0,
    onlyFlagged: flagBool(args, "only-flagged", false),
    register: flagBool(args, "register", true),
    fix: flagBool(args, "fix", true),
  });

  return envelope("plan", {
    inputs: {
      corpus: corpus.origin,
      keys: corpus.entries.length,
      ...profileInputs(profile),
      evidence: evidence ? `${evidence.path} (${evidence.size} judgments)` : "disabled",
    },
    counts: {
      "requests to make": plan.totalToAsk,
      "already bought": plan.totalCached,
      "estimated cost": `$${plan.estUsd.toFixed(2)}`,
    },
    tables: [planTable(plan)],
    warnings: [
      ...notes.map((detail) => ({ code: "corpus", detail })),
      ...plan.unpredictable.map((detail) => ({ code: "not-predictable", detail })),
    ],
    next: ["the same command with `run` instead of `plan`"],
  });
}

function composedFrom(path: string, profile: Profile) {
  const cache = loadCache(path);
  const findings = compose({
    corpus: cache.corpus,
    lintIssues: cache.lintIssues,
    judgments: new Map(cache.judgments),
    glossary: cache.glossary,
    registerNorms: new Map(cache.registerNorms),
    policy: profile.policy,
    unjudged: cache.unjudged,
  });
  return { cache, findings };
}

async function cmdInspect(args: Args): Promise<Envelope> {
  const [path, ...rest] = args.positional;
  const query = rest.join(" ");
  if (!path || !query) throw new Error("usage: translate-audit inspect <run.json> <entry-id | key name | source>");
  const profile = loadProfile(args);
  const { cache, findings } = composedFrom(path, profile);
  const found = inspect(cache, findings, query);

  if (!found.found) {
    return envelope("inspect", {
      ok: false,
      inputs: { run: path, query },
      warnings: [{ code: "not-found", detail: `no key in ${path} matches ${JSON.stringify(query)}` }],
      next: [],
    });
  }

  return envelope("inspect", {
    inputs: { run: path, ...found.entry },
    tables: [
      {
        title: "translations",
        columns: ["lang", "text", "meaning", "adheres", "register"],
        rows: (found.translations ?? []).map((t) => [
          String(t.lang),
          String(t.text || "—"),
          t.meaning === null ? "—" : Number(t.meaning).toFixed(2),
          t.adheres === null || t.adheres === undefined ? "—" : Number(t.adheres).toFixed(2),
          String(t.register ?? "—"),
        ]),
      },
      {
        title: "exact defects",
        columns: ["lang", "code", "detail"],
        rows: (found.lint ?? []).map((i) => [i.lang, i.code, i.detail]),
      },
      {
        title: "findings",
        columns: ["lang", "severity", "action", "judged", "why"],
        rows: (found.findings ?? []).map((f) => [
          f.lang,
          f.severity,
          f.action,
          f.judged ? "yes" : "no",
          f.reasons.join(" / "),
        ]),
      },
      {
        title: "glossary terms that apply",
        columns: ["term", "lang", "canonical", "confidence"],
        rows: (found.terms ?? []).map((t) => [
          String(t.term),
          String(t.lang),
          String(t.canonical ?? "—"),
          Number(t.confidence ?? 0).toFixed(2),
        ]),
      },
    ].filter((t) => t.rows.length > 0),
    warnings: [],
    next: (found.findings ?? []).length
      ? [`translate-audit explain ${path} ${found.entry!.id} ${(found.findings ?? [])[0].lang}`]
      : [],
  });
}

async function cmdExplain(args: Args): Promise<Envelope> {
  const [path, entryId, lang] = args.positional;
  if (!path || !entryId || !lang) throw new Error("usage: translate-audit explain <run.json> <entry-id> <lang>");
  const profile = loadProfile(args);
  const { findings } = composedFrom(path, profile);
  const f = findings.find((x) => x.entryId === entryId && x.lang === lang);

  if (!f) {
    return envelope("explain", {
      ok: false,
      inputs: { run: path, entryId, lang },
      warnings: [
        {
          code: "no-finding",
          detail: `nothing was raised for ${entryId} in ${lang} under this policy — that is an answer too`,
        },
      ],
      next: [`translate-audit inspect ${path} ${entryId}`],
    });
  }

  const rows = explain(f, profile);
  return envelope("explain", {
    inputs: {
      run: path,
      key: f.keyName,
      lang: f.lang,
      source: f.source,
      current: f.current,
      suggested: f.suggested ?? "—",
    },
    counts: { severity: f.severity, category: f.category, action: f.action, judged: f.judged ? "yes" : "no" },
    tables: [
      derivationTable(rows),
      {
        title: "what would change the answer",
        columns: ["rule", "flips at"],
        rows: rows.filter((d) => d.flipsAt).map((d) => [d.rule, d.flipsAt!]),
      },
    ].filter((t) => t.rows.length > 0),
    warnings: f.judged ? [] : [{ code: "not-judged", detail: "the semantic checks never ran on this key" }],
    next: [`translate-audit report ${path} --meaning-bad <value>`],
  });
}

async function cmdDiff(args: Args): Promise<Envelope> {
  const [left, right] = args.positional;
  if (!left || !right) throw new Error("usage: translate-audit diff <a.run.json> <b.run.json>");
  const profile = loadProfile(args);
  const d = diffRuns(left, right, profile);

  return envelope("diff", {
    inputs: { left: d.left, right: d.right, policy: `meaning<${profile.policy.meaningBad}` },
    counts: d.counts,
    groups: {
      "severity, right minus left": d.bySeverity,
      "rules, right minus left": d.byRule.map(([r, n]) => [r, n] as [string, number]),
    },
    warnings:
      d.counts["questions left"] !== d.counts["questions right"]
        ? [
            {
              code: "questions-differ",
              detail:
                "these runs were produced by different question sets, so part of the difference is the questions " +
                "rather than the corpus or the policy",
            },
          ]
        : [],
    next: [],
  });
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

const jevClient = (apiKey: string, profile: Profile, evidence: EvidenceStore | null = null): JevClient =>
  new JevClient({
    apiKey,
    concurrency: profile.concurrency,
    model: profile.model,
    baseUrl: profile.baseUrl,
    evidence,
  });

/**
 * A judgment is addressed by the model, the state and the questions, so re-running
 * identical inputs costs nothing and a killed run resumes by itself. `--no-cache` asks
 * everything afresh; `probe` never uses the store, because exercising the live endpoint
 * is the entire point of it.
 */
function openEvidence(args: Args, base: string): EvidenceStore | null {
  if (flagBool(args, "cache", true) === false) return null;
  const path = args.flags.get("evidence") ?? evidencePathFor(base);
  const store = EvidenceStore.open(path, { keepState: flagBool(args, "keep-state", false) });
  if (store.size) note(`  evidence          ${store.size} judgments already bought · ${path}`);
  if (store.damaged) note(`      ! ${store.damaged} unreadable line(s) in ${path} — ignored`);
  return store;
}

const stageCost = (s: StageStats, profile: Profile): number =>
  (s.inputTokens / 1e6) * profile.pricing.inputPerM + (s.outputTokens / 1e6) * profile.pricing.outputPerM;

function costOf(stages: StageStats[], profile: Profile, wallMs: number): Cost {
  const lat = stages.flatMap((s) => s.latencies);
  const attempted = stages.reduce((n, s) => n + s.requests, 0);
  const reused = stages.reduce((n, s) => n + s.reused, 0);
  return {
    // What was sent. A reused judgment is in `reused`, where it costs nothing and says so.
    requests: attempted - reused,
    reused,
    judgments: stages.reduce((n, s) => n + s.judgments, 0),
    errors: stages.reduce((n, s) => n + s.errors, 0),
    retries: stages.reduce((n, s) => n + s.retries, 0),
    usd: stages.reduce((c, s) => c + stageCost(s, profile), 0),
    wallMs,
    p50Ms: Math.round(percentile(lat, 50)),
    p95Ms: Math.round(percentile(lat, 95)),
  };
}

const stageTable = (stages: StageStats[], profile: Profile): Table => ({
  title: "by stage",
  columns: ["stage", "requests", "reused", "judgments", "errors", "skipped", "wall", "cost"],
  rows: stages.map((s) => [
    s.name,
    s.requests,
    s.reused,
    s.judgments,
    s.errors,
    s.skipped,
    `${(s.wallMs / 1000).toFixed(1)}s`,
    `$${stageCost(s, profile).toFixed(2)}`,
  ]),
  note: "reused judgments came from evidence already on disk: no request, no wait, no cost",
});

const bySeverity = (counts: number[]): [string, number][] =>
  [3, 2, 1, 0].map((s) => [`severity ${s}`, counts[s]] as [string, number]);

const profileInputs = (profile: Profile): Record<string, unknown> => ({
  model: profile.model,
  questions: questionsFingerprint(),
  configuredBy: profile.sources.length ? profile.sources : ["defaults"],
});

async function cmdRun(args: Args): Promise<Envelope> {
  const startedAt = new Date();
  const profile = loadProfile(args);
  const t0 = performance.now();
  const { corpus, notes } = await loadCorpus(args);
  const targets = corpus.langs.filter((l) => l !== corpus.sourceLang);
  const warnings: Envelope["warnings"] = notes.map((detail) => ({ code: "corpus", detail }));

  note(`\n  ${corpus.origin}`);
  note(`  ${corpus.entries.length} keys · source ${langName(corpus.sourceLang)} · targets ${targets.join(", ")}`);
  note(`  ${profile.model} · configured by ${profile.sources.length ? profile.sources.join(", ") : "defaults"}\n`);
  for (const n of notes) note(`  ! ${n}`);

  const lint = lintCorpus(corpus);
  note(`  automated checks  ${lint.issues.length} exact defects`);
  const lintCounts = Object.entries(lint.counts).sort((a, b) => b[1] - a[1]) as [string, number][];
  for (const [code, n] of lintCounts) note(`      ${String(n).padStart(6)}  ${code}`);

  const mined = mineGlossary(corpus);
  const maxTerms = args.flags.has("max-terms") ? flagNum(args, "max-terms", 0) : 0;
  const conflicts = maxTerms > 0 ? mined.conflicts.slice(0, maxTerms) : mined.conflicts;
  note(
    `\n  mined             ${mined.termCount} terms → ${mined.conflicts.length} contested (term, language) pairs` +
      `${maxTerms > 0 && mined.conflicts.length > maxTerms ? `, arbitrating the top ${maxTerms}` : ""}`,
  );
  note(`                    ${mined.resolved.length} resolved in code (spacing or case only — no request spent)`);
  note(`                    ${mined.agreed.size} already consistent everywhere\n`);

  const inputs: Record<string, unknown> = {
    corpus: corpus.origin,
    keys: corpus.entries.length,
    sourceLang: corpus.sourceLang,
    targets,
    ...profileInputs(profile),
  };

  if (flagBool(args, "dry-run", false)) {
    return envelope("run", {
      inputs: { ...inputs, mode: "dry-run" },
      counts: {
        "exact defects": lint.issues.length,
        "terms mined": mined.termCount,
        contested: mined.conflicts.length,
        "resolved in code": mined.resolved.length,
        "already consistent": mined.agreed.size,
        "requests a full run would arbitrate": conflicts.length,
      },
      groups: { "exact defects by kind": lintCounts },
      tables: [
        {
          title: "contested terms (first 15)",
          columns: ["lang", "term", "renderings"],
          rows: conflicts
            .slice(0, 15)
            .map((c) => [c.lang, c.term, c.variants.map((v) => `${JSON.stringify(v.text)}×${v.count}`).join(" vs ")]),
          note: "identifiers here rather than words mean the source column is wrong",
        },
      ],
      warnings,
      next: ["the same command without --dry-run"],
    });
  }

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const out = args.flags.get("out") ?? "audit.xlsx";
  const evidence = openEvidence(args, out);
  const client = jevClient(apiKey, profile, evidence);
  const stages: StageStats[] = [];
  const unjudged: Unjudged[] = [];
  const entries = new Map(corpus.entries.map((e) => [e.id, e]));

  const glossaryPath =
    args.flags.get("glossary") ?? `${(args.flags.get("out") ?? "audit.xlsx").replace(/\.xlsx$/, "")}.glossary.json`;
  const saved = loadGlossary(glossaryPath);
  const displayFor = (term: string): string => {
    for (const e of corpus.entries) if (fold(e.source) === term) return norm(e.source);
    return term;
  };
  const merged = mergeMined(saved, conflicts, mined.resolved, displayFor);

  if (saved.length) {
    note(
      `  glossary          ${saved.length} terms remembered · ${merged.reused} decisions reused (no request spent)` +
        `${merged.fresh ? ` · ${merged.fresh} new` : ""}${merged.drifted.length ? ` · ${merged.drifted.length} drifted` : ""}`,
    );
    for (const d of merged.drifted) {
      warnings.push({
        code: "glossary-drift",
        detail: `"${d.display}" [${d.lang}] was decided as "${d.canonical}" but the corpus now also uses others`,
      });
      note(`      ! "${d.display}" [${d.lang}] was decided as "${d.canonical}" but the corpus now also uses others`);
    }
  }

  let records = merged.records;
  if (merged.needArbitration.length) {
    const p = new Progress("arbitrate");
    const r = await arbitrate(client, merged.needArbitration, entries, corpus.sourceLang, profile.domain, (d, t) =>
      p.update(d, t),
    );
    p.done();
    records = applyArbitration(records, r.glossary);
    stages.push(r.stats);
    unjudged.push(...r.unjudged);
  }
  saveGlossary(glossaryPath, records);

  const glossary = enforceable(records);
  const glossaryForReport = asGlossaryEntries(records);
  note(`                    ${glossary.length} enforceable terms of ${records.length} known`);

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
  unjudged.push(...auditRes.unjudged);

  const norms = registerNorm(auditRes.judgments, targets);

  const findings = compose({
    corpus,
    lintIssues: lint.issues,
    judgments: auditRes.judgments,
    glossary,
    registerNorms: norms,
    policy: profile.policy,
    unjudged,
  });

  let verified = 0;
  let toHuman = 0;
  if (flagBool(args, "fix", true)) {
    const proposals = proposeSubstitutions(findings, glossary, profile.policy);
    if (proposals.length) {
      const ps = new Progress("substitute");
      const sub = await verifySubstitutions(
        client,
        proposals,
        langName(corpus.sourceLang),
        (d, t) => ps.update(d, t),
        profile.gates,
      );
      ps.done();
      stages.push(sub.stats);
      unjudged.push(...sub.unjudged);
      verified = sub.applied;
      toHuman = sub.rejected;
      note(`                    ${sub.applied} substitutions verified, ${sub.rejected} sent to a human`);
    }
  }

  for (const f of findings) {
    if (f.action === "auto-fix" && !f.suggested) f.action = "needs human";
  }

  const summary = summarise(findings, corpus);

  const savePath =
    args.flags.get("save") ?? `${(args.flags.get("out") ?? "audit.xlsx").replace(/\.xlsx$/, "")}.run.json`;
  saveCache(savePath, {
    provenance: {
      questions: questionsFingerprint(),
      model: profile.model,
      domain: profile.domain,
      policy: profile.policy,
      gates: profile.gates,
      configuredBy: profile.sources,
    },
    corpus,
    lintIssues: lint.issues,
    glossary: glossaryForReport,
    judgments: [...auditRes.judgments],
    registerNorms: [...norms],
    stages,
    unjudged,
    substitutions: findings
      .filter((f) => f.suggested !== null)
      .map((f) => ({
        entryId: f.entryId,
        lang: f.lang,
        suggested: f.suggested!,
        check: f.substitutionOk,
        note:
          find(f.reasons, "substitution-verified") ??
          find(f.reasons, "substitution-rejected") ??
          find(f.reasons, "substitution-unverified") ??
          null,
      })),
  });

  await writeWorkbook(out, {
    corpus,
    findings,
    glossary: glossaryForReport,
    lintIssues: lint.issues,
    summary,
    stages,
    registerNorms: norms,
    pricing: profile.pricing,
    startedAt,
    policyNote: policyNote(profile.policy, profile.gates),
  });

  const coverage = totalCoverage(stages);
  if (coverage.failed > 0) {
    warnings.push({
      code: "partial-coverage",
      detail:
        `${coverage.failed} of ${coverage.attempted} requests never came back. Those keys were not judged, ` +
        `so every count here is a floor, not a total.`,
    });
  }

  const result = envelope("run", {
    inputs,
    coverage,
    counts: {
      findings: summary.findings,
      "keys affected": `${summary.entriesTouched} of ${summary.entriesTotal}`,
      "exact defects": lint.issues.length,
      "glossary terms": records.length,
      enforceable: glossary.length,
      "decisions reused": merged.reused,
      "judgments reused from evidence": stages.reduce((n, s) => n + s.reused, 0),
      "substitutions verified": verified,
      "substitutions to a human": toHuman,
    },
    groups: {
      "by severity": bySeverity(summary.bySeverity),
      "by category": summary.byCategory.map(([c, n]) => [c, n] as [string, number]),
      "recommended action": summary.byAction.map(([a, n]) => [a, n] as [string, number]),
      "by language": summary.byLang.map(([l, n]) => [`${langName(l)} (${l})`, n] as [string, number]),
    },
    tables: [stageTable(stages, profile)],
    cost: costOf(stages, profile, performance.now() - t0),
    outputs: {
      workbook: out,
      run: savePath,
      glossary: glossaryPath,
      ...(evidence ? { evidence: evidence.path } : {}),
    },
    warnings,
    next: [`translate-audit report ${savePath} --min-severity 2`, `translate-audit review ${savePath}`],
  });

  return record(args, result, profile, { corpus: corpus.origin, keys: corpus.entries.length });
}

async function cmdReport(args: Args): Promise<Envelope> {
  const t0 = performance.now();
  const path = args.positional[0] ?? args.flags.get("in");
  if (!path) throw new Error("usage: translate-audit report <run.json>");
  const only = flagList(args, "only");
  const minSeverity = flagNum(args, "min-severity", 0);
  const profile = loadProfile(args);

  const r = await renderFromCache({
    cachePath: path,
    out: args.flags.get("out") ?? path.replace(/\.run\.json$|\.json$/, "") + ".xlsx",
    profile,
    minSeverity,
    only: new Set(only),
  });

  const warnings: Envelope["warnings"] = [];
  const prov = r.cache.provenance;
  const asked = questionsFingerprint();
  if (!prov) {
    warnings.push({
      code: "no-provenance",
      detail: "this run predates provenance — nothing in it says which questions produced it",
    });
  } else if (prov.questions !== asked) {
    warnings.push({
      code: "questions-changed",
      detail: `these judgments were produced by questions ${prov.questions}; this build asks ${asked}`,
    });
  }

  const coverage = totalCoverage(r.cache.stages);
  if (coverage.failed > 0) {
    warnings.push({
      code: "partial-coverage",
      detail:
        `${coverage.failed} of ${coverage.attempted} requests in that run never came back; ` +
        `those keys carry exact checks only`,
    });
  }

  const inputs: Record<string, unknown> = {
    run: path,
    "judgments saved": r.cache.savedAt.slice(0, 19).replace("T", " "),
    "asked by": prov?.questions ?? "unknown",
    model: prov?.model ?? "unknown",
    policy: `meaning<${profile.policy.meaningBad} adherence<${profile.policy.adherenceBad}`,
  };
  if (minSeverity) inputs["min severity"] = minSeverity;
  if (only.length) inputs.categories = only;

  return envelope("report", {
    inputs,
    coverage,
    counts: { composed: r.composed, kept: r.kept },
    // Free, and it says so in the same shape every other command uses. `report` costing
    // nothing is the point of the tower, so it is worth reporting as a measurement rather
    // than as a formatted string an agent would have to parse back out of `counts`.
    cost: costOf([], profile, performance.now() - t0),
    groups: {
      "by severity": bySeverity(r.summary.bySeverity),
      "by category": r.summary.byCategory.map(([c, n]) => [c, n] as [string, number]),
      "why findings were raised": r.summary.byReason.slice(0, 12),
    },
    outputs: { workbook: r.out },
    warnings,
    next: [`translate-audit review ${path}`, `translate-audit apply ${r.out}`],
  });
}

async function cmdReview(args: Args): Promise<Envelope> {
  const cache = args.positional[0] ?? args.flags.get("in") ?? "audit.run.json";
  const port = flagNum(args, "port", 8788);
  const started = await runReview({
    cache,
    glossary: args.flags.get("glossary"),
    decisions: args.flags.get("decisions"),
    port,
    apiKey: process.env.TYPESAFE_API_KEY,
    concurrency: flagNum(args, "concurrency", 6),
    profile: loadProfile(args),
  });

  return envelope("review", {
    inputs: { run: cache, url: `http://localhost:${port}` },
    counts: {
      findings: started.stats.summary.findings,
      "glossary terms": started.stats.glossary.total,
      "terms decided": started.stats.glossary.decided,
      "row decisions so far": started.stats.decisions.total,
    },
    outputs: { glossary: started.paths.glossary, decisions: started.paths.decisions },
    warnings: started.warnings,
    next: [`open http://localhost:${port}`],
  });
}

async function cmdApply(args: Args): Promise<Envelope> {
  const path = args.positional[0] ?? args.flags.get("in");
  if (!path) throw new Error("usage: translate-audit apply <audit.xlsx>");
  const rows = await readDecisions(path);
  const changes = selectChanges(rows);

  const byDecision = new Map<string, number>();
  for (const r of rows) byDecision.set(r.decision, (byDecision.get(r.decision) ?? 0) + 1);

  const outputs: Record<string, string> = {};
  const next: string[] = [];
  if (changes.length) {
    const out = args.flags.get("out") ?? "lokalise-reimport.csv";
    writeReimportCsv(out, changes);
    outputs.reimport = out;

    const script = args.flags.get("mongo-script");
    if (script) {
      const targetDb = args.flags.get("mongo-db") ?? args.flags.get("mongo");
      if (!targetDb) throw new Error("--mongo-script needs --mongo-db <db> to know where to write");
      writeMongoScript(script, changes, targetDb);
      outputs["mongo script"] = script;
      next.push(`review it, then: mongosh --file ${script}`);
    }
  }

  return envelope("apply", {
    inputs: { workbook: path },
    counts: { decisions: rows.length, "translations that change": changes.length },
    groups: { "by decision": [...byDecision].sort((a, b) => b[1] - a[1]) },
    outputs,
    warnings: changes.length
      ? []
      : [
          {
            code: "nothing-to-write",
            detail:
              "no row was both accepted or edited and actually different. A re-import carrying unchanged " +
              "rows churns translation memory and resets review flags, so nothing was written.",
          },
        ],
    next,
  });
}

async function cmdScore(args: Args): Promise<Envelope> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const profile = loadProfile(args);
  const t0 = performance.now();
  const keys = flagNum(args, "synthetic", 400);
  const langs = flagList(args, "langs");
  const seed = flagNum(args, "seed", 20250920);
  const { corpus, truth } = generateSynthetic({
    keys,
    langs: langs.length ? langs : ["de", "en", "uk", "fr", "hu"],
    seed,
    defectRate: flagNum(args, "defect-rate", 0.1),
  });
  note(`\n  ${corpus.origin}\n`);

  const evidence = openEvidence(args, args.flags.get("out") ?? `score-${seed}`);
  const client = jevClient(apiKey, profile, evidence);
  const lint = lintCorpus(corpus);
  const mined = mineGlossary(corpus);
  const entries = new Map(corpus.entries.map((e) => [e.id, e]));

  const pa = new Progress("arbitrate");
  const arb = await arbitrate(client, mined.conflicts, entries, corpus.sourceLang, profile.domain, (d, t) =>
    pa.update(d, t),
  );
  pa.done();
  const glossary = [...mined.resolved, ...arb.glossary];

  const pb = new Progress("audit");
  const auditRes = await audit(client, corpus, glossary, lint.issues, { register: true }, (d, t) => pb.update(d, t));
  pb.done();

  const norms = registerNorm(
    auditRes.judgments,
    corpus.langs.filter((l) => l !== corpus.sourceLang),
  );
  const findings = compose({
    corpus,
    lintIssues: lint.issues,
    judgments: auditRes.judgments,
    glossary,
    registerNorms: norms,
    policy: profile.policy,
    unjudged: auditRes.unjudged,
  });

  const flagged = new Set(findings.map((f) => `${f.entryId}\u0000${f.lang}`));
  const truthSet = new Set(truth.map((t) => `${t.entryId}\u0000${t.lang}`));
  const caught = [...truthSet].filter((k) => flagged.has(k)).length;
  const extra = [...flagged].filter((k) => !truthSet.has(k)).length;

  const extraReasons = new Map<string, number>();
  const extraSeverity = [0, 0, 0, 0];
  for (const f of findings) {
    if (truthSet.has(`${f.entryId}\u0000${f.lang}`)) continue;
    extraSeverity[Math.min(3, Math.round(f.severity))]++;
    for (const r of f.reasons) extraReasons.set(ruleLabel(r), (extraReasons.get(ruleLabel(r)) ?? 0) + 1);
  }

  const actionable = findings.filter((f) => f.severity >= 2);
  const actionableHits = actionable.filter((f) => truthSet.has(`${f.entryId}\u0000${f.lang}`)).length;

  const byDefect = new Map<string, { n: number; caught: number }>();
  for (const t of truth) {
    const rec = byDefect.get(t.defect) ?? { n: 0, caught: 0 };
    rec.n++;
    if (flagged.has(`${t.entryId}\u0000${t.lang}`)) rec.caught++;
    byDefect.set(t.defect, rec);
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
  const stages = [arb.stats, auditRes.stats];
  const pct = (x: number, of: number): string => `${((100 * x) / Math.max(1, of)).toFixed(1)}%`;

  const num = (x: number, of: number): number => Number((x / Math.max(1, of)).toFixed(4));
  const measurements = {
    recall: num(caught, truthSet.size),
    precision: num(caught, flagged.size),
    precisionAtSeverity2: num(actionableHits, actionable.length),
    recallAtSeverity2: num(actionableHits, truthSet.size),
    ece: Number(ece(bins).toFixed(4)),
    brier: Number(brier(points).toFixed(4)),
    findings: findings.length,
    injected: truthSet.size,
  };

  const result = envelope("score", {
    inputs: { corpus: corpus.origin, seed, keys, ...profileInputs(profile) },
    coverage: totalCoverage(stages),
    counts: {
      "injected defects": truthSet.size,
      caught: `${caught}  (recall ${pct(caught, truthSet.size)})`,
      "flagged total": flagged.size,
      "not injected": `${extra}  (precision ${pct(caught, flagged.size)})`,
      "at severity >= 2":
        `${actionable.length} findings, ${actionableHits} injected ` +
        `(precision ${pct(actionableHits, actionable.length)}, recall ${pct(actionableHits, truthSet.size)})`,
      "expected calibration error": ece(bins).toFixed(3),
      brier: brier(points).toFixed(3),
      "base rate": baseRate(points).toFixed(3),
    },
    groups: {
      "what the not-injected flags were": [...extraReasons].sort((a, b) => b[1] - a[1]),
      "not-injected by severity": bySeverity(extraSeverity),
    },
    tables: [
      {
        title: "by defect type",
        columns: ["defect", "caught", "of", "rate"],
        rows: [...byDefect]
          .sort((a, b) => b[1].n - a[1].n)
          .map(([d, r]) => [d, r.caught, r.n, `${((100 * r.caught) / r.n).toFixed(0)}%`]),
      },
      {
        title: "calibration of `meaning` — when it says 0.9, is it right 9 times in 10?",
        columns: ["declared", "n", "observed", "gap"],
        rows: bins
          .filter((b) => b.n > 0)
          .map((b) => [
            `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`,
            b.n,
            b.observed.toFixed(3),
            (b.observed - b.declared >= 0 ? "+" : "") + (b.observed - b.declared).toFixed(3),
          ]),
        note: "a positive gap is under-confidence, which is the safe direction",
      },
      {
        title: "if strings above a `meaning` threshold skipped review",
        columns: ["threshold", "unreviewed", "of traffic", "correct", "wrong", "to a human"],
        rows: operatingPoints(points, [0.5, 0.8, 0.9, 0.95, 0.99]).map((op) => [
          op.threshold.toFixed(2),
          op.automated,
          `${(100 * op.automatedShare).toFixed(1)}%`,
          `${(100 * op.accuracy).toFixed(1)}%`,
          op.automated - op.correct,
          op.toHuman,
        ]),
      },
      stageTable(stages, profile),
    ],
    cost: costOf(stages, profile, performance.now() - t0),
    warnings: [],
    next: [`translate-audit score --synthetic ${keys} --seed ${seed}   (same seed, after a change)`],
  });

  return record(args, result, profile, { corpus: corpus.origin, keys, measurements });
}

async function cmdProbe(args: Args): Promise<Envelope> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const profile = loadProfile(args);
  const t0 = performance.now();
  const client = jevClient(apiKey, profile);

  const { corpus } = generateSynthetic({
    keys: flagNum(args, "synthetic", 600),
    langs: flagList(args, "langs").length ? flagList(args, "langs") : ["de", "uk", "fr"],
    seed: flagNum(args, "seed", 20250920),
    defectRate: 0.35,
  });
  const entries = new Map(corpus.entries.map((e) => [e.id, e]));
  const mined = mineGlossary(corpus);
  const usable = mined.conflicts.filter((c) => c.variants.length >= 2);
  note(`\n  ${corpus.origin}`);
  note(`  ${usable.length} contested terms available to probe\n`);

  const counts: Record<string, number | string> = {};
  const tables: Table[] = [];
  const warnings: Envelope["warnings"] = [];
  const stages: StageStats[] = [];
  const measurements: Record<string, number> = {};

  const orderN = Math.min(flagNum(args, "order", 40), usable.length);
  if (orderN > 0) {
    const po = new Progress("order");
    const { probes } = await probeOrder(
      client,
      usable.slice(0, orderN),
      entries,
      corpus.sourceLang,
      profile.domain,
      (d, t) => po.update(d, t),
    );
    po.done();
    const st = orderStats(probes);
    counts["option order · same answer both ways"] = `${st.agreed}/${st.n}  (${(100 * st.agreementRate).toFixed(1)}%)`;
    counts["option order · probability drift"] = `median ${st.medianDrift.toFixed(3)} · p95 ${st.p95Drift.toFixed(3)}`;
    measurements.orderAgreement = Number(st.agreementRate.toFixed(4));
    measurements.orderDriftP95 = Number(st.p95Drift.toFixed(4));
    if (st.confidentN) {
      counts["option order · when either was >=0.80"] =
        `${(100 * st.confidentAgreementRate).toFixed(1)}% over ${st.confidentN} terms`;
    }
    const disagreed = probes.filter((x) => !x.agree);
    if (disagreed.length) {
      warnings.push({
        code: "order-sensitive",
        detail:
          `${disagreed.length} of ${st.n} terms answered differently when the options were reversed. ` +
          `A Choice there reports position, not preference — do not trust a glossary from this endpoint.`,
      });
      tables.push({
        title: "order disagreements (first 5)",
        columns: ["term", "first", "p", "reversed", "p"],
        rows: disagreed
          .slice(0, 5)
          .map((p) => [
            p.id,
            p.first ?? "—",
            p.confidenceFirst.toFixed(2),
            p.second ?? "—",
            p.confidenceSecond.toFixed(2),
          ]),
      });
    }
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
    const { probes } = await probeScope(client, cases, profile.domain, (d, t) => ps.update(d, t));
    ps.done();
    const st = scopeStats(probes);
    counts["out of scope · took the no-match option"] = `${st.caught}/${st.n}  (${(100 * st.caughtRate).toFixed(1)}%)`;
    counts["out of scope · a separate yes/no noticed"] =
      `${st.presenceCaught}/${st.presenceN}  (${(100 * st.presenceRate).toFixed(1)}%)`;
    counts["out of scope · picked a loser at >=0.80"] = st.confidentlyWrong;
    counts["out of scope · mean confidence when it picked"] = st.meanConfidenceWhenWrong.toFixed(2);
    measurements.scopeNoMatchRate = Number(st.caughtRate.toFixed(4));
    measurements.scopePresenceRate = Number(st.presenceRate.toFixed(4));
    measurements.confidentlyWrong = st.confidentlyWrong;
    if (st.confidentlyWrong > 0) {
      warnings.push({
        code: "confidently-out-of-scope",
        detail:
          `${st.confidentlyWrong} terms were answered at >=0.80 confidence when the right answer was not on the ` +
          `list. A Choice is relative: confidence means "this option beat the others", not "this option is good".`,
      });
    }
  }

  const result = envelope("probe", {
    inputs: { corpus: corpus.origin, "contested terms available": usable.length, ...profileInputs(profile) },
    counts,
    tables,
    cost: costOf(stages, profile, performance.now() - t0),
    warnings,
    next: ["translate-audit score --synthetic 400   (precision and recall on the same endpoint)"],
  });

  return record(args, result, profile, { corpus: corpus.origin, keys: corpus.entries.length, measurements });
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  note(`\n  error: ${message}\n`);
  emit(
    envelope("error", { ok: false, warnings: [{ code: "error", detail: message }] }),
    flagBool(parseArgs(process.argv.slice(2)), "json", false),
  );
});
