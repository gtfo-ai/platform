# TD-027 — Command defaults are per stage, not only per role: the merge lives on a `conflict_resolution` stage layer and never at the implementation maximum

- **Status:** accepted
- **Date:** 2026-09-13
- **Deciders:** architect (ruling on Q77, session 5)
- **Relates to:** BD-025, BD-030, BD-021, BD-008, product/19 §3, product/04 S6b, product/16, technical/04, technical/05, TD-021, TD-025, Q76, Q77, Q40, Q37, WP-26

## Context

**What forced it.** WP-26 built BD-030's rebase gate. The gate reads the provider's `has_conflicts`
and settles; a branch that no longer applies enters `conflict_resolution`, a short **run** with the
developer's role (the argument for a run rather than a provider call is in
`CONFLICT_RESOLUTION_STAGE`'s docblock: a server-side rebase endpoint fails on conflict and hands the
branch back, and *resolving* is the half product/04 S6b asks for). Because `git push --force*` is
blocked at the organisation maximum and `narrowCommandPolicy` only ever adds to `block`, a **rebased**
branch cannot be published by any run this build starts (Q76, measured with `evaluateCommand` before
the row was written). So the resolution merges. To make that runnable the row added `'git merge'` and
`'git merge *'` to `DEFAULT_IMPLEMENTATION_ALLOW` — which is the organisation **maximum** that every
implementation-stage run of every project inherits, not a default for the one stage that needed it.
Q77 is the objection, and it is a BD-025 matter rather than a work package's.

**What the documents say.** BD-025 §2: *"Defaults ship **per stage**; the organisation sets the
maximum autonomy; projects can only narrow it."* product/19 §3 is titled *"Command policy defaults
per stage"* and ships two of them — a read-only group and Implementation — and closes with *"The
organisation can only tighten these; projects can add to allow within the org maximum."* The
Implementation list names `git rebase` and **not** `git merge`; the verb *merge* appears only in
product/04 S6b's *"rebase (or merge, per project)"* and in no command list anywhere.

**What the code does.** The document's per-stage shape is implemented **per role**:
`COMMAND_BASELINE_BY_ROLE` (`packages/application/src/pipeline/planner.ts`) picks one of two
baselines and `commandBaselineFor(role)` is called at exactly one site (`planner.ts:542`), inside
`narrowCommandPolicy(…, settings.config.commands)`. The one existing per-**stage** least-privilege
table, `PLATFORM_TOOLS_DENIED_BY_STAGE`, only *subtracts*. So there is no per-stage command layer
today, and per role is an approximation of what BD-025 actually wrote.

**Where a command is enforced, read off the code rather than remembered.** The only thing that
evaluates a shell command is the platform-side `PreToolUse(Bash)` hook
(`packages/infrastructure/src/runner/hooks.ts`), which calls `evaluateCommand` and translates the
verdict; `apps/launcher` never sees a command (it creates volumes, networks and containers), and the
runlet never sees one either — the shim *"owns exactly one child: the Claude Code CLI"*, its
credential socket *"accepts `cred.get` and `ping` and refuses every other frame, `spawn` included"*
(TD-025). The compensating controls around it are the container's mounts (TD-021), the per-run egress
proxy, and a push credential whose `branchPatterns` is **carried, not enforced** — a GitLab access
token has no branch scoping, the protected default branch is an operator prerequisite, and that gap
is **Q40**. The command policy is therefore not one layer of several for `git`: for what `git` is
asked to do inside the workspace, it is the layer.

**What a `git merge` can do there that the previous maximum refused.** Its effect on files is nothing
new — `git add *`, `git commit *` and `git push origin agentic/*` already let a run put arbitrary
content on its own branch. Its effect on **ancestry** is new, and the wide spelling is where it
bites. git-merge(1) on the `ours` *strategy*: *"the resulting tree of the merge is always that of the
current branch head, effectively ignoring all changes from all other branches"* — so
`git merge -s ours origin/main` records main as merged while discarding its tree, and the human merge
that follows fast-forwards main onto a tree that silently reverts those commits. Two more spellings
the wide pattern carries: `--no-verify`, which git-merge(1) says bypasses *"the pre-merge and
commit-msg hooks"* — the same hazard `git commit* --no-verify*` is already floored for, because a
repository's pre-commit hook is where its secret scan runs (BD-002) — and `-X ours` / `-X theirs`,
which *"forces conflicting hunks to be auto-resolved cleanly by favoring"* one side, i.e. resolves a
conflict by deleting somebody's change, the one outcome the stage's own prompt tells the model not to
produce. (git-merge(1), <https://git-scm.com/docs/git-merge>, retrieved 2026-09-13.)

**And one ownership argument.** BD-030 gives the rebase gate the job of bringing a branch up to date:
bounded at two attempts, escalating with a blocker brief, and **counted** — `task.rebase.checked`
carries product/16's *"conflicts auto-resolved vs escalated"*. A merge verb available to every
implementation run puts a second, unmeasured writer on that activity, and the number stops being an
account of how branches got up to date (standing rule 9).

## Decision

1. **`git merge` is not at the implementation maximum.** `'git merge'` and `'git merge *'` come out
   of `DEFAULT_IMPLEMENTATION_ALLOW`. product/19 §3's Implementation list and the shipped constant say
   the same thing again.
2. **Command defaults gain a per-stage layer**, which is BD-025's own word. A table keyed by stage id
   holds **extra allow patterns**, sits beside `PLATFORM_TOOLS_DENIED_BY_STAGE` in the planner, and is
   consulted by `commandBaselineFor(role, stage)`:
   `allow = roleBaseline.allow ++ (COMMAND_ALLOW_BY_STAGE[stage] ?? [])`.
3. **It may only add to `allow`.** It never touches `ask`, never removes from `block`, and it is
   applied **before** `narrowCommandPolicy`, so a project still narrows the result and an entry the
   project's own `allow` list omits is still dropped and reported in `ignoredAllow`. The additive
   direction is structural (the table holds patterns, not a replacement list), not a convention.
4. **Every entry must be a literal spelling that product/19 §3 lists for that stage.** This is the
   allow-side twin of `DECLINED_BLOCK_VARIANTS`' standing rule — *"inventing patterns here would put
   security rules in code that the product document does not state"* — applied to the list that
   actually grants something. A stage layer is a place to put a documented default, not a place to
   invent one.
5. **The only entry today is `conflict_resolution`, and it is exactly four spellings:**
   `git merge origin/*`, `git merge --no-edit origin/*`, `git merge --abort`, `git merge --continue`.
   Nothing may sit between the verb and the ref, and the ref is a remote-tracking one.
6. **Nothing here touches the block list.** `git push --force*` stands as it is; whether
   `--force-with-lease` into `agentic/*` is inside product/19 §3's block stays **Q76**, with its own
   owner. product/18's `strategy: rebase | merge` key stays unadded, unchanged from WP-26.
7. **product/19 §3 gains the third per-stage bullet** saying 5, and technical/04 gains the mechanism
   saying 2–4. The document is the source; the constant quotes it.

## Rationale

- **It is the document's own shape.** Per stage is what BD-025 §2 and product/19 §3's title say; per
  role was the approximation, and the approximation is what made a one-stage need look like a change
  to the maximum. This decision does not invent a concept, it finishes implementing one.
- **The blast radius is the whole of the difference.** With 1 + 5, no run of any other stage of any
  project gains a verb, and inside the stage the four spellings are anchored: `-s ours`,
  `--strategy=ours`, `-X ours`, `-X theirs` and `--no-verify` cannot reach `allow` at all, because
  nothing may sit between `git merge` and `origin/…`. They fall through to the `ask` fallback (rule 4:
  *"an unmatched command is `ask`, never `allow`"*) and an unattended run is denied. ~~**No new
  `HAZARDOUS_ARGUMENTS` entry is added and none is needed**: the defence is a closed set, not a
  blacklist chasing spellings.~~ **Amended — that last claim was wrong, and measured wrong.** The
  closed set answers for the position *before* the ref only; an allow glob's `*` spans spaces, so the
  same flags written *after* it match. Four floors are the mechanism — see the amendment below.
- **`--no-edit` is in the set for a measured reason, not for comfort.** git-merge(1) makes the editor
  the default — *"Invoke an editor before committing successful mechanical merge … The `--no-edit`
  option can be used to accept the auto-generated message"* — and a run has no terminal and an `env`
  the platform writes explicitly (technical/04). Without the spelling the stage's ordinary command is
  the one that cannot finish.
- **`--abort` is in the set because there is no other way back.** `git reset --hard origin/*` is
  blocked and plain `git reset --hard` is not allowed, so a half-finished merge would otherwise
  strand the workspace for the second of the two attempts BD-030 promises. `--continue` is included
  because it can do nothing `git commit *` cannot already do.
- **`origin/*` and not `*`:** the target is a ref the platform's own clone fetched from the project's
  remote. A local branch name, a raw sha or a ref from somewhere else falls to `ask`.
- **The cost is small and belongs to WP-26.** One constant in the domain policy module, one table and
  one parameter at one call site in the planner, two tests. The alternative — ship the widened maximum
  now and scope it in a later row — leaves `main` carrying an organisation maximum that contradicts
  the product document, which is the state Q77 objects to.

## Alternatives considered

- **(a) `git merge` at the maximum for every implementation run** (what WP-26 shipped), narrowed or
  not. Refused on three counts: it changes the product document's Implementation sentence for every
  project to serve one stage; the wide `git merge *` spelling carries the `-s ours`, `-X ours/theirs`
  and `--no-verify` hazards above; and it puts a second, unmeasured writer on the activity BD-030
  gave the rebase gate and product/16 counts. Narrowing the spellings without scoping the stage would
  answer the second count only.
- **(c) allow `git push --force-with-lease origin agentic/*` so the resolution can rebase as
  product/19 §3's verb says.** Refused **here**, and left where it belongs. Three reasons. It requires
  **narrowing a block entry** — `git push --force*` is a prefix match, so `--force-with-lease` is
  reachable only by splitting that pattern — and the block list is the one list BD-025 lets nobody
  narrow and Q76 already names its owner. The compensating control is **void in this stage**:
  git-push(1) says *"supplying this option without an expected value … interacts very badly with
  anything that implicitly runs `git fetch` on the remote to be pushed to in the background"* and
  that the protection is *"trivially defeated if some background process is updating refs"*
  (<https://git-scm.com/docs/git-push>, retrieved 2026-09-13) — and this run's **first** command is an
  allow-listed `git fetch`, so the lease it would satisfy is one it set itself; the documented repair,
  `--force-if-includes`, would have to be carved out with it. And the blast radius rests on something
  nobody verifies: the branch is the platform's own `agentic/*` and a push to any other ref is floored
  at `ask` by `git push* *:*` and by the absence of an allow entry, but what actually protects the
  **default** branch from a token that is not branch-scoped is the provider's branch protection, an
  operator prerequisite recorded as **Q40**. A force-push capability is the wrong thing to add on top
  of an unverified precondition. Q76 stands unanswered and unchanged.
- **(d) a project key `strategy: rebase | merge`** (product/18). Refused for WP-26's own reason: an
  unread configuration key is a defect (backlog 58) and a key whose second value cannot run is worse
  than one. It becomes available the day Q76 is answered.
- **(e) leave the constant as it is and amend nothing.** Refused: the constant and product/19 §3 would
  keep contradicting each other, and the repository's rule is that the document wins and moves first.
- **Making the stage layer subtract only, like `PLATFORM_TOOLS_DENIED_BY_STAGE`.** That table's
  docblock says subtraction *"is the only direction a stage may move a role's privileges"*, and this
  decision knowingly inverts the direction for commands. The inversion is bounded by 3 and 4: the
  layer adds only patterns product/19 §3 lists for that stage, only to `allow`, and the project's
  narrowing still runs afterwards — so the ceiling is still a document nobody edits by accident, which
  is the property the tool table's rule was protecting.

## Consequences

- **WP-26 owes the code change before it merges** — listed in `PROGRESS.md`'s `### Ruling — Q77`. In
  summary: remove the two entries from `DEFAULT_IMPLEMENTATION_ALLOW`; add the domain constant
  `CONFLICT_RESOLUTION_EXTRA_ALLOW`; add `COMMAND_ALLOW_BY_STAGE` and the `stage` parameter to
  `commandBaselineFor`; make `STAGE_PROMPT_FOCUS.conflict_resolution` name the exact spellings; fix
  the two docblock sentences that quote product/19 §3 incorrectly; tests.
- **A project that declares its own `commands.allow` loses the merge** unless it lists the four
  spellings, because `narrowCommandPolicy` intersects. The visible consequence is a stage that cannot
  resolve, two attempts spent and an escalation to `needs_human` with the gate's blocker brief —
  BD-008's ending, not a new failure mode. `ignoredAllow` reports it.
- **The rebase half of product/04 S6b stays unrunnable** on this build. product/19 §3's `git rebase`
  entry is left alone: it is the document's own verb, and a run may still rebase locally — it simply
  cannot publish the result. Q76 owns that.
- **`git rebase *` remains a wide spelling at the maximum**, and this ruling deliberately does not
  narrow it: the verb is in product/19 §3, its `-x`/`--exec` forms are already on the ask list and its
  `--upload-pack`/`--exec` payloads are floored by `HAZARDOUS_ARGUMENTS`. Pinning its arguments the way
  5 pins the merge's would be a change to a documented entry and needs its own row.
- **Verification.** The two git behaviours this decision turns on are cited inline with retrieval
  dates rather than in a `docs/research/` file, because the ruling was made in a round that could not
  open one; the pages are git-merge(1) and git-push(1) and the quotes are verbatim. A research note is
  owed if either claim is ever re-used.
- **A second stage entry needs no new mechanism, only a document.** The next stage that needs a verb
  adds a bullet to product/19 §3 and a row to the table, and the invariant tests hold both.

## Amendment (WP-26 round 2 — as measured)

**What this decision got wrong: a closed allow set excludes a flag only in the position it pins.**
The Rationale above argued that because the four spellings let nothing sit between `git merge` and
`origin/…`, the hazardous flags *"cannot reach `allow` at all"* and therefore no
`HAZARDOUS_ARGUMENTS` entry was needed. The first half holds; the second does not follow, and the
implementer measured it with `evaluateCommand` on the shipped policy: an allow pattern is a glob over
the whole line and `*` matches **a run of characters including spaces**
(`globToRegExp`: `*` → `[\s\S]*`), so `git merge origin/main --no-verify`,
`git merge origin/main -s ours` and `git merge origin/main -X theirs` all match
`git merge origin/*` and answered **`allow`** under the new stage baseline. The flag simply moved to
the other side of the ref. Nothing about the decision's *shape* changes — the stage layer, the four
spellings and the absent merge at the maximum all stand — but its claim about **why** they are safe
was false as written, and a false safety argument in a security record is worse than a missing one.

**Why exact spellings alone cannot carry it.** A pattern pins the characters it contains and says
nothing about what follows the last `*`. To exclude a trailing argument by enumeration the allow list
would have to pin the *end* of the line as well, which no glob here does and which would then refuse
every innocent trailing argument too (a ref with a path, a `--no-edit` written last). Nor does the
ask-list answer it: an `ask` entry beats an `allow` entry only by pinning **more literal characters**,
and `git merge origin/*` pins eighteen — which is the same arithmetic that put the `find … -exec`
family on `HAZARDOUS_ARGUMENTS` rather than on `DEFAULT_IMPLEMENTATION_ASK`.

**The floors are the mechanism, and they are what product/19 §3's bullet requires.** The bullet states
the *requirement* — those spellings are *"**ask**, never allow"* — and the code now implements it with
four entries on `HAZARDOUS_ARGUMENTS`, which match the block-list's way (tokens anywhere, or the whole
line) and can only tighten an `allow` to an `ask`:

| Pattern | Why |
|---|---|
| `git * --no-verify*` | generalised from `git commit* --no-verify*`; git-merge(1) says it bypasses *"the pre-merge and commit-msg hooks"*, and the same measurement closed `git push origin agentic/x --no-verify`, which was `allow` until this entry existed. Unscoped for `git * --exec*`'s stated reason: the next verb to grow the flag would be missed the same way. |
| `git merge* -s*` | the `ours` **strategy** records the other branch as merged while discarding its tree |
| `git merge* --strategy*` | the long spelling of `-s`, and `--strategy-option` the long spelling of `-X` |
| `git merge* -X*` | resolves every conflicting hunk by deleting one side of it |

**Consequences of the amendment.** The defence is now *two* mechanisms with different jobs, and both
are load-bearing: the closed allow set decides **what may run** (no merge at the maximum, four
spellings at one stage, an unmatched line falling to `ask`), and the floors decide **what an allowed
line may not carry**. The claim "the defence is a closed set, not a blacklist" is withdrawn for the
merge; rule 4's fallback still carries every spelling written before the ref. Three document sentences
were corrected with this amendment: the Rationale bullet above, technical/04's *"Hooks and policies"*
amendment, and product/19 §3's fourth bullet, whose *"therefore"* was true of the pre-ref position and
of the shipped behaviour but not of the closed set alone.

## Amendment (WP-54 — two more add-only layers, and the baselines they sit on)

**The baselines are three named lists, chosen per role.** `COMMAND_BASELINE_BY_ROLE` selects
`read_only`, `verification` (the read-only list, the lockfile installs and the project's declared
commands — reviewer, acceptance tester, discovery) or `implementation` (the verification verbs plus
`git add`, `git commit`, `git rebase`, `git fetch` and the push to `agentic/*`). BD-025's WP-54 amendment carries why the project's declared
commands sit in the baseline rather than at the maximum (Q69 answer (ii)). The lockfile installs in
`verification` are an assumption beyond product/19 §3's read-only bullet, stated: a test command in a
fresh workspace runs against no dependencies until one has.

**A skill layer, the same shape as the stage layer.** A run provisioned with a skill may run the read
verbs that skill's own recipes use (`COMMAND_ALLOW_BY_SKILL`), and a provider skill is provisioned only
for a project with that provider's binding. Like this decision's stage layer it **adds to `allow`
only**, runs **before** the project narrows, and never touches `ask` or `block` — so the floors above
still tighten a skill verb carrying a hazardous flag.

**The narrowing grants a literal a pattern covers, never a pattern a pattern covers.** A project entry
`npm run lint` narrows the baseline's `npm run *` (technical/12's own example) instead of landing in
`ignoredAllow`; a **glob** entry is granted only verbatim, because glob-to-glob coverage can turn the
maximum's `ask` into the project's `allow` (`git rebase -x *` under `git rebase *` pins more literal
characters than the ask entry `git rebase* -x*` — measured with `evaluateCommand` before it was
decided). New floors for the new verbs, as shipped after WP-54's review round 2 (the list is
`HAZARDOUS_ARGUMENTS` in `packages/domain/src/policies/command-policy.ts`, held by a table test that
runs every spelling through every baseline): for `make`, a positional argument containing `=` and
`-E` inside a single-dash short-option cluster — both **token-scoped**, so `make --jobs=4 test` and
`make -j4 TEST` stay `allow` while `make test V=1` is `ask` on purpose (a command-line variable can
override `CC` or `SHELL`) — and `make* --e*`; for `go`, `-exec`, `-toolexec` and `-ldflags…extld` in
both dash forms; `cargo* --config*`; for npm and pnpm, `--script-shell` and `--node-options`, each from the shortest prefix that is unique
today, and `--config.<key>`. That last clause is knowledge of
the CLIs' current option sets, **not a measurement**. Review found **seven** bypasses of the first
list and **five** of the second (long-option abbreviation, a clustered short flag, a command-line
variable assignment, the double-dash form, pnpm's `--config.<key>`, Go's external linker), which is
this amendment's version of the WP-26 lesson above: a floor list is an enumeration and can be
incomplete, and the sandbox is the boundary.

**A project's `allow` narrows only the project-command verbs** (Q97, PROGRESS backlog 139): the
baseline's git, read-only and lockfile verbs and a stage layer's entries are not dropped by a project
that declares its test commands; a project removes one of those with `ask` or `block`.
