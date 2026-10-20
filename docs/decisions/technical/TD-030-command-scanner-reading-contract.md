# TD-030 — The command scanner's reading contract: three tiers, one grading rule, and what a scanner row may be

**Status:** accepted (architect, session 17, 2026-10-19). Within BD-025 and its 2026-10-06 amendment; changes no
business decision. The product-owner half it leaves open is Q121.

## Context

BD-025's 2026-10-06 amendment made an unattended run execute its `ask` commands in the sandbox (decision 1),
kept `uncertain` at `deny` (decision 2), made the git boundary a hard carve-out (decision 3) and said, in the
paragraph *What the git boundary is not*, that the boundary *reads the command line* — an interpreter or a script
the run wrote *can spell any refused git command where no pattern sees it*, and *the control that holds whatever
the spelling is the credential* (host-only; path scoping is PROGRESS backlog 481). The block list has the same
shape: its control is the run container (uid 1000, `cap_drop: [ALL]`, `no-new-privileges`, no `sudo` in the
stock image, the workspace the only writable mount).

Between M10 and M11 the scanner took eleven rows (WP-185, WP-188, WP-193, WP-196–WP-201, WP-203, WP-206,
WP-207), each closing a spelling class a review had found: a package runner's string, a redirection among the
words, an environment name npm reads, a git key set with `-c`, an expansion glued to a name, an unknown wrapper,
a judged name glued by punctuation, the dynamic loader. The session-17 rows (WP-201, WP-203, WP-206, WP-207)
each took three review rounds, and the rounds had one shape: **what failed was an enumeration** — a glue list
that missed `% # @ ~ ^`, a wrapper list that missed `sg` and the loader, a tilde rule that missed `~login` — and
**what held was a structural rule** — *a word is judged only when it is literal*, *an unknown command is a possible
wrapper*, *argv as the shell builds it*, *a name boundary is any character outside `[A-Za-z0-9._-]`*. Each row
also measured its over-ask on a corpus that lived in a scratch directory and, as backlog 603 and 605 record,
*will not outlive the session*.

What is still open (backlog 598, 605 — closed by WP-210, see the 2026-10-19 amendment below — 592/596/601, 608, 606/607, 581, 587, 603's `frobnicate $x id`) is each a
grammar the scanner does not have. Without a stated contract every such grammar is filed as a major, built as a
row, and reviewed for three rounds against spellings that are, by BD-025's own paragraph, the credential's and
the sandbox's. This decision states the contract so that a finding is graded by its tier, a row is opened only
for a tier the scanner promises, and the over-ask is a diff the suite prints.

## Decision

1. **The scanner reads in three tiers, and says which tier a spelling is in.**
   - **Tier 1 — structural readers.** The shell's own grammar as bash documents it — quoting, lists, pipes,
     redirections, command and process substitution, here-documents and here-strings, braces, expansions,
     line continuations, `-c` bodies — and the four rules the rows established: a word the scanner judges is
     judged only when it is literal (WP-201); an unknown command is a possible wrapper, so its arguments are
     command-position words (WP-203); the block list, the floors and the boundary read argv as the shell
     builds it (WP-198); a judged name is read inside a scanned argument whatever glues it, at a structural
     name boundary (WP-206). Tier 1 is closed over the shell's syntax. It is **the guard**: a tier-1 spelling
     that reads `allow` under `auto` is a defect, graded by what it reaches.
   - **Tier 2 — declared grammars under a census.** Per-program facts the shell does not supply: a wrapper's
     option grammar (which options take a value, where its command starts), a runner's exec subcommands, a
     floor's hazardous options, the exec primitives of a **closed** script language (one with a finite,
     documented exec set and no way to compose a function name — `sed`, `awk`; not perl, python, node, ruby,
     php), the getopt reading of a block entry, and the stock image's own wrappers. Each entry is cited from
     the program's manual at the image's pinned version, and each table is held by a census that refuses a
     name on no reader. **An enumeration is admitted only when its omission fails closed**: a name not in the
     list must fall to tier 1's unknown-command reading (uncertain), never to `allow`. A list whose omission
     would read `allow` is not a tier-2 table; it is a tier-3 residual written as a list, and is refused as
     a design. A tier-2 spelling that reads `allow` is a defect graded minor unless the program is in the
     stock image and the line is literal, in which case major.
   - **Tier 3 — the stated residual.** A name composed at run time (`"gi"+"t"`, `getattr`, `$'…'`, a locale
     string); an inline script to a composing language (`python3 -c`, `node -e`, `perl -e`, `ruby -e`,
     `php -r`) beyond the literal names it contains; a script or file the run wrote (`bash f`,
     `run-parts`, a planted `.git/config` under `git -C <dir>`, an `LD_PRELOAD` of a
     written object); a project's own wide `allow` entry; and a wrapper the image does not ship handed an
     expansion (`frobnicate $x id`). The scanner gives tier 3 the literal read (tier 1's four rules) and
     nothing more. Its control is the sandbox (BD-025, 2026-10-06, decision 1's list) and the credential
     helper (host-only, while the run is live). **A tier-3 spelling is pinned** in `unattended-commands.test.ts`
     under *the residual, stated*, named in technical/05's residual paragraph and in the module docblock,
     and **gets no row and no major**: a review that finds a new tier-3 spelling adds it to the pinned list
     and the paragraph, and the backlog entry, if one is filed, is a nit that closes with the pin.

2. **A spelling is graded by its control, not by its verdict.** *Fail-open under `auto`* is a statement about
   the scanner; *live* is a statement about what the sandbox and the credential let the spelling do. A tier-3
   spelling on the git boundary gains nothing over `printf '<command>' > x.sh; bash x.sh`, which decision 1
   runs today, and is graded as that: the stated residual. A tier-1 or tier-2 spelling is graded by whether
   it is literal, one line, and runs on a program the stock image ships (major), or needs a project image or
   a non-literal word (minor). The grader cites the tier.

3. **What a scanner row is.** One rule, stated in a sentence, at a tier the scanner promises; the fail-closed
   form ships and the narrowing is the split clause; its over-ask is **measured first on the committed corpus
   (WP-208)** and printed by the suite as a diff of cells, never as a number in a scratch directory; every
   site has a canary; nothing executes in any test. A reviewer's new spelling is in scope when it is in the
   row's tier and out of scope — pinned, not a finding — when it is tier 3. Three rounds on one row is the
   signal that an enumeration is being reviewed as if it were a guard; the orchestrator then asks which
   structural rule the list stands in for, and the row ships the rule.

4. **The two instruments are mandatory.** The agent-line corpus (`test/fixtures/commands/`, WP-208) holds the
   ordinary lines and their three cells; the adversarial rows live in the two policy test files under
   describes that name their row. A scanner change that moves a corpus cell updates the fixture in the same
   change and records the count in its notes. A row whose rule cannot be measured on the corpus says so and
   adds the lines it needs to the corpus with the `composed` provenance mark.

5. **The product-owner half is Q121, not this decision.** Whether an inline script to a composing language
   should be uncertain under `auto` re-decides decision 1 for the commonest one-liners a coding agent writes;
   the sixth M11 amendment declined to decide it and this decision keeps that: tier 3 holds them until the
   product owner answers. The exec-time alternative (Q122) is the architect's and is recorded under
   *Alternatives*.

## Rationale

- The session's evidence is one-directional: every structural rule survived three rounds and every list lost
  at least one. A contract that admits lists only where their omission fails closed turns the pattern into a
  design rule rather than a review habit.
- BD-025 already says the boundary is a text reader and names the credential as the control. Grading a
  tier-3 spelling as a major contradicts that paragraph and spends review rounds on spellings two lines of
  `bash` reproduce under the same decision.
- The corpus is the only measurement every row shared, and it was lost twice. A committed fixture whose cells
  the suite recomputes is cheaper than any single row and makes the over-ask a reviewable diff.

## Alternatives considered

- **Amend BD-025 so every inline interpreter script is uncertain under `auto`.** The honest fail-closed form of
  the sixth amendment's declined option 3. It is the product owner's (decision 1 was theirs), it costs
  `python3 -c "print(…)"` and `node -e` on every unattended run, and its count is measurable on the corpus.
  Filed as Q121 with that measurement as the recommendation's evidence; not taken here.
- **A primitive list per composing language** (`subprocess`, `os.system`, `child_process`, `system`, …). A
  deny-list over a language that composes; fails open by construction (sixth amendment). Refused as a tier-2
  table by rule 1's admission test. The closed languages (`sed`, `awk`) pass that test and are tier 2.
- **An image-wide floor census** (every binary's program-running options from its man page). Declined by the
  sixth amendment: unverifiable in the converse and not the project's image.
- **Judge at exec time rather than on the line.** A reader of every `execve` in the run container — a seccomp
  user-notification supervisor in the runlet, or an exec shim on `PATH` — would read tier-3 spellings by their
  real argv: `git push origin main` is `git push origin main` whatever composed it. It is the only approach
  that makes tier 3 a reader's rather than the credential's, and it is a runtime change on both
  architectures with its own failure modes (a shim is bypassed by an absolute path; seccomp-notify needs a
  supervisor and `CAP_SYS_PTRACE`-free design; Node's own child processes must pass). Recorded as Q122 for
  the architect pass after dogfooding, with the measurement that decides it: how many tier-3 spellings
  appear in real `run_messages` tool calls.

## Consequences

- Backlog grading changes for scanner findings: the entry names the tier; tier 3 is a nit closed by a pin.
  Entries already open are re-graded by the M12 ruling (587 is tier 3; 605's `sed`/`awk` halves are tier 2;
  598, 592/596/601/608, 606/607, 581 are tier 2).
- WP-208 (the corpus) is the first row of M12 and a dependency of every later scanner row.
- technical/05's scanner section gains the three tiers and the grading rule (WP-208 carries the paragraph,
  rule 83); the module docblock of `command-policy.ts` names the tiers where it states its residual (WP-210).
- A reviewer brief for a scanner row cites this decision and asks for the tier of every new spelling.
- No migration; no schema; no API change.

## Amendment 2026-10-19 (WP-210, session 17)

`sed -f`, a `sed … e` over a file, and every other `sed`/awk script that can execute a command (sed's `e`
command and `s///e` flag; awk's `system()`, `cmd | getline`, `print | "cmd"`) or that the reader cannot read
(a script file, awk `-W`, an expanded script word) moved from tier 3 to tier 2 (a declared grammar, here a coarse one that fails closed) at WP-210: the scanner reads them
`uncertain` (`UNCERTAINTY.scriptExecutes`) whatever the input, a coarse fail-closed rule chosen by the
orchestrator over a full sed/awk grammar after a safety classifier stopped the first implementer. The over-ask
is accepted under this decision's grading rule (an awk `|` inside a string next to `print`; `sed "s/x$/y/"`); the
committed corpus moved no line. The run image's `awk` is mawk 1.3.4 (measured), so gawk's `@load` is latent.

## Amendment 2026-10-20 (backlog 643, architect session 19)

Decision 1's tier-3 list names *a locale string* beside `$'…'` under *a name composed at run time*. That
item is the **translation**: a `$"…"` word that a message catalogue may turn into other text, which no
scanner can read and the sandbox holds — a catalogue is a `.mo` file under a directory bash searches, and
the run image ships none (measured at this amendment, `platform-runtime:wp239`, bash 5.2.37: `find / -name
'*.mo'` finds 0, `locale -a` lists `C`, `C.utf8` and `POSIX`, and `LANG`, `LC_ALL`, `TEXTDOMAIN` and
`TEXTDOMAINDIR` are unset). It is **not** the quoting. bash's *Locale-Specific Translation* is a section of
*Quoting* (https://www.gnu.org/software/bash/manual/bash.html#Locale-Translation): with no translation
*"the dollar sign is ignored"* and the word is read as double-quoted, so `$"--script-shell=/bin/id"` is
`--script-shell=/bin/id` to the program — in the image under `LANG=cs_CZ.UTF-8` and under
`TEXTDOMAIN=foo TEXTDOMAINDIR=/tmp` alike. That reading is **tier 1** (quoting is the shell's grammar), and
it is the literal read tier 3 is promised. A scanner that keeps the `$` gives neither: it hands a floor
`$--script-shell=…`, which is no option, and `npm test $"--script-shell=/bin/id"` read `allow` under
`auto` on a stock-image program — backlog 643, **major** by decision 2 (literal, one line, npm ships in
the image), as 642 was. The tier-3 item now reads *a `$"…"` word a catalogue the run supplies may
translate*; `$'…'` stays on the list with its own reason — its escapes compose a name (`$'\x67it'`), a
decoding the scanner refuses as `ansiCQuoting`, which `$"…"` has no counterpart of. The reading that closes
643 (WP-244) drops the `$` as bash does rather than refusing the word: the construct has no escapes to
decode, the module already reads it that way in `joinedText`, and a refusal would ship a mark where
decision 3 asks for the rule while leaving two readings of one construct. Decision 1's text is unchanged
above; this amendment is the wording.
