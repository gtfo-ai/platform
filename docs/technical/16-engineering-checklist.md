# 16 — Engineering checklist

This is the short list of habits that still prevent real defects in today's tree, distilled from the
102 "Standing rules earned by evidence" in `docs/technical/PROGRESS.md`. That section, with every
rule's full history and evidence, stays in PROGRESS.md and is frozen; the rule numbers in parentheses
point there. A new item is added here only when a real defect proves it: one line, ending with the PR
or commit sha that is its evidence. Rules that only served the old heavy orchestration protocol
(ledger format, citation guard, resume notes, prose sweeps) are deliberately not carried over.

## Tests and verification

1. Never pipe a run you may need through `| tail` or `| grep`: redirect the whole output to a file,
   gate on the exit status (or `set -o pipefail`), then grep the file — and report the target's
   `PASS:`/`FAIL:` line, never a test count; a `FAIL` naming only a file is a collection error, not a
   killed test. (rules 61, 62, 75)
2. Mutation-check every guard, its refusing branch included: disabling it must fail a named assertion
   in a fast tier (not only the e2e, not a timeout, not a `TS` error — probe runtime guards from
   JavaScript), and a guard nothing can reach gets a seam or a line saying it is deliberately
   unreachable. (rules 3, 14, 22, 24, 33, 41, 67)
3. Calibrate every mutation harness or canary with a planted failure (a `throw`) and watch it fire
   before believing it; mutate a copy — never in place while another tier runs, never through a copy
   whose `@platform/*` imports resolve back to the original — and revert with the same tool you
   mutated with, checked against a digest taken first, never `git checkout`/`restore`/`stash`.
   (rules 21, 74, 77, 88, 97)
4. A wait binds the signal the assertion needs: wait on the last row the platform writes (the exact
   line you assert), ask whether it is written after the thing you assert and whether the predicate
   was already true before the event, bound silence rather than the drain, and prefer a structural
   signal (a pid file, a row) to any wall-clock margin. (rules 2, 50, 56, 57, 64, 76, 87)
5. A fake may be stricter than the real adapter, never kinder: ask whether it can reach the state you
   assert and what it does with the input the change produces, assert its kindest divergence
   positively, and land every new port obligation in the shared contract suite in the same change.
   (rules 1, 4, 12, 23, 82)
6. Make each test discriminate: assert which branch ran, prove a counter moved before asserting it
   did not, test a boundary from both sides, pick negatives only exact matching refuses, feed hostile
   values into fields bounded by refusal, name fixtures for what they are, and parameterise a test
   over the same set the code branches on. (rules 10, 29, 37, 40, 42, 43, 45, 68)

## Git, guards and CI

7. Every test that spawns `git`, or a script that runs it, takes its environment from
   `scripts/git-scratch-env.mjs` (`scratchGitEnv`/`initScratchRepository`, or `checkoutGitEnv` for a
   read of this checkout) — never an inherited `GIT_*`. (rule 95, retired into the census at WP-162)
8. Push only from a clean tree whose unit tier is green — the pre-push hook tests the working tree,
   not the commit — never with `--no-verify`, with the message written from one heredoc or `-F` file
   so `Signed-off-by` (git's own identity) and `Co-Authored-By` sit in one final trailer paragraph,
   and after `node scripts/commits.mjs dco --from origin/main` (and `commitlint`) print `PASS:`; CI on
   Linux is the authoritative verdict (`in_progress` is not one), especially for filesystem, uid and
   network behaviour. (rules 6, 52, 69, 71, 84, 90, 94, 102)
9. A guard over the tree reads its scope from git (`scripts/census-files.mjs`), never a hand list; a
    step added to `verify` is added through `scripts/verify-targets.ts` so CI runs it; a mechanically
    detectable defect gets a check rather than a sentence; and a new guard is run once with its own
    file tracked and once with a planted untracked file. (rules 7, 30, 34, 59, 85, 91)

## Data, migrations and concurrency

10. A migration is a new numbered file, forward-only and never edited once applied, opening with its
    `-- migration-class: additive` (or `contract; expands: <NNNN_name>`) header that
    `pnpm migrations:check` enforces. (TD-011, TD-032 — no numbered rule; included as a standing
    requirement)
11. A whole-row write is correct only while nothing else writes the row: use the versioned `save` or a
    narrow method, make an admission decision count what is committed but not yet written, and when
    you move a writer across a concurrency boundary assert a derived total, not the field.
    (rules 9, 73, 79, 89)

## Security and untrusted input

12. Every outbound provider call on behalf of a binding goes through `IntegrationActionExecutor`,
    never inside an open transaction (a handler decides, the `pipeline.outbound` job calls); fail
    closed on a mutation and open on an inbound notification, and refuse identity material that would
    need redacting rather than redacting a key. (rules 20, 31, 35, 70)
13. Untrusted text is never rendered as markup and every URL goes through `safeHref` in
    `apps/web/src/ui/untrusted.tsx`; a syntactic guard is tested with every spelling (spread,
    `createElement`, `setAttribute`), an encoder's claim with a test that kills it, and an accidental
    defence is measured, not assumed. (rules 44, 46, 47, 48)
14. Treat an untrusted producer's fields as absent until proven: a missing number is not zero, an empty
    credential is a refusal, a cap is single-sourced and idempotent, `Object.hasOwn` not `in`, a path
    guard folds per segment (NFKC, `ß`→`ss`) and is tested against realpaths, a planted secret is
    looked for in the output, and a fixture credential is shaped past the provider's real token
    pattern (e.g. a hyphen after `FAKE`). (rules 13, 15, 16, 18, 19, 26, 28, 36, 38, 55, 93)

## Agents and the machine

15. Never `pkill`, `pkill -f` or `killall`: stop only a process you started, by its PID (a tier chain by
    its process tree, e2e debris by its `com.agentic.e2e.pid` label); wait on a file or a given PID,
    never `pgrep -f`; run canaries in the foreground with a bound; trap cleanup and never silence it;
    and keep to at most two agents, one while Docker or the e2e tier runs, with no synthetic load.
    (rules 25, 60, 66, 96, 99, 100, 101)
