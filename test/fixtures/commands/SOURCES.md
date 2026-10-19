# The agent-line corpus — where it came from

TD-030 decision 4, WP-208. Each `<name>.txt` here is a corpus: one command line per line, verbatim,
no blank line, no comment, no duplicate. `<name>.verdicts.json` records, per line, the cells the
command policy answers under its defaults — `attended` (`evaluateCommand`), `auto` and `deny`
(`decideUnattendedCommand`) — each tagged with what decided it when it is not `allow`.
`packages/domain/src/policies/command-corpus.test.ts` recomputes every cell and prints the diff;
`node scripts/command-corpus.mjs --write` regenerates the verdicts.

## Provenance: `composed`

In the vocabulary of `test/fixtures/http/` (CLAUDE.md, the provider-fixture rule), every line here is
**`composed`** — written by a person as an ordinary line a coding agent types, **not recorded from
any run**. No line is taken from `run_messages` or from any transcript. This file is prose: the http
provenance suite (`test/contract/integrations/fixture-provenance.contract.test.ts`) discovers
`test/fixtures/http/` only, so nothing checks this block mechanically.

| File | Lines | Written by | Date | Note |
|---|---|---|---|---|
| `agent-lines.txt` | 286 | WP-203's reviewer, session 17 | 2026-10-18 | ordinary coding-agent lines — package scripts, test runners, linters and formatters, git reads, file utilities, loops, archives — many with a quoted `"$variable"`, which is where WP-201/WP-203's over-ask showed; two lines hold a literal backslash-`n` (`printf '%s\n' "$x"`, `tr : '\n'`), kept as written |
| `developer-lines.txt` | 85 | WP-201's implementer, session 17 | 2026-10-18 | ordinary developer lines (`npm test`, `git status`, `rm -rf dist`, `python -m pytest`, `for f in *.ts; do …`, `cp file{,.bak}`); WP-201's notes call it "83 developer lines" — the file it measured holds 85 |

## What the corpus is, and is not

It **is** the measurement a scanner change's over-ask is quoted from: a diff of cells on plausible
lines, printed by the suite, so a rule that newly refuses an ordinary line says how many and which.
It **is not** real traffic: the lines were written to be plausible, not counted from runs, so a
count on it is not a frequency. A recorded successor is Q122 (a)'s measurement (tier-3 spellings in
real `run_messages`). The adversarial lines live in `unattended-commands.test.ts` and
`command-policy.test.ts` under the describe of the row that pinned them, not here.

## Baseline (at `9a3216e9`)

The value of each cell, counted per mode. Under `auto` an `ask` that runs reads `auto`; under `deny`
it reads `deny`. `hazard` is a refused `command`/`trust` argument, `git` the git boundary.

| Corpus | Mode | allow | ask / auto / deny | uncertain | block | hazard | git |
|---|---|---|---|---|---|---|---|
| agent-lines | attended | 40 | 237 | 6 | 3 | — | — |
| agent-lines | auto | 40 | 236 | 6 | 3 | 1 | 0 |
| agent-lines | deny | 40 | 236 | 6 | 3 | 1 | 0 |
| developer-lines | attended | 33 | 51 | 1 | 0 | — | — |
| developer-lines | auto | 33 | 49 | 1 | 0 | 0 | 2 |
| developer-lines | deny | 33 | 49 | 1 | 0 | 0 | 2 |

The two developer `git` cells are `$EDITOR file` and `"$PYTHON" -m pytest`: a computed command name,
which the git boundary refuses (`computesCommandName`).
