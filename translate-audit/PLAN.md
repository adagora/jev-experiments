# PLAN.md — the staged path

`DESIGN.md` is the system as it should be. `AGENTS.md` is how to drive what exists. This is
the difference between them, in stages that ship independently.

Each stage states an **acceptance check** that can be run rather than argued about. A stage
is done when its check passes, not when its code is written.

## What has landed

All seven laws hold, and the measurements behind them are in `README.md`. The keystone —
evidence addressed by `(model, state, questions)` — is live in `src/evidence/store.ts`, with
`resume`, re-ask-only-what-changed, and survival of a truncated final line under test.

Four bugs surfaced on the way, and each one is now a test rather than a memory:

| Bug | What it cost | Pinned by |
|---|---|---|
| `hit.note.includes("verified")` matched *"could not be verified"* | re-rendering a report marked unverifiable substitutions `auto-fix` | `rules.test.ts` — and L6, which removed the category |
| `Number.isNaN(null)` is `false` | unknown read back as a number across the wire | `regressions.test.ts` |
| findings keyed off the saved judgment, not the current glossary | the glossary decorated the queue instead of governing it | `TESTING.md` §5.2, by hand |
| a decision's canonical was destroyed, not suspended | a translator's undo silently cost a re-arbitration | `glossary.test.ts` |

### Stage 9 — the edges (done)

The reality check that opened this stage found four things that returned well-formed answers
while being wrong. Three were real; one was already fixed and only the documentation
remembered it.

**9a — a suspended term keeps its canonical.** `decide()` cleared `canonical` for
`context-dependent` and `rejected`, so putting a status back left the term unenforceable
forever and the findings never returned. The clearing was redundant: enforcement was already
gated on status. It is now gated in exactly one place — `isEnforceable` — which
`enforceable()` and the review server's `glossaryFor` both ask. They previously disagreed:
`glossaryFor` filtered on the canonical being present and checked no status at all, so it
was correct only by accident, and only for as long as the canonical was being destroyed.

*Acceptance:* mark a term *depends on context* in the app, restore it, and its adherence
findings come back. `glossary.test.ts` pins the round trip; `consistency.test.ts` pins that a
suspended term enforces nothing in the editor either.

**9b — one substitution proposal per finding.** Several glossary terms can apply to one
string, and every proposal held a reference to the same `Finding`. Whichever request returned
last overwrote `suggested`, `substitutionOk` and `action`, while `reasons` accumulated all of
them and could carry a verified *and* a rejected verdict for the same row. On the production
corpus, 1,040 requests stored 1,019 suggestions — 21 paid for and dropped.

Composing the fixes instead would ship text nobody judged: each verification asks whether one
exact string is grammatical and still means the source, and a second edit on top destroys the
string that was judged. So the candidates are given a total order — worst damage first, then
the most specific term, then the name — and a finding takes one. Nothing is hidden by
choosing: the finding's `canonical-not-used` reason already names every term that applies.

*Acceptance:* `pipeline.test.ts` — one proposal per finding, the same one whatever order the
glossary arrives in, and `before`/`after` that differ by exactly one substitution.

**9c — `report` emits a structured cost.** It hardcoded `cost: "$0.00"` into `counts`, so
`jq .cost.usd` returned `null` for the one command whose whole point is that it is free, and
the number was a formatted string an agent would have to parse back. It now reports through
`costOf`, like every other command.

*Acceptance:* `translate-audit report <run> --json | jq .cost.usd` → `0`.

**9d — the documentation was wrong about itself.** `autoFixMaxSeverity` was documented as
dead code; it had already been removed. `interchangeable` was documented as read by nothing;
it reaches the workbook's Glossary sheet. `README.md` quoted a run that is not the one in this
directory (8,894 requests against 8,878; 1,056 substitutions against 1,040). `DESIGN.md`
described `GlossaryFile` as a bare array and the evidence store as `evidence/*.jsonl`.

*Acceptance:* every number in `README.md`'s production block is reproducible by `jq` over
`audit.run.json`.

### Stage 10 — consistency before the fact (done)

Everything up to here finds drift that already happened. `checkEdit` could only answer about
a key the corpus already contained, which made it a reviewer's tool: it needed a row an audit
had flagged. `POST /api/consistency` answers for any source string in any language, including
a key nobody has translated yet.

The glossary half is free and keyless, because whether a string uses the rendering the
glossary settled on is a fact about the text (L1). Only the semantic half costs a request,
and it is absent rather than faked when there is no client.

*Acceptance:* `consistency.test.ts`, which runs with no client at all. Verified live against
the production glossary: a workflow status inverted from *rejected* to *approved* in a key the
corpus has never contained came back `meaning 0.01`, with the exact case-preserving
replacement, in 727 ms.

## What remains

### Stage 11 — prove the warm loop on the real corpus (mechanism proven; the paid run remains)

**The gap this closes is the only unproven claim in the README.** *"The second run of anything
is nearly free"* is the economics the entire maintenance story rests on, and it is measured
only against synthetic corpora. Every artifact in this directory predates the evidence store:
`audit.run.json` is cache version 1 and carries no provenance, and no `audit.evidence.jsonl`
has ever been written here.

Two things were done first, because without them the acceptance could not be read:

**11a — a reused judgment is not a request.** `cost.requests` summed `StageStats.requests`,
which counts units *attempted*. A warm run therefore reported 6,968 requests and $0.00 — and
this stage's acceptance, *"reports `requests 0`"*, would have read as a failure on success.
Every other field in `Cost` already described attempts only: `errors`, `retries` and the
latency percentiles all exclude reused units. `requests` is now what was sent and `reused` is
its own field. The per-stage table is unchanged, and still carries both. The review app's
*"The run these judgments came from"* card summed the same field and is fixed with it — level
6 has two projections of a run, and both were saying the same wrong thing.

**11b — the process boundary, tested.** `evidence.test.ts` proves the store works inside one
process, which is not the claim. `test/warm.test.ts` runs the real CLI **twice as child
processes** against a stub endpoint that counts connections, and requires the second run to
send nothing, spend nothing, reuse exactly what the first bought, and compose identical
counts. Measured on a 60-key synthetic corpus: 61 requests and $0.0066 cold, then
`0 requests · 61 reused · $0.00` warm, with no new connection reaching the stub. A fingerprint
that is stable within a process and not across one now fails a test rather than a $11.89 bill.

What remains is the paid run itself — the real corpus, the real endpoint — which needs
`TYPESAFE_API_KEY` and `MONGO_URI`:

```sh
translate-audit plan --mongo <db> --source pl     # free: what it will cost
translate-audit run  --mongo <db> --source pl     # ~$11.89, fills the evidence store
translate-audit run  --mongo <db> --source pl     # should be ~$0.00
```

*Acceptance:* the second run reports `requests 0` and `usd 0`, and `reused` equals the first
run's request count. If it does not, the fingerprint is unstable across processes and
`--keep-state` on both runs will say which field moved. `plan` before each is free, and its
estimate is exact — `warm.test.ts` pins that too.

*Do not merge a state change into any stage's request without re-running this*, because a
field that varies per process — a timestamp, a set iteration order — makes every judgment a
miss and quietly restores the $11.89.

### Stage 12 — retire `sourceAmbiguous` (held, deliberately)

Asked of every arbitration, extracted by nothing. ~870 judgments per cold run, ~$0.045.
Re-checked today: one call site, `src/jev/questions.ts:114`, and no reader anywhere in `src`,
`server` or `web`. The edit is four lines; the verification is not, and it is the verification
that sequences this stage.

The cost is trivial and the category is not: it is a question whose answer no code reads.
Removing it changes `arbitrationQuestions`, hence the fingerprint, hence **every cached
arbitration judgment**. So it is not a silent edit.

*Acceptance:* `npm test`, then `probe --order 40 --scope 40` (order robustness and
out-of-scope behaviour both fail silently), then `score --synthetic 400 --seed 20250920` —
the same seed as the last measurement — and `ledger --diff <before> <after>` showing precision
and recall unmoved. Sequence it **after** stage 11, so the cache it invalidates is one whose
value has already been demonstrated. Held until stage 11's paid run has happened: deleting the
question is free, and doing it before there is a real cache to invalidate would throw away the
only thing that could have proved the invalidation matters.

### Stage 13 — the review app, under test (done)

1,991 lines across `server/` and `web/src/` had one test file between them
(`consistency.test.ts`, added in stage 10). `TESTING.md` §5 made this deliberate and listed
what to check by hand — but the glossary-governs-the-queue property is listed there as *"the
test that failed the first time"*, and stage 9a was a live regression against that same
section. The hand-check found it; it found it months late.

`test/review.test.ts` — 15 tests, 80 ms, no key — pins what was listed:

- a glossary decision re-composes the queue, and putting it back restores it, canonical
  intact (in-process, and over the wire against a server on an ephemeral port)
- a row decision survives a restart, with the right name and the text it replaced
- decided rows sort last; `unreviewed only` counts down while the queue stays the same length
- `/api/rows` carries `rules` beside `reasons`, and the id appears in neither the other's half

The stage-9a regression is the measure of it: reverting `isEnforceable` to ignore status
fails four of these tests instead of waiting for a translator to notice.

*Acceptance:* met. §5 now marks 1, 2 and 4 automated and 3 half-automated — the state
reaching the request is checked against a recording stub; whether a live `meaning` falls when
the meaning does still needs the endpoint.

### Stage 14 — one glossary shape (done)

`GlossaryRecord` is now `GlossaryEntry & { what a human settled }`, so the level-4 view is a
pick of eleven fields — it can drop things and the type checker will not let it invent any.
`enforceable` is that pick over the records `isEnforceable` admits; `asGlossaryEntries` is the
same pick over all of them.

Two fields were being lost on every pass, and both were real:

- **`interchangeable`** — asked of every arbitration, stored nowhere. `applyArbitration`
  wrote five of the six answers onto the record and dropped this one, and the two conversions
  then hardcoded `null`. The production run's own cache has it on all 1,338 terms; any run of
  this build would have written an empty column in its place. It is stored and projected now.
- **`origin`** — rebuilt from `source` at each conversion, which made *every* human-typed term
  report as `duplicate-source` in the workbook's "Found by" column. Mining, arbitration and
  `manualTerm` each record it, and `human` is now a value it can take.

A `do-not-translate` decision writes `doNotTranslate: 1` onto the record in `decide`, rather
than being re-derived from the status at each conversion — which is what kept the view a pick.
The file is version 2; a version 1 file is migrated on load, in the one place that is allowed
to say what it cannot know.

*Acceptance:* met. `npm test` (241), and `report audit.run.json` produces counts, coverage and
groups byte-identical to the run before the change.

### Stage 15 — the editor, not just the queue (done)

Stage 10 built the endpoint and nothing called it. The shape was a product question — a
Lokalise plugin, a pre-commit hook over the export, or a panel in the review app — and it was
answered: **a panel in the review app**. It ships with the tool, needs no external account,
and reaches a translator in the place they already have open.

*Check a string* takes a source string, a language and a draft. The glossary rules that apply
appear as it is typed, with the exact case-preserving replacement to take when one is broken,
and clicking the replacement puts it in the draft.

Keeping it free needed one change to the endpoint. `checkText` asked the model whenever there
was a client and a draft — which would have been a request per keystroke. It now takes
`semantic: false`, which asks for the half that is a fact and nothing else; the default is
unchanged, so the documented contract of `POST /api/consistency` still holds for anything
already calling it. The meaning check is a button, labelled with what it costs.

*Acceptance:* met. A translator writing a new string sees the glossary rule before they save
— verified against the 1,338-term glossary in this directory, on a source string the corpus
has never contained, in 6 ms — and it costs nothing when they are right:
`consistency.test.ts` pins that the typing path makes no request even with a client attached,
and that the meaning check makes exactly one. What a human still checks is the browser, which
`TESTING.md` §5.5 now says.

## Sequencing

```
11 warm loop  ──→  12 sourceAmbiguous     (12 invalidates the cache 11 proves)
   ├─ 11a cost accounting        done
   ├─ 11b cross-process test     done
   └─ 11c the paid run           needs TYPESAFE_API_KEY + MONGO_URI
13 review app tests    done
14 one glossary shape  done
15 editor integration  done — a panel in the review app
```

What is left is 11c and, behind it, 12. Both need a key; 11c also needs the database and
~$11.89. Everything that could be established without spending has been: the mechanism 11
exists to prove is now pinned across a process boundary by `test/warm.test.ts`, so what the
paid run adds is the real corpus and the real endpoint — the two things a stub cannot stand
in for.
