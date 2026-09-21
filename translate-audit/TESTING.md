# Testing translate-audit

Seven layers, in order of how much they cost to run.

## 1. Unit tests — free, 0.4 s

```sh
npm test
```

246 tests across seventeen files. They cover the parts where a silent bug would be invisible
in the output:

| File | What it pins down |
|---|---|
| `test/text.test.ts` | the exact facts — placeholder dialects (`{0}`, `{crlf}`, `_MAX_`, `%1$s`), multiset diffs that catch *one of two* `{crlf}` going missing, Polish folding including `ł`, word-boundary term matching (`adres` must not match inside `adresowy`), case-preserving replacement |
| `test/pipeline.test.ts` | mining (only genuinely contested terms reach arbitration; spacing-only variants resolve in code), the no-match outcome existing in the Choice, adaptive question planning, policy composition and its thresholds, the substitution gates, the synthetic generator's reproducibility |
| `test/roundtrip.test.ts` | writes a real `.xlsx`, fills the Decision column the way a reviewer would, reads it back, and checks the re-import CSV |
| `test/calibrate.test.ts` | the calibration maths, against predictors whose honesty is known by construction — a perfectly calibrated one, a confidently wrong one, a hedger. A broken metric reports honesty that is not there, and nothing downstream notices |
| `test/glossary.test.ts` | the memory: what a re-run may and may not overwrite, what a decision is allowed to change, what the audit is allowed to enforce, and that unknown values survive a save/load |
| `test/regressions.test.ts` | that the fast path agrees with the slow one — `TermIndex` matches exactly what a full scan would match — plus the glossary merge, the decision filter, the probe statistics and a cache round-trip through a real temp file |
| `test/profile.test.ts` | the one configuration: defaults under file under environment under flags, that a malformed config file is refused rather than silently ignored, that `run` and `score` build an identical arbitration state, and — by walking the tree — that the domain sentence is written down exactly once |
| `test/rules.test.ts` | every reason rendered byte-for-byte against the prose it replaced, so the reviewer's *Why* column did not move when the mechanism did; and a scan of `src` and `server` for any surviving prose match |
| `test/coverage.test.ts` | that a failed request is a blind spot rather than a clean bill — one request in ten is failed through a stub `fetchImpl`, and coverage, the named unjudged keys and the `not-judged` reason all have to show it. Also the client's retry ladder: a 429 is retried and counted, a 400 is not |
| `test/envelope.test.ts` | that the human text is a projection of the machine-readable result — a fixture envelope rendered line by line, plus the real CLI run as a subprocess to check that `--json` puts one parseable object on stdout while every word of narration goes to stderr |
| `test/evidence.test.ts` | the four properties the judgment store exists for: an identical re-run makes zero requests, a killed run asks exactly what it was missing, a changed question re-asks only the keys that ask it, and with no store nothing is remembered. Plus the fingerprint itself — stable across state key order, and moving with the model, a rewording, a reordered option list or a reordered array |
| `test/observe.test.ts` | that looking is free and accurate: `plan`'s predicted request count equals what a stubbed run then makes and drops to zero once the store holds the answers; `explain` names the evidence, threshold and flip point per rule; `inspect` resolves a key three ways; `status` survives an unreadable file; `diff` is empty between a run and itself |
| `test/ledger.test.ts` | that a measurement survives the session that made it — the entry is derived from the envelope, appending never rewrites, and a diff states the delta while naming only what actually changed |
| `test/review.test.ts` | the review app, which is otherwise 1,991 lines with no test between them: the glossary governing the queue rather than decorating it (suspend a term and the adherence findings go; restore it and they come back, canonical intact), a decision surviving a restart with the name against it, decided rows sorting last, and `/api/rows` carrying `rules` beside the rendered `reasons`. Four of these fail if `isEnforceable` stops reading the status — which is exactly how stage 9a broke |
| `test/warm.test.ts` | that the warm loop survives a process boundary: the real CLI, twice, as child processes against a counting stub endpoint. The second run must send nothing, spend nothing, reuse exactly what the first bought and compose the same findings. Also that `plan`'s estimate is exact — it predicts the request count the run then makes, and zero once the store holds them |
| `test/casebook.test.ts` | what each verdict means as a label, including the ones that mean nothing: a `defer`, an edit that changed no text, and a decision about a key the run does not contain all produce none. Stats return `null` rather than `0` when nothing has been reviewed |

The round-trip test exists because **the workbook is a form, not a report**. `apply` reads
back what a reviewer typed, by column position. A shifted column would silently send the
wrong text to the TMS, and nothing else in the suite would notice.

The rules test earns its keep the same way. Reasons are data now, and the English is rendered
from them — so the guard is that the rendering did not drift. It also caught a live bug when
it was written: `render.ts` decided a substitution had passed with
`hit.note.includes("verified")`, and the failure note reads *"…but could not be verified"*.

The glossary tests exist because that file is the only place a translator's work lives.
Two of them earn their keep on their own: *"arbitration never overwrites a human"*, which
is the whole contract of the memory; and the persistence round-trip, which caught a real
bug — `NaN` means "not known" in memory but JSON has no `NaN`, so an unknown severity came
back as `null`, and `Number.isNaN(null)` is `false`. The conversion now happens explicitly
at the load/save boundary.

Tests that assert on the model's answers are deliberately absent. Jev's judgments are
measured in layer 3, not asserted in unit tests — an assertion that `p(meaning) < 0.35`
for one German string is a flake waiting to happen.

The client is tested through its `fetchImpl` seam rather than against production, which is
what makes failure testable at all: a stub that returns canned answers *and canned failures*
costs nothing and is the only way to check what the pipeline does when a request does not
come back.

## 1a. Looking — free, instant, no API key

```sh
npm run audit -- status                          # what is here, and whether it agrees
npm run audit -- plan --mongo <your-db>          # what a run would ask, and what it would cost
npm run audit -- inspect audit.run.json <key>    # everything known about one key
npm run audit -- explain audit.run.json <key> de # why that row was raised
npm run audit -- diff a.run.json b.run.json      # what changed
```

None of these writes anything or spends anything, so they are always safe. `plan` is the one
to reach for before an unfamiliar corpus: it prices only the requests the evidence store does
not already hold, and it says whether its token estimates are measurements from that store or
assumptions.

## 2. Dry run — free, ~2 s, no API key

Everything before the first request: loading, exact checks, mining.

```sh
npm run audit -- run --mongo <your-db> --dry-run
```

```
  automated checks  12779 exact defects
        4022  empty-translation
        2249  case-inconsistent
        2213  duplicate-source-divergent
        ...
  mined             3326 terms → 870 contested (term, language) pairs
                    468 resolved in code (spacing or case only — no request spent)
                    21914 already consistent everywhere

    [de] usun: "Löschen"×9 vs "Entfernen"×2
    [en] wyslij: "Send"×6 vs "Submit"×5
    [cs] kod pocztowy: "PSČ"×6 vs "Poštovní směrovací číslo"×4
```

This is the fastest way to tell whether a new corpus is wired up correctly. If the
contested terms look like identifiers (`part_b2100`, `WidthX`) rather than words, the
source column is wrong — check which field actually holds the source text.

## 3. Scored run — ~$0.55, ~15 s

```sh
npm run audit -- score --synthetic 400 --langs de,uk,fr,hu --defect-rate 0.12
```

Generates a corpus, injects defects of five known kinds at a controlled rate, records
exactly what it broke, runs the real pipeline over it and counts.

```
  injected defects : 157
  caught           : 157  (recall 100.0%)
  flagged total    : 233
  not injected     : 76   (precision 67.4%)

  what the not-injected flags were:
         47  case-inconsistent
         34  meaning uncertain
      severity 3 0 · 2 0 · 1 76 · 0 0

  at severity >= 2 only: 73 findings, 73 injected (precision 100.0%, recall 46.5%)
```

Read it this way:

- **Recall at any severity is the safety number.** 100% means nothing injected escaped.
- **Precision at severity ≥ 2 is the trust number.** 100% means the must-fix queue wastes
  none of a reviewer's time.
- **Recall at severity ≥ 2 is intentionally ~46%.** The missing half are casing and
  formality flips, which are real but cosmetic and sit at severity 1 by design.
- The breakdown of not-injected flags is what to act on. When it filled up with
  *"same source translated differently elsewhere"* and *"register drift"*, those were
  pipeline bugs, not model errors — see the two fixes in the README.

The generator is seeded (`--seed`), so a scored run is reproducible: the same seed injects
the same defects in the same places. Change a question or a threshold, re-run with the same
seed, and the difference in the numbers is attributable.

## 4. Probes — ~$0.10, ~5 s

```sh
npm run audit -- probe --order 40 --scope 40
```

Two properties that return a perfectly well-typed answer when they break:

```
  option order — the same question twice, options reversed
      same answer both ways   40/40  (100.0%)
      probability drift       median 0.010 · p95 0.070

  out of scope — every option is a rendering of some *other* term
      took the no-match option        32/40  (80.0%)
      a separate yes/no noticed it    38/40  (95.0%)
      picked a loser at >=0.80        0
```

Run this **whenever you change an arbitration question, and always after pointing
`TYPESAFE_BASE_URL` somewhere new.** Order robustness and out-of-scope calibration are
reportedly what reimplementations of this API contract lose first, and neither shows up
as an error — the answer still validates and still carries a confidence.

The scope probe has to be built carefully. An earlier version simply removed the
best rendering and offered the runner-up, and reported a dismal 5% — but the runner-up
was usually still about the right concept, so picking it was defensible. Offering
renderings of *unrelated* terms is the real out-of-scope case, and the number went to
80%. If you weaken this probe, you will measure the probe rather than the model.

## 5. The review app

```sh
npm run build:web
npm run review -- audit.run.json        # http://localhost:8788
```

**Of the five checks below, only the browser and the model still need a human.**
`test/review.test.ts` and `test/consistency.test.ts` run against a `Session` over a temp
directory with a `null` client, in under a second and with no key: checks 1, 2 and 4 in full,
the half of 3 that fails silently, and the answer half of 5. What is left for a person is that
the page renders, and that a live `meaning` moves when the meaning does.

1. **A decision survives a restart.** *Automated* — a decision is re-read by a second
   `Session` over the same paths, with its text, its author and what it replaced.
   `audit.decisions.json` is written through on every change, not on exit, so nothing has to
   be closed for the check to hold.
2. **A glossary decision moves the queue.** *Automated*, twice: in-process through
   `patchTerm`, and over the wire through `POST /api/glossary/<key>` against a real server on
   an ephemeral port. Mark a term *depends on context* and the adherence findings for its keys
   disappear; restore it and they come back — with the canonical intact, which is what makes
   it an undo rather than a re-arbitration. By hand it is still one command:

   ```sh
   curl -s 'localhost:8788/api/rows?limit=20000' \
     | jq '[.rows[] | select(.rules | index("canonical-not-used"))] | length'
   ```

   Rows carry `rules` alongside the rendered `reasons` precisely so this check matches on a
   rule id rather than on a sentence that may be reworded — itself pinned, by asserting the
   id appears in `rules` and nowhere in the prose.

   This is the test that failed the first time. Findings were being keyed off the saved
   judgment rather than the current glossary, so the glossary decorated the queue instead
   of governing it. It failed a second time in stage 9a. Both failures now break four tests
   in this file the moment `isEnforceable` stops reading the status.
3. **The live check discriminates.** *Half automated.* Whether `meaning` falls when you drop
   a negation is a property of the model and needs the endpoint: type a correct translation,
   then break it. What is automated is the half that fails silently — that the source, the
   proposed text and the enforceable glossary reach the request at all, checked against a stub
   `fetchImpl` that records what it was sent, and that a suspended term reaches it as an empty
   glossary. If every edit returns ~0.9 *and* the state is present, the model is the suspect.
4. **The decided rows sort last** and `unreviewed only` empties as you work. *Automated* —
   deciding the severity-3 row moves it behind the severity-2 one, and `undecidedOnly` counts
   down to zero while the queue itself stays the same length.
5. **The check panel shows a rule before a string is saved.** Open *Check a string*, type a
   source string containing a settled term and a translation that uses a different rendering.
   The violation appears as you type, with the replacement — and the network tab shows no
   request left for it, because the panel sends `semantic: false` until you press *Check the
   meaning*. *Automated* for the answer (`consistency.test.ts` pins that the free half asks
   nothing and that the paid half asks once); the browser is what the human is checking.

Running without `TYPESAFE_API_KEY` is a valid mode: the app loads, the queue works, the
title bar says *No API key — live checks off*, and the editor says so too.

## 5a. The evidence store — free, and the reason iteration is affordable

```sh
npm run audit -- run --synthetic 200 --langs de,uk          # cold
npm run audit -- run --synthetic 200 --langs de,uk          # warm: 0 requests, $0.00
```

The second run reports every request as `reused` and spends nothing. That is the check that
the store is actually wired in — if the warm run costs money, the fingerprint is picking up
something that should not be in it (a timestamp, a set iterated in a different order).

`test/warm.test.ts` runs exactly this, **as two child processes against a stub endpoint that
counts connections**, because the property is about a run started from a shell tomorrow and
not about one function calling another. A fingerprint that is stable within a process and not
across one would pass every test in `evidence.test.ts` and still restore the whole bill. The
warm run has to report `requests 0`, `usd 0` and `reused` equal to the cold run's request
count, produce identical counts, and leave the stub with no new connections.

After changing a question, the warm run should re-ask **only** the units asking it. If it
re-asks everything, the question set changed more than you meant; if it re-asks nothing, the
fingerprint is not covering the questions and the saved answers are now stale.

## 6. The memory loop

The only way to check that decisions are actually reused is two runs with a decision
between them:

```sh
npm run audit -- run --mongo <your-db> --projects <a-small-project> --glossary g.json
# decide the terms in the app, or edit g.json by hand
npm run audit -- run --mongo <your-db> --projects <a-small-project> --glossary g.json
```

The second run must print `N decisions reused (no request spent)` and arbitrate only what
is new. If it re-arbitrates a decided term, `isDecided` or the merge is wrong, and the
model is about to overrule a translator.

## 7. Real corpus

```sh
npm run audit -- run --mongo <your-db> --projects <a-small-project>    # 161 keys, ~6 s, ~$0.16
npm run audit -- run --mongo <your-db>                            # 7040 keys, ~3 min, ~$12
```

Start with one small project. A full run always writes `audit.run.json` alongside the
workbook, so every subsequent question about the report is free:

```sh
npm run audit -- report audit.run.json --min-severity 2 --only integrity,meaning,consistency
npm run audit -- report audit.run.json --meaning-bad 0.2
#   → audit.xlsx   (0 requests, $0.00)
```

If you are changing `compose.ts`, `report/xlsx.ts` or any threshold, you should never need
to spend a request. Re-running `run` to see a report change means the cache is not being
used.

## What failure looks like

| Symptom | Cause |
|---|---|
| Contested terms are `part_b2100`, `WidthX` | the source column is an identifier; check per-project source resolution in `sources/mongo.ts` |
| Everything is flagged `untranslated-copy` | source and target columns are the same column |
| `?` in place of `ł ą ś ż` in the output | the export was already lossy — the loader reports the count; re-export as UTF-8 |
| Thousands of `register drift` findings | the house register is not dominant enough to judge against; `registerMinDominance` guards this |
| `auto-fix` rows with an empty Suggested cell | a bug — `run` downgrades these to `needs human`; if you see one, the downgrade pass was skipped |
| `probe` shows order disagreement | the endpoint is not order-robust; a Choice there reports position, not preference. Do not trust the glossary it produces |
| `probe` scope rate collapses | either the endpoint lacks the no-match behaviour, or the probe was weakened to offer plausible options |
| Non-zero `errors` in the Run sheet | rate limiting or timeouts; lower `--concurrency`. A failed request never aborts the run — it leaves that key unjudged, and an unjudged key produces only lint findings, which looks exactly like a key that passed. Check coverage before quoting any summary: `jq -r '(.stages[]\|select(.name=="audit")) as $a \| "\($a.requests - (.judgments\|length)) blind"' audit.run.json` |

## Cost control

`--limit N` caps keys. `--max-terms N` caps arbitration. `--only-flagged` audits only keys
that already have an exact defect or a glossary term — roughly half the requests, but it
cannot find a meaning error in a string that looks clean, which is where the best finds in
the real corpus came from. `--no-fix` skips the substitution stage.

The Run sheet always states the token prices it used (`JEV_PRICE_IN` / `JEV_PRICE_OUT`), so
a stale default is visible rather than quietly wrong.

## 8. The ledger and the case book — free

Every layer above measures something and then, until recently, threw it away.

```sh
npm run audit -- ledger                      # what previous runs measured
npm run audit -- ledger --diff <idA> <idB>   # what a change did to the numbers
npm run audit -- casebook audit.run.json     # precision on the real corpus
```

`score` and `probe` append a row each time they run, so the honest way to judge a change is
now: run `score` with the seed you used before, then diff the two rows. The diff names only
what actually differed in the configuration — a measurement that moved beside a configuration
that did not is noise.

The case book is the only measurement the generator cannot produce. Every verdict a translator
entered is a label: a reject on a finding is a false positive, an edit on a row nothing
flagged is a miss. **It reports no recall, deliberately** — a reviewer only sees rows the
audit flagged, so the cells a missed defect lives in are exactly the ones nobody was shown.

## A note on layer 3's numbers

They were produced under a domain string no real run used, because `score` had its own copy.
That is fixed, and everything measured from here describes the shipped pipeline — but the
precision and recall figures quoted in `README.md` predate the fix. Re-measure with the same
seed and diff the ledger rows before trusting them against a change.

See [AGENTS.md](AGENTS.md) for what is free to run and how to read a finished run without
spending anything, and [DESIGN.md](DESIGN.md) for why coverage is a first-class output.
