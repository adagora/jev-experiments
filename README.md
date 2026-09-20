# Jev experiments

[TypeSafe](https://docs.typesafe.ai/) / Jev latency-focused demos. Each app lives in its own top-level directory with its own README, TESTING.md and screenshots.

| App | What it shows |
|---|---|
| [judge-sheets](judge-sheets/) | A spreadsheet where typing a column header predicts the column. `Urgency` in an empty header fills 300 rows of semantic predictions in ~3.5 s, as `=JUDGE / =PICK / =RATE` formulas the formula bar still explains. |
| [translate-audit](translate-audit/) | Translation consistency for a corpus that never had a glossary. Code mines the disagreements out of 7,040 keys, Jev arbitrates each one — 99,933 judgments in 3 minutes. Ships an Excel workbook for sign-off and a keyboard-driven review app where translators curate the glossary and every edit they type is checked by Jev in ~300 ms. The glossary remembers: decided terms are never re-arbitrated. |
