# AGENTS.md — driving translate-audit

This tool finds terminology and meaning defects in a translated corpus that never had a
glossary. Two things about it decide how you should drive it:

- **Only one layer costs money.** Loading, exact checks, mining, policy and reporting are
  free and deterministic. Requests to Jev are the entire bill and the entire latency.
- **Judgments outlive the run that bought them.** `audit.run.json` holds every answer, so
  every question about a finished run — and every change of threshold — is free.

**Every command returns one envelope.** `--json` makes it the whole of stdout; narration and
progress go to stderr. So `translate-audit <command> --json | jq …` always works, and the
human text you see without `--json` is *rendered from that same object* — the two cannot
disagree. Each envelope carries `inputs`, `coverage`, `counts`, `groups`, `tables`, `cost`,
`outputs`, `warnings` and `next` — and `next` is that command's own opinion about what to run
after it.

Spend nothing until you have looked. The map below is what to look at.

## The tower

Each level is a pure function of the one below it, except level 3, which is the only level
that costs money or can fail, and level 5, which is the only level that a human writes.

| # | Level | Substance | Cost | Where |
|---|---|---|---|---|
| 0 | Text facts | folding, placeholders, tags, case, word boundaries | free | `src/util/text.ts` |
| 1 | Corpus | keys × languages — the **cell** is the unit of everything above | free | `src/sources/` |
| 2 | Proven evidence | exact defects and contested terms, established by counting | free | `src/lint.ts`, `src/mine.ts` |
| 3 | Judged evidence | what Jev answered about a cell or a term | **$** | `src/audit.ts`, `src/arbitrate.ts`, `src/substitute.ts` |
| 4 | Policy | evidence + thresholds → findings. No inference, no I/O | free | `src/compose.ts` |
| 5 | Decisions | what a human settled: glossary terms, row verdicts | — | `src/glossary/store.ts`, `src/review/decisions.ts` |
| 6 | Projections | workbook, re-import CSV, review app, stdout | free | `src/report/`, `server/`, `web/` |

The one cycle in the tower is 5 → 3: a decided term is handed to the next audit as state, so
a translator's rule reaches keys nobody has opened. That loop is the point of the system.

**Imports run one way.** Level *n* imports from levels below it and never from above. `compose.ts`
importing a source adapter, or `lint.ts` importing the client, means a layer has been broken.

## The laws

These hold today. Preserve them in any change.

- **L1 — Jev is never asked what code can prove.** A missing `{0}`, an unbalanced `<b>`, a
  casing change and a byte-identical copy are facts. `lint.ts` establishes them for free and
  passes them into the request as state. This is why 12,779 exact defects cost nothing.
- **L2 — Jev is never asked to apply policy.** It returns probabilities per dimension.
  Whether 0.35 counts as a defect lives in `compose.ts`, so a threshold change re-renders
  from saved judgments in under a second.
- **L3 — a human decision is never overwritten by a machine.** `isDecided()` in
  `glossary/store.ts` guards this. Re-arbitrating a decided term invites the model to
  overrule someone who knew better.
- **L4 — evidence is addressed by its inputs, not by when it was made.** A judgment's address
  is `fingerprint(model, state, questions)` and lives in `<out>.evidence.jsonl`, appended as
  it is bought. So an identical re-run costs nothing, an interrupted run resumes by itself,
  and rewording one question re-asks only the units that ask it. `--no-cache` asks everything
  afresh; `probe` never reads the store, because exercising the live endpoint is its point.
- **L5 — unjudged is never silently equal to clean.** Every stage reports
  `attempted / answered / failed / skipped`; a `Finding` carries `judged`; `run`, `report` and
  the workbook state coverage. A summary over partial evidence says it is a floor.
- **L6 — prose is rendered from structure, never parsed back.** A reason is `{ rule, …args }`
  in `src/policy/rules.ts`; `renderReason` produces the English at display time. Group and
  filter on `rule`. The review API sends both: `reasons` rendered, `rules` to match on.
- **L7 — a command either observes or acts.** `status`, `plan`, `inspect`, `explain`, `diff`,
  `casebook`, `ledger` and `report` spend nothing, change no stored state, and are safe to
  repeat. `run`, `score`, `probe`, `apply` and `review` spend. Every action has an observation
  in front of it, so the only way to find out what something costs is never to pay for it.
  (`report` and `apply` write the file you named — that is idempotent, and neither touches the
  glossary, the decisions, the evidence or the ledger.)

## Free or costly

| Command | Spends | Writes | Use it to |
|---|---|---|---|
| `status` | nothing | nothing | see what is in this directory and whether the pieces agree |
| `plan` | nothing | nothing | see what a run would ask and what it would cost, before it costs it |
| `inspect <run> <key>` | nothing | nothing | everything known about one key, across every layer |
| `explain <run> <key> <lang>` | nothing | nothing | why a row was raised, and what value would flip it |
| `diff <a> <b>` | nothing | nothing | what changed between two runs, by rule and severity |
| `casebook <run>` | nothing | nothing | what translators decided, as labelled cases, and the precision that implies |
| `ledger [--diff a b]` | nothing | nothing | what previous runs measured, and what a change did to the numbers |
| `run --dry-run` | nothing | nothing | check a corpus is wired up; see the contested terms |
| `report <run.json>` | nothing | the workbook | change a threshold, filter, re-render |
| `review <run.json>` | ~1 request per edit typed | glossary, decisions | hand it to a translator |
| `apply <audit.xlsx>` | nothing | re-import CSV | turn signed-off rows into a TMS import |
| `probe` | ~$0.10 | nothing | verify an endpoint before trusting a glossary from it |
| `score --synthetic N` | ~$0.55 at N=400 | nothing | measure precision, recall and calibration |
| `run` | the whole bill | workbook, run.json, glossary | produce an audit |

Exact invocations are in `package.json` scripts and `translate-audit --help`. Read those
rather than guessing flags.

**Configuration is one profile**: defaults, then `translate-audit.config.json`, then the
environment, then flags — later layers win. Every run prints which layers spoke, and saves
them into `provenance.configuredBy`. To change a threshold for one command, pass the flag;
to change it for the project, write the file.

### What a run costs

One request per key that has at least one translation, plus one per contested (term, language),
plus one per proposed substitution. From the `audit.run.json` in this directory — a real
7,040-key × 8-language cold run, at the default prices:

| Stage | Requests | Judgments | Wall | Cost |
|---|---|---|---|---|
| arbitrate | 870 | 4,350 | 17 s | $0.59 |
| audit | 6,968 | 92,264 | 138 s | $10.95 |
| substitute | 1,040 | 3,120 | 19 s | $0.34 |

Audit is 92% of the bill, and it scales with keys, not with defects. The knobs, cheapest
first: `--dry-run` (free), `--limit N`, `--max-terms N`, `--only-flagged` (roughly half the
requests, and blind to meaning errors in strings that look clean), `--no-fix`.

**The second run of anything is nearly free.** Judgments are appended to
`<out>.evidence.jsonl` addressed by `(model, state, questions)`, so re-running identical
inputs makes no requests, an interrupted run resumes by itself, and changing one question
re-asks only the units that ask it. Iterating on question wording costs the delta, not $11.89.
`--no-cache` forces everything afresh.

## What you want → what to run

| You want | Run | Cost |
|---|---|---|
| to know what is in this directory at all | `status` — start here in an unfamiliar working tree | free |
| to know what a run would cost before running it | `plan <same source flags as run>` — it prices only what the evidence store does not already hold | free |
| to know whether a new corpus is wired up | `run --dry-run` — if contested terms look like `part_b2100`, the source column is an identifier, not text | free |
| a different threshold, category filter or severity floor | `report <run.json> --meaning-bad 0.2 --min-severity 2` | free |
| any number about a finished run | `jq` over `run.json` — recipes below | free |
| to know whether a change helped | `score --synthetic 400 --seed 20250920` before and after, then `ledger --diff <a> <b>` — the seed makes the difference attributable and the ledger keeps it | ~$0.55 each |
| to know how the pipeline does on the *real* corpus | `casebook <run>` — every verdict a translator entered is a label. Precision only: a reviewer never sees the rows a missed defect lives in | free |
| to trust an endpoint you just pointed at | `probe --order 40 --scope 40` | ~$0.10 |
| a smaller bill on a real corpus | `--limit`, then `--only-flagged`, then `--no-fix`, in that order | — |
| to see why one row was raised | `explain <run> <entry-id> <lang>` — evidence, threshold, contribution, and the value that would flip it | free |
| everything known about one key | `inspect <run> <entry-id \| key name \| source text>` | free |

## Reading a result

```sh
translate-audit report audit.run.json --json | jq .counts      # what it found
translate-audit report audit.run.json --json | jq .coverage    # whether to trust it
translate-audit report audit.run.json --json | jq -r .next[]   # what to run next
translate-audit run --synthetic 200 --dry-run --json | jq .    # free, no key
```

A non-zero exit and `ok: false` mean the envelope's `warnings` say what went wrong; there is
no stack trace to parse.

## Reading a finished run without spending anything

`audit.run.json` is the whole corpus plus every judgment. These are verified against the
production run in this directory.

```sh
# coverage — the number that tells you whether the audit is blind anywhere
jq -r '(.stages[]|select(.name=="audit")) as $a
  | "audit requests \($a.requests) · errors \($a.errors) · judgments stored \(.judgments|length) · blind \($a.requests - (.judgments|length))"' audit.run.json

# what each stage cost, at the prices in JEV_PRICE_IN / JEV_PRICE_OUT
jq -r '.stages[] | "\(.name)\t\(.requests) req\t\(.errors) err\t$\((((.inputTokens/1e6)*0.4)+((.outputTokens/1e6)*2.0))*100|round/100)"' audit.run.json

# exact defects by kind — no model was involved in any of these
jq -r '.lintIssues | group_by(.code) | map({code:.[0].code, n:length}) | sort_by(-.n)[] | "\(.n)\t\(.code)"' audit.run.json

# everything known about one key
jq --arg id "<entry-id>" '{entry: (.corpus.entries[]|select(.id==$id)),
   judgment: (.judgments[]|select(.[0]==$id)|.[1]),
   lint: [.lintIssues[]|select(.entryId==$id)]}' audit.run.json
```

**A judgment count below the request count is a blind spot, not a clean bill.** A failed
request leaves its key unjudged, and an unjudged key produces only lint findings — which
looks exactly like a key that passed.

`run` and `report` now state coverage themselves, and say the counts are a floor when
anything failed. A finding carries `judged`, and a row on an unjudged key carries a
`not-judged` reason. The recipe above is still the fastest check on a file you were handed.

## Sharp edges

Verified in this tree. Each is a thing that returns a well-formed answer while being wrong.

| Edge | Consequence |
|---|---|
| runs saved before stage 1 carry no provenance | `audit.run.json` here has 5 arbitration judgments per request where this build asks 6. `report` now says so — new runs record `provenance.questions`, and a mismatch with this build is printed |
| `interchangeable` and `sourceAmbiguous` are asked of every arbitration and read by nothing | ~1,740 paid judgments discarded on a cold 870-term run (~$0.09). The waste is small; the category is not. Removing them changes what is asked, so it needs a `probe` and a re-`score` with the old seed — not a silent edit |
| `proposeSubstitutions` can emit several proposals for one finding, and each overwrites `finding.suggested` as it completes | 1,040 substitution requests stored 1,019 suggestions. Which of two verified fixes survives depends on lane completion order, so a run is not reproducible from its inputs |
| `autoFixMaxSeverity` is declared, defaulted and tested, and read by nothing | a policy knob that does nothing |

## After you change something

| Changed | Run |
|---|---|
| `util/text.ts`, `lint.ts`, `mine.ts`, `compose.ts`, `report/` | `npm test` — 210 tests, ~3 s, no key needed |
| a question in `jev/questions.ts` | `npm test`, then `probe`, then `score` with the seed you used before |
| a threshold in `compose.ts` | `report <run.json>` with the old and new values and compare counts. Re-running `run` to see a report change means the cache is not being used |
| anything touching the workbook columns | `npm test` — `roundtrip.test.ts` exists because `apply` reads the Decision column back **by position** |
| `TYPESAFE_BASE_URL` or `JEV_MODEL` | `probe` first. Order robustness and out-of-scope behaviour fail silently |

## Further

- `DESIGN.md` — the system as a whole: the tower, the laws in full, the evidence
  fingerprint, structured reasons, the memories that accrete, and the command taxonomy.
  Read it before changing a layer boundary or adding a command.
- `PLAN.md` — the staged path from this tree to that design. Each stage is independently
  shippable and states its own acceptance check. Read it before starting work.
- `TESTING.md` — the seven layers of verification, cheapest first.
- `README.md` — what the tool is for and what it found, with measured numbers.
