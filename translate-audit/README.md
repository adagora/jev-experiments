# translate-audit — consistency for translations that never had a glossary

You have ten thousand keys in a TMS, a translation for each one in eight languages,
and no glossary. Nobody ever decided whether *usuń* is **Löschen** or **Entfernen** —
so it is both, in different screens, and has been for years. There is no list of the
terms that disagree, because making that list is the job.

This tool makes it. Code mines the disagreements out of the corpus, [Jev](https://docs.typesafe.ai)
decides which side of each one is right, and a spreadsheet lands on a reviewer's desk
with a dropdown next to every decision.

```
7040 keys · source Polish · targets cs, de, en, fr, hu, it, ru, uk

  automated checks  12779 exact defects        ← no model, no cost
  mined             3326 terms → 870 contested ← no model, no cost
  arbitrate         870 requests               18 s
  audit             6968 requests              150 s
  substitute        1056 requests              21 s

  8894 requests · 99933 judgments · 0 errors
  p50 321 ms · p95 453 ms · 192.8 s wall · $11.89
  one LLM call per judgment at 3 s ≈ 83.3 h
```

**Ninety-nine thousand judgments in three minutes.** The same work, one prompt-and-parse
call per judgment, is three and a half days.

## What it is actually for

Translation QA tools check strings one at a time. Consistency is not a property of a
string — it is a property of the *set*, and no per-string check can see it. `Entfernen`
is a perfectly good German word. It is only wrong because nine other keys say `Löschen`.

So the corpus is read as a whole first, in ordinary code:

1. **Group keys by source text.** Wherever the same Polish string was translated twice,
   translators made a decision. Where those decisions disagree, you have a conflict.
   7,040 keys collapse to 870 contested (term, language) pairs — a glossary-shaped
   question list, extracted by counting, with no model involved.
2. **Ask Jev to arbitrate each one.** The options are the renderings translators actually
   produced, plus an explicit *"no single rendering fits"* outcome. The model never writes
   a translation; it picks one that already exists, or declines. That is the glossary.
3. **Audit every key against it**, all eight languages in one request.
4. **Propose the fix mechanically** — a case-preserving find-and-replace — and ask Jev
   only whether the *result* is grammatical, still means the source, and is an improvement.

## The rule that shapes everything

**Jev is never asked anything code can prove.**

A missing `{0}` is a fact. So is an unbalanced `<b>`, a trailing space, a casing change,
and two strings being byte-identical. `lint.ts` establishes all of it for free and passes
the results into the request as *state*, so the model can weigh a defect in context
instead of re-deriving it. That is why 12,779 exact defects cost nothing, and why a run
over 7,040 keys is three minutes rather than an afternoon.

The corollary: **Jev is never asked to apply policy either.** It returns raw probabilities
per dimension — *does this preserve the meaning*, *does this follow the glossary*, *how is
the reader addressed*. Whether 0.35 counts as a defect is a decision the business owns, so
it lives in `compose.ts`. Change a threshold and the report re-renders from saved judgments
in under a second:

```sh
translate-audit report audit.run.json --meaning-bad 0.2 --min-severity 2 --only consistency
#   262 findings composed, 37 kept        → audit.xlsx   (0 requests, $0.00)
```

## Measured, not asserted

`score` runs the whole pipeline over a corpus whose defects were injected deliberately,
so recall and precision are counted rather than claimed:

```
  injected defects : 157
  caught           : 157  (recall 100.0%)
  flagged total    : 233
  not injected     : 76   (precision 67.4%)

  at severity >= 2 only: 73 findings, 73 injected (precision 100.0%, recall 46.5%)

  by defect type:
      case-flip                57/57   100%
      term-inconsistency       49/49   100%
      register-flip            25/25   100%
      placeholder-dropped      18/18   100%
      negation-dropped          8/8    100%
```

Every injected defect is caught. The must-fix queue — severity 2 and above — contains
**only** real defects; the half of the injections that do not reach it are the cosmetic
ones (casing, formality), which sit at severity 1 on purpose. The 76 extra flags are
casing differences and the 0.35–0.7 "meaning uncertain" band, all at severity 1.

Reaching 67% precision took two fixes worth stating, because both were the pipeline being
wrong rather than the model:

- **Flag the minority, not the group.** When nine keys say `Löschen` and one says
  `Entfernen`, flagging all ten buries the decision under its own context. Only renderings
  that are not the group's majority are raised.
- **Formality has three answers, not two.** Most UI strings address nobody — `Zapisz`,
  `Auftrag speichern`. A yes/no "is this formal?" forces those into *informal* and drowns
  the real drift. It is a Choice with a *"does not address a reader"* outcome, and those
  strings are excluded from the norm entirely.

Together those took precision from 13.4% to 67.4% with recall unchanged at 100%.

## What a question actually costs

Fan-out is the whole economic argument, so it is worth measuring rather than
repeating. Same state, N questions, one request:

| questions | 1 request | 24 separate requests |
|---|---|---|
| input tokens | 1,763 | 17,265 — the state re-sent 24 times |
| output tokens | 755 | 839 |
| cost per 1k | **$2.22** | $8.58 |
| latency | 313 ms | 468 ms (fully parallel) |

Marginal cost of one more question: **+31 input / +19 output** for a `noul`,
**+55 / +55** for a `choice` or `score`, which return a whole distribution. So the
input side behaves as advertised — you pay for the question text and the state is
sent once — but output tokens are real, and were **47% of the cost** of the full
7,040-key run.

That is why severity is computed in `compose.ts` rather than asked as a per-language
`score`. It was done for separation of policy, but it also avoided ~56,000 Score
questions: roughly **$8**, which would have nearly doubled the audit.

## Is it honest about how sure it is?

`score` also prints a reliability diagram against the injected defects — declared
probability on one axis, observed frequency on the other, diagonal is honesty:

```
    declared    n     observed   gap    claimed vs actual
    0.7–0.8      45   0.822   +0.064   ·····················│·●·····
    0.8–0.9     350   0.980   +0.121   ························│··●·
    0.9–1.0    1017   1.000   +0.063   ··························│·●
    expected calibration error 0.093 · Brier 0.036 · base rate 0.957
```

At the confident end it is *under*-confident, which is the safe direction: it says
0.9 and is right every time. That turns a threshold into a policy instead of a guess:

```
    threshold   unreviewed   of traffic   correct   wrong   to a human
    0.80          1367       91.1%      99.5%       7      133
    0.90          1017       67.8%     100.0%       0      483
```

Two thirds of strings could skip review entirely with no errors in this run. The low
bins are noisy and partly the generator's fault — its template translations are not
always good prose, so the model objects to things nobody injected.

## The two properties that fail silently

`probe` tests the things that still return a perfectly well-typed answer when they
break, so nothing downstream notices:

```
  option order — the same question twice, options reversed
      same answer both ways   40/40  (100.0%)
      probability drift       median 0.010 · p95 0.070

  out of scope — every option is a rendering of some *other* term
      took the no-match option        32/40  (80.0%)
      a separate yes/no noticed it    38/40  (95.0%)
      picked a loser at >=0.80        0
```

Order robustness holds. The second result changed the code. **A Choice is relative —
it always has to point at something — so confidence means "this option beat the
others", not "this option is good."** The explicit no-match outcome catches 80% of
cases where nothing on the list is right; a separate presence question catches 95%.
Arbitration now asks both, and the glossary sheet flags a term in red when Jev thinks
none of the observed renderings is correct — which is precisely the case a translator
must handle by typing a word the corpus has never contained.

## Any compatible endpoint

`TYPESAFE_BASE_URL` and `JEV_MODEL` are the only things tying this to a vendor. The
whole pipeline runs against anything that implements `POST /v1/systemone` with
`choice` / `score` / `noul`:

```sh
TYPESAFE_BASE_URL=http://localhost:9099/v1/systemone JEV_MODEL=my-model \
  npm run audit -- run --synthetic 120 --langs de,uk
#   125 requests · 583 judgments · 0 errors
```

Verified against a stub implementing only the contract. If you point it at a
reimplementation, run `probe` first: order robustness and out-of-scope behaviour are
reportedly the parts that do not survive reimplementation, and both fail silently.

## What it finds

The counts throughout this file are from a real production run. The strings below are
paraphrased, because the corpus is not ours to publish — but each shape stands for a
class of defect the pipeline actually raised, with its real probability.

| shape of defect | why it matters |
|---|---|
| one noun inside a compound label silently swapped for another | p=0.04 · the screen now names a different feature |
| a permission level renamed to a weaker-sounding one | p=0.07 · a reader misjudges what the setting grants |
| a negation dropped from a failure message | the message now asserts the opposite of the source |
| a workflow status inverted from *rejected* to *approved* | the most expensive single class of bug in the corpus |
| a verb rendered as an unrelated homonym in one of two places | "cancelled" arriving as "cloning" |

and terminology that had simply drifted: a four-letter verb rendered two ways across 11
keys, a postal-code label appearing in both full and abbreviated form across 10, a delete
action split 9-to-2 between two perfectly good words.

The substitution gate earns its cost on the refusals. It **applied** the 9-to-2 delete
alignment and a long-form-to-abbreviation collapse. It **refused** a term-for-its-definition
swap (a tax abbreviation replaced by the phrase explaining it), a swap between two words
naming different *people* in a workflow, and a singular-to-plural change. Mechanical
replacement is trivially correct to perform and not at all trivial to approve.

## The review app

`audit.xlsx` suits someone signing off on a batch. It does not suit the person who has
to work through four hundred rows, because a spreadsheet cannot tell them that the
sentence they just typed dropped a negation.

```sh
npm run build:web
npm run review -- audit.run.json          # http://localhost:8788
```

**Review** is a queue, built for hands that stay on the keyboard: `j`/`k` to move,
`A` accept, `R` keep as is, `D` later, `U` undo, `Enter` to edit. Each row shows the
source, the current translation, the suggestion, why it was raised, and — when the same
Polish string is translated differently elsewhere — the other renderings as one-click
chips.

The reason to review here rather than in Excel is the line under the editor. Type your
own wording and ~300 ms later Jev says whether it still means the source, whether it is
good German, and whether it follows the glossary:

```
  the current text     meaning 0.89  grammar 0.70  glossary 0.94  665 ms
  a negation flipped   meaning 0.45  grammar 0.16  glossary 0.86  268 ms
  gibberish            meaning 0.01  grammar 0.41  glossary 0.86  305 ms
```

**Glossary** is where the glossary actually gets made. Every contested term, the
renderings translators really used, how many keys are riding on the decision, and Jev's
proposal with its confidence. Clicking a rendering *is* the decision — no separate
approve step. A term can also be marked *depends on context*, *do not translate*, or
*none of these*, and a translator can type a canonical the corpus never contained.

Decisions land in `audit.decisions.json`, the glossary in `audit.glossary.json`, written
through on every change. Everyone with the link works on the same queue and the footer
says who did what.

## The glossary is a system, not an artifact

A glossary that is mined, arbitrated and thrown away is a report. This one remembers:

```
═══ RUN 1 (cold) ═══
  arbitrate    6/6
                    2 enforceable terms of 6 known
  167 requests · 264 findings

  — a translator decides all six in the app —

═══ RUN 2 (warm) ═══
  glossary          6 terms remembered · 6 decisions reused (no request spent)
                    6 enforceable terms of 6 known
  163 requests · 250 findings
```

Three things follow from that.

**A decided term is never re-arbitrated** — not to save the request, but because
re-asking invites the model to overrule someone who knew better. `approved`, `rejected`,
`context-dependent` and `do-not-translate` belong to the human who set them.

**A decision governs the queue immediately.** Findings are re-composed from the saved
judgments against the *current* glossary, so marking a term context-dependent removes
its adherence findings the moment you click it — no re-run, no cost.

**A rule reaches strings nobody has opened.** Alongside the canonical, a translator can
write the rule in their own words — *"Tor when it is a gate in a fence; Tür when it is a
garage door"* — and that text is handed to Jev as state on the next audit, so it applies
to thousands of keys no one has reviewed.

When the corpus grows a rendering a decision did not anticipate, the next run says so
rather than silently reopening the question:

```
  ! "anulowana" [de] was decided as "storniert" but the corpus now also uses others
```

## The workbook

Six sheets, in the order a person works through them.

| Sheet | |
|---|---|
| **Dashboard** | what the run found, by severity, category, language and reason; the measured formality norm per language |
| **Findings** | the review queue. Severity · Category · Source · Current · **Suggested** · **Decision ▾** · Final · Why |
| **Glossary** | every canonical term with its confidence, its rejected variants and how many keys use each |
| **Keys** | the whole corpus, one column per language, cells tinted where a finding landed |
| **Automated checks** | the 12,779 exact defects, with the precise diff (`{crlf}: 2→1`) |
| **Run** | requests, p50/p95, tokens and cost per stage — everything the summary claims |

`Decision` is a dropdown: *accept · reject · edited · defer*. `Final translation` is a
formula that takes the suggestion on **accept** and keeps the original otherwise, so a
reviewer who agrees with a row types one word. Then:

```sh
translate-audit apply audit.xlsx --out lokalise-reimport.csv
#   1338 decisions · 612 translations actually change
```

Only rows that were accepted or edited **and** whose text really changed are written —
a re-import carrying unchanged rows churns translation memory and resets review flags.
`--mongo-script apply.js` emits reviewed `updateOne` statements instead.

Findings are filed by **category**, because a consistency audit and a completeness audit
are different jobs and 4,000 untranslated Hungarian strings must not bury 600 terminology
conflicts in the same queue:

`integrity` (placeholders, markup — the product renders wrong) · `meaning` · `consistency`
· `completeness` · `style`.

## Run it

```sh
cd translate-audit
npm ci
export TYPESAFE_API_KEY=...        # or put it in ../.env

npm run audit -- run --mongo <your-db> --source pl
npm run audit -- run --csv export.csv --source pl
npm run audit -- run --synthetic 2000

npm run audit -- run --mongo <your-db> --dry-run     # mining only, no requests
npm run audit -- score --synthetic 400                 # precision / recall

npm run build:web                                      # build the review UI once
npm run review -- audit.run.json                       # translators' app on :8788
npm run review:dev                                     # hot reload while working on it
```

`--projects a,b` and `--langs de,uk` narrow the corpus. `--limit N` caps the keys.
`--only-flagged` audits only keys that lint or the glossary already touched, which is
cheaper and blinder — the best finds above had no exact defect at all. `--no-fix` skips
substitution. `--concurrency` defaults to 12 lanes.

```sh
npm test        # 54 tests: text facts, mining, policy, substitution gates, xlsx round-trip
npm run lint
npm run typecheck
```

## Sources

**MongoDB** — `Keys` plus one `Translations` document per (key, language).
Which string is the *source* is resolved per entry rather than assumed. In some projects
the key name is the source text itself; in others it is an identifier (`WidthX`,
`part_b2100`, `Type.symbol~DZ~name`) and the source-language *translation* is the real
source. Taking `keyName` everywhere would hand Jev identifiers
to judge.

**CSV / TSV** — delimiter and encoding are detected, not assumed. Exports from Windows
tooling are routinely CP1250, and reading one as UTF-8 destroys exactly the characters a
translation audit exists to protect. Where a previous export already flattened letters to
`?`, the loader says so and how many, because that cannot be recovered — only reported.

**Synthetic** — a corpus with deliberately injected, recorded defects, for `score`.

## Layout

```
src/lint.ts          exact defects: placeholders, markup, casing, punctuation, copies
src/glossary/store.ts the glossary as a living thing — statuses, merging, what is enforceable
src/review/decisions.ts what translators decided, and who decided it
server/api.ts        the review session: reads, writes, live checks
server/index.ts      http: the API and the built UI, with the key on this side
web/src/             the translators' app — review queue, glossary curation, summary
src/mine.ts          the glossary nobody wrote — grouping, conflicts, spacing-only auto-resolve
src/jev/questions.ts every question asked, and the two rules about what is never asked
src/jev/client.ts    the only module that talks to TypeSafe; pool, retry, measurement
src/arbitrate.ts     contested terms → glossary
src/audit.ts         one request per key, fanned out over every language
src/compose.ts       policy: raw judgments → reviewable findings. No inference.
src/substitute.ts    code performs the edit; Jev judges the result
src/cache.ts         every answer, on disk, so re-rendering is free
src/report/xlsx.ts   the six sheets, and reading the Decision column back
src/sources/         mongo · csv · synthetic
```
