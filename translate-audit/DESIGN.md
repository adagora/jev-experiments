# DESIGN.md — the system

`AGENTS.md` is how to drive this tool today. This is what it is, and what it is becoming.
`PLAN.md` sequences the difference.

## One idea

`Entfernen` is a perfectly good German word. It is wrong only because nine other keys say
`Löschen`. Consistency is not a property of a string, so no per-string check can see it —
the object of study is a **corpus with evidence attached to it**.

That reframing produces the whole design, because it separates three things that a
string-at-a-time tool keeps tangled:

- **Cost** — what has to be asked of a model.
- **Opinion** — what counts as a defect.
- **Memory** — what a human has settled.

Each belongs in exactly one layer, and every rule below is a consequence of keeping them
apart. When they leak into each other you get the failures this design exists to prevent: a
threshold change that costs $12, a model overruling a translator, a measurement that cannot
be attributed to what changed.

## The tower

Level *n* is a pure function of the levels below it. Imports run one way.

| # | Level | Owns | Contract |
|---|---|---|---|
| 0 | **Text facts** | folding, placeholders, tags, case shape, word boundaries, case-preserving replacement | total functions, no domain knowledge, no I/O |
| 1 | **Corpus** | keys, languages, projects, provenance of which field is the source | adapters converge on one shape; nothing above knows Mongo from CSV |
| 2 | **Proven evidence** | exact defects; contested terms mined by grouping and counting | deterministic, free, replayable from the corpus alone |
| 3 | **Judged evidence** | what Jev answered about a cell or a term | the only level that spends money or fails. Builds state and questions from below, stores answers addressed by their inputs |
| 4 | **Policy** | thresholds, severity, category, action | pure. Reads evidence, writes findings, asks nothing and infers nothing |
| 5 | **Decisions** | glossary status, canonical, rule; row verdicts | written only by humans. Machines propose into it and never overwrite it |
| 6 | **Projections** | workbook, re-import, review app, stdout | read-only over 4 and 5 |

### The cycle

There is one edge that runs upward, and it is the point of the system:

```
 5 Decisions ──┐
               ↓  a decided term, and the rule a translator wrote in their own words,
 3 Judged evidence   become state on the next audit
```

A translator writes *"Tor when it is a gate in a fence; Tür when it is a garage door"*, and
that sentence reaches thousands of keys nobody has opened. Everything else about the memory
design exists to protect this edge.

## The laws

**L1 — Jev is never asked what code can prove.**
A missing `{0}`, an unbalanced `<b>`, a trailing space, a casing change and two strings being
byte-identical are facts. Level 2 establishes them for free and passes them into the request
as state, so the model weighs a defect in context instead of re-deriving it.
*Prevents:* paying a model to do arithmetic, and a run over 7,040 keys taking an afternoon.

**L2 — Jev is never asked to apply policy.**
It returns raw probabilities per dimension. Whether 0.35 is a defect is a business decision.
*Prevents:* a threshold change costing a run. Also avoided ~56,000 Score questions — roughly
$8 — by computing severity in `compose.ts` instead of asking for it per language.

**L3 — a human decision is never overwritten by a machine.**
`approved`, `rejected`, `context-dependent` and `do-not-translate` belong to whoever set them.
*Prevents:* re-arbitration quietly overruling someone who knew better.

**L4 — evidence is addressed by its inputs, not by when it was made.**
A judgment is a function of exactly three things: the model, the state, the questions. Its
address is their **fingerprint**.
*Prevents:* the four failures in *The keystone* below.

**L5 — unjudged is never silently equal to clean.**
Every stage reports attempted / answered / failed / skipped, and every cell carries whether
it was judged. Any summary states its own coverage.
*Prevents:* a 5% error rate reading as a 5% improvement.

**L6 — prose is rendered from structure, never parsed back.**
A reason is a rule id and its arguments. English is produced at display time.
*Prevents:* rewording a sentence changing which rows get auto-fixed — and it had already
happened: `hit.note.includes("verified")` matched *"could not be verified"*, so re-rendering
a report marked unverifiable substitutions `auto-fix`.

**L7 — a command either observes or acts.**
An observation spends nothing, changes no stored state, and can be repeated safely. An action
declares what it will spend before spending it. No command is both.
*Prevents:* the only way to find out what something costs being to pay for it.
The line is about **spend and state**, not about bytes on disk: `report` writes the workbook
it was asked for by name, which is idempotent and free, and it touches no glossary, no
decisions, no evidence and no ledger.
Half of this holds: every command returns one envelope, `--json` makes it the whole of
stdout, and narration goes to stderr. The observations that preview an action — `plan`,
`status` — are stage 6.

All seven hold today. `PLAN.md` records how each one landed, and the four bugs that surfaced on the way.

## Vocabulary

One name per thing, used in code, docs, CLI and UI alike.

| Term | Means |
|---|---|
| **cell** | one (key, language) pair — the unit everything above level 1 is about |
| **evidence** | anything known about a cell or term. *Proven* (counted) or *judged* (asked) |
| **fingerprint** | the address of a judgment: a hash of model, state and questions |
| **finding** | a cell plus the reasons policy raised it, with severity, category and action |
| **reason** | a rule id and its arguments. Renders to English; never parsed |
| **term** | a source-language phrase with a per-language canonical rendering |
| **canonical** | the rendering a term should use everywhere |
| **enforceable** | a term with a canonical and a status that permits enforcement |
| **verdict** | a human's answer on one cell: accept, reject, edited, defer |
| **coverage** | the share of attempted units that actually have evidence |
| **ledger** | the append-only record of what each run and measurement produced |

`GlossaryEntry` and `GlossaryRecord` are two shapes of one thing, converted lossily in both
directions — `asGlossaryEntries` drops status, `enforceable` fabricates `origin`, and both
overwrite `interchangeable` with `NaN`. One shape, with the level-4 view derived by a
function that hides nothing, retires the pair.

## The keystone: evidence, fingerprinted

Today a judgment's only address is *the run it was part of*, and the run cache is written
once, after everything. Four things follow, all of which cost an agent directly:

| Today | With L4 |
|---|---|
| a run that dies at 90% loses everything | a re-run asks only what it never got |
| rewording one question costs a full run — $11.89 | it costs the cells that ask that question |
| re-running identical inputs pays again | it costs nothing and proves it |
| nothing says which code produced `audit.run.json` | the fingerprint *is* the provenance |

That last one is not hypothetical. The run in this directory holds 4,350 arbitration
judgments over 870 requests — 5 per request — while today's `arbitrationQuestions` emits 6.
The file was produced by a different version of the questions than the tree contains, and
nothing in it says so.

This is live. `src/evidence/store.ts` holds it, `JevClient.one` consults it, and every stage
benefits without knowing it exists.

**Shape.** An append-only JSONL store, one record per request:

```json
{ "fp": "b3f1…", "model": "jev-latest", "stage": "audit", "unit": "key:4821",
  "answers": { "meaning:de": 0.94, "adheres:de": 0.31 },
  "usage": { "input_tokens": 1763, "output_tokens": 755 }, "ms": 321, "at": "…" }
```

The fingerprint covers model, state and questions. State is not stored by default — it is
reconstructible from the corpus, and storing it would duplicate the corpus once per stage —
but `--keep-state` stores it for debugging a disagreement.

**The state is canonicalised; the questions are not.** A state's key order carries nothing, so
sorting it means the same data fingerprints the same however it was built. A question's order
*is* meaningful: a Choice presents its options in order, and `probe` asks the same question
twice with them reversed. Sorting the questions would give both asks one address and hand the
second the first one's answer — perfect order robustness, measured from a cache. The rule the
store rests on is that **a miss is free and a false hit is a wrong answer**, so anything whose
order might matter stays in the address.

**What it makes possible.** `resume` becomes the default rather than a feature. `diff`
between two evidence stores answers *did my rewording change any answers, and which*.
A cold run and a warm run become the same code path, which is the property that makes
iteration on questions affordable at all.

## Policy as data

`compose.ts` today writes English into `reasons`, and `decideAction` reads it back:

```ts
if (reasons.some((r) => r.startsWith("meaning not preserved"))) return "needs human";
```

Policy is deciding by parsing prose that policy generated. Under L6:

```ts
type Reason =
  | { rule: "meaning-not-preserved"; lang: Lang; p: number; threshold: number }
  | { rule: "canonical-not-used"; lang: Lang; p: number; terms: TermRef[] }
  | { rule: "register-drift"; lang: Lang; observed: Register; house: Register; share: number }
  | { rule: "lint"; code: LintCode; detail: string };
```

Three things become possible at once. Policy branches on `rule`. An agent filters and groups
findings without a regex. And a finding can **explain itself** — which evidence it read, which
threshold it compared against, and what value would flip it:

```
finding 4821/de  severity 3  needs human
  rule meaning-not-preserved   p=0.11  <  meaningBad 0.35     → severity 3
  rule canonical-not-used      p=0.22  <  adherenceBad 0.40   → severity 2, term "usuń"→"Löschen"
  would become severity 1 at meaningBad <= 0.11
```

`autoFixMaxSeverity` — declared, defaulted, tested, read by nothing — goes away in the same
pass, because a policy field that no rule consults cannot exist once rules are enumerated.

## Coverage

A summary that does not state its own coverage is a claim about a population it did not
measure. Today `audit.ts:92` drops a failed request and the key simply has no judgment;
`compose.ts` then produces only lint findings for it, which is indistinguishable from a key
that passed. `arbitrate` and `substitute` both record their failures. `audit` — 92% of the
bill — does not.

Under L5 every stage returns `{ attempted, answered, failed, skipped }`, every cell knows
whether it was judged, and every projection carries the number. The workbook gains a line;
the envelope gains a field; `report` refuses to imply completeness it does not have.

This holds now. `audit` records its failures, `Finding.judged` says whether the semantic
checks ran, a finding on an unjudged key carries a `not-judged` reason, and the Dashboard
says the counts are a floor rather than a total whenever anything failed.

## What accretes

Five memories, each with one owner and an explicit rule about who may write it.

| Memory | File | Written by | Protected from |
|---|---|---|---|
| **Glossary** | `*.glossary.json` | mining, arbitration, humans | arbitration, once a human has decided (L3) |
| **Decisions** | `*.decisions.json` | humans only | everything |
| **Evidence** | `evidence/*.jsonl` | the client | everything — append-only (L4) |
| **Ledger** | `runs/*.jsonl` | `run`, `score`, `probe` | everything — append-only |
| **Case book** | derived | derived | — |

**The ledger** is how a change becomes attributable. `score` prints precision, recall and a
reliability diagram, and then the numbers evaporate into scrollback. Appending each run's
inputs, code version, policy, counts, cost and measurements makes *"did that help?"* a
question about two rows rather than a re-measurement of the past.

**The case book** is the memory this system is closest to having and currently throws away.
Every verdict a translator enters is a label:

| Verdict | Against | Means |
|---|---|---|
| `reject` | a severity-3 finding | the model called it broken and a human called it fine — a false positive, labelled |
| `edited` | a cell with no finding | the audit called it clean and a human rewrote it — a miss, labelled |
| `accept` | a proposed substitution | the substitution gates were right |

`decisions.json` already holds all of this, keyed by cell, with `was` and `text` and who
decided — and until stage 8 nothing read it back except the review app.

**There is no recall here, and the command says so.** A reviewer only opens rows the audit
already flagged, so the decisions are conditioned on the audit having fired, and the cells a
missed defect lives in are exactly the ones nobody was shown. Precision is measurable; the
`missed` count is a floor on false negatives rather than an estimate of them. A recall number
computed from this would be a confident measurement of the wrong thing. Joining it against the evidence store
produces a real-corpus eval set that grows every time somebody uses the tool — which is the
one form of measurement `score` cannot synthesise, because the synthetic generator's
template translations are not always good prose and the model objects to things nobody
injected.

Accretion is the whole argument for the memory layer: a glossary that is mined, arbitrated
and thrown away is a report.

## Commands

L7 partitions the verbs, and every action has an observation that previews it.

**Observations** — free, write nothing, idempotent:

| Command | Answers | Status |
|---|---|---|
| `status` | what artifacts exist here, how fresh, from what corpus, whether they agree | **today** |
| `plan` | what a run would ask, what is already in evidence, what it would cost | **today** |
| `inspect <cell\|term>` | everything known about one unit, across all layers | **today** |
| `explain <cell>` | the derivation from evidence through rules to severity and action | **today** |
| `report <run>` | findings under a different policy | **today** |
| `diff <a> <b>` | two runs, two policies or two evidence stores | **today** |
| `ledger` | what previous runs and measurements produced | **today** |
| `casebook` | what translators decided, as labelled cases, and the precision that implies | **today** |

**Actions** — declare cost, then spend:

| Command | Spends | Status |
|---|---|---|
| `run` | the bill. Resumable via the evidence store | **today** |
| `score` | ~$0.55 at N=400 | **today**, writes nothing |
| `probe` | ~$0.10 | **today**, writes nothing |
| `apply` | nothing | **today** |
| `review` | ~1 request per edit typed | **today** |

`plan` is the highest-value of these for an agent: it turns an irreversible $12 spend into a
reviewable proposal, which is what lets an agent confirm with a human before committing.

### The envelope

Every command emits one shape. The human rendering is **computed from the envelope**, not
written alongside it — so the two cannot drift, and the machine-readable path is the tested
one rather than the neglected one.

```json
{
  "ok": true,
  "command": "run",
  "inputs":   { "corpus": "mongo://…", "keys": 7040, "langs": ["cs","de","…"],
                "model": "jev-latest", "questions": "q7", "policy": { "meaningBad": 0.35 } },
  "coverage": { "attempted": 6968, "answered": 6968, "failed": 0, "skipped": 72 },
  "counts":   { "findings": 2313, "bySeverity": [0,1802,438,73], "byCategory": { "…": 0 } },
  "cost":     { "requests": 8894, "judgments": 99933, "errors": 0, "usd": 11.89, "wallMs": 192800 },
  "outputs":  { "workbook": "audit.xlsx", "evidence": "evidence/…", "run": "audit.run.json" },
  "warnings": [],
  "next":     ["report audit.run.json --min-severity 2", "review audit.run.json"]
}
```

`next` is the field that makes the system drivable without a human in the loop: each command
states what an operator would sensibly do with its result.

This is live. Two shapes carry what a single `counts` map cannot: `groups` for ordered
breakdowns and `tables` for the reliability diagram, the operating points and the per-stage
cost. `render` prints both generically, so no command owns a private renderer that could
drift from its envelope.

## Unknown

`NaN` meant *not known* in memory, and every persistence boundary converted it by hand —
`cache.ts`, `glossary/store.ts`, and the wire. JSON has no `NaN`, and `Number.isNaN(null)` is
`false`, which cost one real bug. Every new unknown-capable field was another conversion to
remember.

It is `null` at the type level now, and the conversions exist nowhere because there is nothing
to convert: `GlossaryFile` is just `GlossaryRecord[]`. `NaN` survives only where it is a
genuine numeric guard — `calibrate.ts` and `probe.ts` reporting that there was no data to
compute a rate from.

## Where the design stands

| | Holds today | Planned |
|---|---|---|
| L1 asked nothing provable | ✓ | |
| L2 policy outside the model | ✓ | |
| L3 human decisions protected | ✓ | |
| L4 fingerprinted evidence | ✓ | |
| L5 coverage everywhere | ✓ | |
| L6 structured reasons | ✓ | |
| L7 observe / act split | ✓ | |
| one configuration | ✓ | |
| the ledger | ✓ | |
| the case book | ✓ | |
| unknown as `null` | ✓ | |
