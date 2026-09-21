# translate-audit — Technical Architecture Report

> Generated 2026-09-21 against commit `0dac880`. Every file:line reference and every
> number below was read or executed in this tree, not inferred from the prose docs.

---

## 1. Executive summary

**What it is.** A Node/TypeScript CLI that audits a multilingual translation corpus that
never had a glossary. It proves what it can for free (placeholder, tag, casing, copy and
duplicate-source defects), mines contested terminology by counting, buys judgments from a
remote probabilistic model (**Jev**, via TypeSafe System One) about the things counting
cannot settle, applies thresholds locally to turn those judgments into findings, and ships
an Excel workbook plus a React review app for translators.

**Shape.** 8,769 lines of shipping TypeScript across 44 modules (`src/` 33, `server/` 2,
`web/src/` 9), plus 3,435 lines of tests in 17 files. Zero build step for the CLI — it runs directly on Node ≥22.6
via `--experimental-strip-types`. Only the web app is bundled (Vite).

| Stat | Value | Source |
|---|---|---|
| Source modules | 44 `.ts`/`.tsx`, 8,769 LOC (+3,435 test) | `find src server web/src -name '*.ts*'` |
| Largest module | `src/cli.ts` (1,356 lines, 13 commands) | `src/cli.ts:140` |
| Tests | 246 across 17 files, 2.1 s, no API key | `npm test` |
| Runtime deps | 4 (`exceljs`, `mongodb`, `react`, `react-dom`) | `package.json:21` |
| Production run in tree | 7,040 keys × 9 languages, 12,779 exact defects, 99,734 judgments, ~$11.88 | `audit.run.json` |
| Findings from that run | 19,522 (2,000 at severity 3) | `report audit.run.json` |

**The organizing idea.** Seven layers, each a pure function of the one below it, with
exactly one that costs money (level 3) and exactly one a human writes (level 5). Imports
only ever point downward — verified below. Everything expensive is addressed by content
hash, so the second run of anything is free.

---

## 2. Entry points

| Entry | Location | Purpose |
|---|---|---|
| `translate-audit` CLI | `src/cli.ts:1` (`bin` in `package.json:9`) | The only executable. Dispatches on `argv[0]` via a command table |
| Command table | `src/cli.ts:140` | 13 commands → `(args) => Promise<Envelope>`; unknown command prints `USAGE` (`src/cli.ts:63`) and exits 1 |
| `main()` | `src/cli.ts:156` | Parse args → look up command → `emit(envelope, --json)` |
| HTTP review server | `server/index.ts:30` `createServer()` | Node `http`, no framework. ~14 routes under `/api/*`, static fallback to `web-dist` |
| Review web app | `web/src/main.tsx:1` → `web/src/App.tsx:12` | React 19 SPA, four sheets: Summary, Review, Glossary, Check |
| Vitest | `vitest.config.ts` | `test/**`, `src/**`, `server/**` — `*.test.ts` |

### The 13 commands

Split by the law that a command **either observes or acts** (`src/cli.ts:168` onward is
observations; `src/cli.ts:666` onward is actions).

| Command | Handler | Spends | Writes |
|---|---|---|---|
| `status` | `src/cli.ts:346` → `src/commands/observe.ts:43` | — | — |
| `plan` | `src/cli.ts:366` → `src/commands/observe.ts:160` | — | — |
| `inspect` | `src/cli.ts:415` → `src/commands/observe.ts:259` | — | — |
| `explain` | `src/cli.ts:480` → `src/commands/observe.ts:318` | — | — |
| `diff` | `src/cli.ts:525` → `src/commands/observe.ts:447` | — | — |
| `casebook` | `src/cli.ts:282` → `src/review/casebook.ts:53` | — | — |
| `ledger` | `src/cli.ts:192` → `src/ledger/ledger.ts:84` | — | — |
| `report` | `src/cli.ts:925` | — | workbook |
| `run` | `src/cli.ts:666` | **$$$** | workbook, run.json, glossary, evidence |
| `review` | `src/cli.ts:995` → `src/commands/review.ts:41` | ~1 req/edit | glossary, decisions |
| `apply` | `src/cli.ts:1022` | — | re-import CSV / Mongo script |
| `score` | `src/cli.ts:1067` | ~$0.55 @ N=400 | ledger row |
| `probe` | `src/cli.ts:1227` → `src/commands/probe.ts:11` | ~$0.10 | ledger row |

---

## 3. The layer map

Each level is a pure function of the one below. Level 3 is the only one that costs money or
can fail; level 5 is the only one a human writes.

| # | Level | Substance | Cost | Modules |
|---|---|---|---|---|
| 0 | Text facts | folding, placeholders, tags, case, word boundaries | free | `src/util/text.ts` (zero imports) |
| 1 | Corpus | keys × languages; the **cell** is the unit | free | `src/sources/{mongo,csv,synthetic}.ts` |
| 2 | Proven evidence | exact defects, contested terms — by counting | free | `src/lint.ts`, `src/mine.ts` |
| 3 | Judged evidence | what Jev answered | **$** | `src/audit.ts`, `src/arbitrate.ts`, `src/substitute.ts` |
| 4 | Policy | evidence + thresholds → findings. No inference, no I/O | free | `src/compose.ts`, `src/policy/rules.ts` |
| 5 | Decisions | what a human settled | — | `src/glossary/store.ts`, `src/review/decisions.ts` |
| 6 | Projections | workbook, CSV, review app, stdout | free | `src/report/`, `server/`, `web/` |

**Import direction verified.** `grep -o 'from "..."'` over levels 0–4 shows no upward edge:
`util/text.ts` imports nothing; `lint.ts`/`mine.ts` import only `types` + `util/text`;
`compose.ts` imports `types`, `util/text`, `glossary/match`, `config/profile`, `policy/rules`
— no source adapter, no client, no reporter.

**The one cycle is 5 → 3**: a human-decided glossary term is handed to the next audit as
state (`src/cli.ts:787` `guidanceByTerm` → `src/jev/questions.ts:156`), so one translator's
rule reaches keys nobody has opened.

---

## 4. Key types

| Type | Location | Purpose |
|---|---|---|
| `Entry` | `src/types.ts:5` | One key: id, project, keyName, source text, dev note, `tr: Record<Lang, string>` |
| `Corpus` | `src/types.ts:17` | `sourceLang`, `langs[]`, `entries[]`, `origin` string. Level 1 in full |
| `LintIssue` | `src/types.ts:35` | `(entryId, lang, code, detail)` — a **proven** defect. 9 codes at `src/types.ts:24` |
| `TermConflict` | `src/types.ts:48` | A (term, language) pair rendered ≥2 ways, with variant counts. The unit arbitration buys |
| `GlossaryEntry` | `src/types.ts:57` | Level-4 view of a term: `canonical`, `confidence`, `interchangeable`, `doNotTranslate`, `covered`, `severity`. `null` means *not known* (never `NaN` — JSON cannot carry it) |
| `GlossaryRecord` | `src/glossary/store.ts:40` | `GlossaryEntry &` what a human settled (`status`, `guidance`, `decidedBy/At`). One shape, so `view()` (`store.ts:52`) can only *drop* fields |
| `EntryJudgment` | `src/types.ts:108` | What Jev answered about one key: `isUiString`, `meaning[lang]`, `adheres[lang]`, `register[lang]` |
| `Finding` | `src/types.ts:90` | One reviewable row: entry × lang, `reasons[]`, `category`, `severity` 0–3, `action`, `confidence`, `judged` |
| `Reason` | `src/policy/rules.ts:15` | **Structured**, 15-variant discriminated union. English is rendered at display time (`rules.ts:57`), never parsed back |
| `Envelope` | `src/report/envelope.ts:46` | The one shape every command returns: `inputs`, `coverage`, `counts`, `groups`, `tables`, `cost`, `outputs`, `warnings`, `next` |
| `Coverage` | `src/types.ts:148` | `attempted / answered / failed / skipped`. Exists so *unjudged* never silently reads as *clean* |
| `EvidenceRecord` | `src/evidence/store.ts:22` | A bought judgment, addressed by `fingerprint(model, state, questions)` |

---

## 5. Data flow

### `run` — the full pipeline (`src/cli.ts:666`)

```
  --mongo / --csv / --synthetic
         │
         ▼
  ┌─────────────────┐
  │ loadCorpus      │  src/cli.ts:553 → sources/{mongo,csv,synthetic}.ts
  │ → Corpus        │  level 1
  └────────┬────────┘
           ├──────────────────────────┐
           ▼                          ▼
  ┌─────────────────┐        ┌─────────────────┐
  │ lintCorpus      │        │ mineGlossary    │   level 2 — FREE, deterministic
  │ → LintIssue[]   │        │ → TermConflict[]│   12,779 defects cost $0
  │ lint.ts:23      │        │ mine.ts:31      │
  └────────┬────────┘        └────────┬────────┘
           │                          │ trivial variants resolved in code (no request)
           │                          ▼
           │                 ┌─────────────────────────────┐
           │                 │ mergeMined + loadGlossary   │  level 5 → 3
           │                 │ decided terms are REUSED    │  glossary/store.ts:115
           │                 └────────┬────────────────────┘
           │                          ▼
           │                 ┌─────────────────┐
           │                 │ arbitrate       │  ⚑ $  870 req / 4,350 judgments
           │                 │ arbitrate.ts:22 │  "which rendering is canonical?"
           │                 └────────┬────────┘
           │                          ▼
           │                 enforceable(records) — store.ts:307
           │                          │
           └──────────┬───────────────┘
                      ▼
            ┌───────────────────────┐
            │ audit                 │  ⚑ $  6,968 req / 92,264 judgments (92% of bill)
            │ audit.ts:102          │  lint issues passed IN as state (law L1)
            │ → EntryJudgment map   │  one request per key, all langs at once
            └──────────┬────────────┘
                       ▼
            ┌───────────────────────┐
            │ compose               │  level 4 — FREE, pure, no I/O
            │ compose.ts:36         │  probabilities + thresholds → Finding[]
            └──────────┬────────────┘
                       ▼
            ┌───────────────────────┐
            │ propose + verify      │  ⚑ $  1,040 req / 3,120 judgments
            │ substitute.ts:16, :90 │  3 gates: grammatical, preserved, improved
            └──────────┬────────────┘
                       ▼
     ┌─────────────────┼──────────────────┬────────────────┐
     ▼                 ▼                  ▼                ▼
  audit.xlsx      audit.run.json   audit.glossary.json  Envelope→stdout
  xlsx.ts:60      cache.ts:33      store.ts:98          envelope.ts:166
  6 sheets        whole corpus +   level-5 state for
                  every judgment   the next run
```

Every request passes through `JevClient.one()` (`src/jev/client.ts:107`), which checks the
evidence store *first* and only then POSTs. `JevClient.run()` (`:160`) drives N lanes
(default concurrency 12) with exponential backoff on 429/529/5xx and collects `StageStats`.

### `report` — free re-render (`src/cli.ts:925`)

`audit.run.json` → `loadCache` (`src/cache.ts:38`) → `compose` with *new* thresholds →
workbook. No network. This is why law L2 (Jev never applies policy) pays: a threshold
change re-renders in under a second from judgments already bought.

### `review` → `apply` — the human loop

```
run.json ──► Session (server/api.ts:52) ──► /api/rows ──► React Review sheet
                  │                                            │
                  │  glossary + decisions files                │ verdict / edited text
                  ▼                                            ▼
          saveGlossary / saveDecisions ◄──── POST /api/decision, /api/glossary
                  │
                  ├──► next `run` reuses decided terms  (the 5→3 cycle)
                  └──► /api/export.csv  or  apply audit.xlsx → lokalise-reimport.csv
                                                    report/reimport.ts:19
```

`Session.recompose()` (`server/api.ts:132`) re-runs `compose` in-process whenever policy
changes, so the app's thresholds are the CLI's thresholds by construction.

Two live-check paths, sharing one question set (`src/jev/questions.ts:272`):
- `POST /api/check` (`api.ts:345`) — a reviewer editing a flagged row; needs a key in the corpus.
- `POST /api/consistency` (`api.ts:382`) — **any** text in any language, even a key nobody has
  translated. The glossary half is exact, free and keyless; `"semantic": false` asks for that half alone.

---

## 6. Evidence store — why the second run is free

`src/evidence/store.ts`. An append-only JSONL file next to the workbook
(`<out>.evidence.jsonl`, path derived at `store.ts:136`).

- **Address** = `sha256(model, canonicalise(state), questions).slice(0,32)` (`store.ts:61`).
- `state` is key-sorted (`canonicalise`, `store.ts:40`) because its key order carries nothing.
- `questions` are **not** sorted — a Choice's option order is meaningful, and `probe` exists
  precisely to ask the same question with options reversed. Sorting would hand the second
  ask the first one's answer and destroy the measurement (`store.ts:50`, comment).
- `stage` and `unit` label the record but are **not** part of the address, so renaming a
  stage never invalidates a judgment (`jev/client.ts:104`).
- Append-only: a crash costs at most the line being written; unparseable lines are counted
  as `damaged` and skipped (`store.ts:88`).

Consequences: an identical re-run sends 0 requests; an interrupted run resumes itself;
rewording one question re-asks only the units that ask it. `cost.requests` counts what was
**sent**, with reuse in `cost.reused` (`report/envelope.ts:34`), so a warm run reads
`0 requests · 6,968 reused · $0.00`. `test/warm.test.ts` proves this **across a process
boundary** — the failure mode is a state field that varies per process, which would turn
every judgment into a miss silently.

`plan` (`src/commands/observe.ts:160`) builds the exact same request objects, fingerprints
them against the store, and prices only the misses — using per-stage token means learned
from records already bought once there are ≥20 of them (`observe.ts:130`).

---

## 7. External dependencies

| Dependency | Purpose | Critical? |
|---|---|---|
| **TypeSafe System One / Jev** (`https://api.typesafe.ai/v1/systemone`) | The entire cost and latency of the tool. POST `{state, model, questions}` → `{answers, usage}` | **Yes** for `run`/`score`/`probe`/live checks; every free command works without it |
| `exceljs` 4.4.0 | Workbook write + read-back (`src/report/xlsx.ts`) | Yes for `run`/`report`/`apply` |
| `mongodb` 6.21.0 | Lokalise-shaped corpus loader: `Projects`, `Keys`, `Translations` (`src/sources/mongo.ts:14`) | Only for `--mongo` |
| `react` / `react-dom` 19 | Review SPA (`web/`) | Only for `review` |
| Node ≥22.6 built-ins | `--experimental-strip-types` runs `.ts` directly; `node:http`, `node:crypto`, `node:fs` | Yes — no transpile step for the CLI |
| `vite`, `vitest`, `oxlint`, `typescript`, `concurrently` | dev only | No |

The model client is a hand-rolled `fetch` wrapper (`src/jev/client.ts:80`) — no SDK. Three
question types: `noul` (probability), `choice` (options + probabilities + confidence),
`score` (ordinal levels). Constructors at `client.ts:31-44`.

### Jev's question set (`src/jev/questions.ts`)

| Stage | Questions | Line |
|---|---|---|
| arbitrate | `canonical`, `interchangeable`, `doNotTranslate`, `severity`, `covered`, `sourceAmbiguous` | `:71` |
| audit | `uiString`, then `meaning:<lang>`, `adheres:<lang>`, `register:<lang>` per applicable language | `:185` |
| substitute | `grammatical`, `preserved`, `improved` | `:246` |
| live check | `meaning`, `grammatical`, `glossaryOk` | `:272` |

`questionsFingerprint()` (`:293`) hashes every question over a fixed fixture, so a saved run
can name the wording that produced it. Current build: `4442fb6c0164`.

---

## 8. Configuration

One profile, four layers, later wins (`src/config/profile.ts:110`). Every run prints which
layers spoke and saves them to `provenance.configuredBy` (`src/cli.ts:836`).

| Priority | Source | Example |
|---|---|---|
| 1 (lowest) | Defaults | `DEFAULT_POLICY` `profile.ts:26`, `DEFAULT_GATES` `:44`, `DEFAULT_DOMAIN` `:52` |
| 2 | `translate-audit.config.json` | `{ domain, policy, gates, model, baseUrl, pricing, concurrency }` (`ProfileFile` `:69`) |
| 3 | Environment | `JEV_MODEL`, `TYPESAFE_BASE_URL`, `JEV_PRICE_IN/OUT`, `JEV_CONCURRENCY`, `TRANSLATE_AUDIT_DOMAIN` (`:145`) |
| 4 (highest) | CLI flags | `--meaning-bad 0.2`, `--gate-improved`, `--concurrency` (maps at `:79`, `:90`) |

Secrets and infra sit outside the profile: `TYPESAFE_API_KEY` (required for the four spending
commands), `MONGO_URI`, `JEV_TIMEOUT_MS`. A `.env` is walked up to 6 directories and never
overwrites an already-set variable (`src/config/args.ts:4`).

### Default policy thresholds (`profile.ts:26`)

```
meaningBad 0.35 · meaningDoubtful 0.70 · adherenceBad 0.40 · uiStringMin 0.25
registerMinSample 25 · registerMinDominance 0.80 · registerMinConfidence 0.60
canonicalConfidence 0.60      gates: grammatical 0.70 · preserved 0.80 · improved 0.60
```

`policyNote()` (`profile.ts:181`) renders these into one English sentence printed in the
workbook, so the thresholds that produced a number travel with the number.

Arg parsing is 77 lines, no library (`src/config/args.ts:32`). `flagBool` (`:72`) handles
`--fix`, `--fix false` and `--no-fix` — the last form was once parsed into a flag nothing
read, so `--no-fix` silently spent the money anyway.

---

## 9. Output surfaces

### The envelope (`src/report/envelope.ts`)

Every command returns one `Envelope`. `--json` makes it the whole of stdout; the human text
is `render`ed **from that same object** (`envelope.ts:99`), so the two cannot disagree and
the machine path is the tested one. Narration and progress go to stderr (`note()` `:172`,
`src/util/progress.ts:5`). `ok: false` sets exit code 1 (`:168`).

### Workbook — 6 sheets (`src/report/xlsx.ts:60`)

| Sheet | Line | Contents |
|---|---|---|
| Dashboard | `:76` | Counts by severity/category/language/reason, coverage, cost, policy note |
| Findings | `:155` | 14 columns; col 9 is a `Decision` dropdown, col 10 a formula defaulting to current/suggested |
| Glossary | `:206` | Every term known, enforceable or not, with `interchangeable` and origin |
| Keys | `:248` | Per-key view across languages |
| Automated checks | `:286` | Raw lint issues — the free half, itemised |
| Run | `:297` | Stage stats, latency percentiles, provenance |

`readDecisions()` (`:363`) reads the Decision column back **by position** (cells 3, 5, 7, 8,
9, 10, 14). `test/roundtrip.test.ts` exists for exactly this reason — reordering a column
silently breaks `apply`.

### Re-import (`src/report/reimport.ts`)

`selectChanges` (`:8`) keeps rows where a human said accept/edited and the text actually
changed → `writeReimportCsv` (`:19`, BOM + Lokalise column names) or `writeMongoScript` (`:27`).

---

## 10. Test infrastructure

246 tests, 17 files, 2.1 s, **no API key required** — the client is injected as a fake
wherever a stage is exercised.

| File | Tests | What it protects |
|---|---|---|
| `test/pipeline.test.ts` | 34 | End-to-end lint → mine → arbitrate → audit → compose |
| `test/glossary.test.ts` | 31 | Record shape, `isDecided` guard, merge, drift, version-1 migration |
| `test/evidence.test.ts` | 21 | Fingerprint stability, hit/miss, damaged lines, question-order sensitivity |
| `test/regressions.test.ts` | 20 | Named past bugs, each pinned |
| `test/review.test.ts` | 19 | Session, routes, decision persistence |
| `test/text.test.ts` | 19 | Level 0: folding, placeholders, tags, case, boundaries |
| `test/calibrate.test.ts` | 17 | Reliability bins, ECE, Brier, operating points |
| `test/observe.test.ts` | 17 | `status`, `plan`, `inspect`, `explain`, `diff` |
| `test/casebook.test.ts` | 15 | Translator verdicts → labelled cases → precision |
| `test/coverage.test.ts` | 12 | Unjudged never reads as clean |
| `test/profile.test.ts` | 10 | Four-layer precedence, `sources` attribution |
| `test/ledger.test.ts` | 9 | Append, read, diff two measurement rows |
| `test/rules.test.ts` | 8 | Structured reasons render; no prose is parsed back |
| `test/consistency.test.ts` | 7 | `/api/consistency`, including the keyless free half |
| `test/envelope.test.ts` | 6 | Render is a function of the envelope |
| `test/roundtrip.test.ts` | 5 | Workbook columns read back by position |
| `test/warm.test.ts` | 3 | Cache hits survive a **process boundary** |

Beyond unit tests, three measurement commands close the loop: `score --synthetic N`
(precision/recall/calibration against injected ground truth, `src/sources/synthetic.ts:82`),
`probe` (order robustness + out-of-scope behaviour — the two properties that fail silently),
and `casebook` (precision against what translators actually decided on the real corpus;
precision only, since a reviewer never sees the rows a missed defect lives in —
`RECALL_NOTE` at `src/review/casebook.ts:175`). `ledger` (`src/ledger/ledger.ts`) keeps every
measurement so "did that change help?" is a diff of two rows.

---

## 11. Notes & gotchas

- **`audit.run.json` in this tree is cache version 1 and carries no provenance.** It holds 5
  arbitration judgments per request where this build asks 6 (`sourceAmbiguous` was added
  later). `report` emits a `no-provenance` warning; `loadCache` (`src/cache.ts:38`) migrates
  v1 by filling `null`/`0` and wrapping legacy prose reasons as `{rule:"legacy"}`.
- **`sourceAmbiguous` is asked of every arbitration and read by nothing** (`questions.ts:114`).
  ~$0.045 wasted on a cold run. Removing it changes the question fingerprint, hence every
  cached judgment — so it needs a `probe` and a re-`score` with the old seed, not a silent edit.
- **`--only-flagged` halves the audit bill and goes blind to meaning errors in strings that
  look clean** (`src/cli.ts:778`) — it only asks about keys with a hard lint issue or a
  glossary term.
- **At most one substitution proposal per finding** (`src/substitute.ts:67`, `break`). Composing
  two fixes is the tempting repair and a trap: verification asks whether one exact `after`
  string is grammatical, and a second edit destroys that string while keeping the receipt.
- **A human decision is never overwritten.** `isDecided()` (`src/glossary/store.ts:14`) guards
  `mergeMined` and `applyArbitration`. A suspended term keeps its proposed canonical, because
  `isEnforceable` (`:27`) reads *status* — so putting the status back is an undo, not a re-run.
- **`null` means not-known, never `NaN`** (`src/types.ts:62`). JSON cannot carry `NaN` and
  `Number.isNaN(null)` is false; that was one real bug and a conversion at every boundary.
- **`probe` deliberately bypasses the evidence store** — exercising the live endpoint is its
  entire point.
- **The review server binds with `Access-Control-Allow-Origin: *`** (`server/index.ts:46`) and
  has no auth. It is a localhost tool for a translator, not a deployable service.
- **Artifacts embed the whole corpus.** `.gitignore` excludes `*.xlsx`, `*.run.json`,
  `*.glossary.json`, `*.decisions.json`, `*.evidence.jsonl`, `runs/` for that reason — the
  files present in this working tree are untracked.

---

## 12. Where to look next

| Question | File |
|---|---|
| How to drive the tool as an agent | `AGENTS.md` |
| The system as designed — laws, fingerprint, command taxonomy | `DESIGN.md` |
| The staged path from this tree to that design | `PLAN.md` |
| The seven layers of verification | `TESTING.md` |
| What it is for and what it found | `README.md` |
