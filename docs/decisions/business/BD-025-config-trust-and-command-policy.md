# BD-025 — Agent configuration is trusted only from the default branch; three-list command policy; no tokens in agent context

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** BD-021, BD-022, research/01 (claude-code-action security, Factory command lists, Symphony credential isolation, GitLab Duo composite identity)

## Decision
1. `.agentic/`, `CLAUDE.md`, `.claude/` and `.mcp.json` used by a run are read from the project's **default branch**, never from the task branch or an MR branch (an MR could otherwise change the rules that govern its own review). Changes to these files by a task are flagged in Code review.
2. Shell commands available to agents follow a **three-list policy**: allow-list (runs), ask-list (requires a human approval via question), block-list (never; resolved against the real binary, not the name). Defaults ship per stage; the organisation sets the maximum autonomy; projects can only narrow it.
3. Integration credentials never enter the agent's environment except narrowly scoped, run-lifetime tokens for git push to `agentic/*` and read-mostly CLI access; all mutating integration actions go through platform tools.
4. Actions in external systems are attributed to the bot identity **and** record the triggering human (composite identity) in the audit and in MR/ticket text ("Requested by").

## Consequences
- Round 2: implementation of the command policy (hooks/permission callbacks), token minting, config snapshotting from the default branch.

## Amendment (WP-54 — Q69 answer (ii), 2026-09-25)

**How §2's three clauses read.** *"Defaults ship per stage"* names a list that sits **below** the
maximum, not the maximum itself: each role's shipped baseline (`COMMAND_BASELINE_BY_ROLE` in
`packages/application/src/pipeline/planner.ts`) is the grant, the organisation maximum is the
**ceiling** a project's narrowing is judged against (`DEFAULT_COMMAND_POLICY`: a project's literal is
granted only if the maximum already allows it), and a project's `commands.allow` **narrows** the
baseline — only the project-command verbs, since Q97 (PROGRESS backlog 139); the baseline's git,
read-only and lockfile verbs are removed with `ask` or `block`, never by omission. **An organisation layer is composed since WP-63** (it was not when this amendment was written):
`organizations.settings.commands` is read, and a run's baseline is intersected with it for every verb
**before** a project narrows (`intersectWithOrganisationMaximum`), so a verb the organisation removed stays
removed whatever the project's `commands.allow` says — the case this sentence once warned of. Since WP-93 an
administrator writes that layer through `PATCH /api/org` (the organisation settings document, technical/12). A repository's own `.agentic/config.yml`
(the `repo` layer, Q94) is narrowed the same way: it can undo a UI list but never widen past baseline ∩
organisation maximum. A project, likewise, can never reach a verb the
role's baseline does not grant, and an entry it declares that the platform discards is reported (a
log line per run and `ignored_allow_commands` on the effective-configuration DTO), never dropped in
silence. This is Q69's answer (ii); before WP-54 the shipped default *was* the maximum and named no
test, lint, build or setup command, so no run of any role could execute one of its project's own
commands (PROGRESS backlog 49).

**The per-role baselines carry the project's declared commands as named verbs** (`npm test`,
`npm run *`, `pnpm test`, `pnpm run *`, `make *`, `pytest *`, `go test *`, `cargo test *` and their
other spellings) — never a `*` allow; every other line still falls to `ask`, which unattended denies.
**The body of `npm run *` and `make *` is repository content** — a task or merge-request branch can
change the `package.json` or `Makefile` it runs — and it is bounded by the run container, its
non-root user, its workspace-only writable mount and its egress allow-list (BD-021, TD-021), **never
by the command's name**. What the policy tries to bound is the model's own text reaching one of these verbs: the known
spellings that hand a project verb a command the model wrote — a `make` variable assignment or
`--eval`, `go … -exec`/`-toolexec`/an external linker, `cargo … --config`, npm's and pnpm's
`--script-shell`, `--node-options` and `--config.<key>` — are floored at `ask` (`HAZARDOUS_ARGUMENTS`;
TD-027's WP-54 amendment has the list). **That floor is an enumeration of known spellings, not a
boundary**: WP-54's two review rounds found seven and then five spellings past it, and a spelling
nobody enumerated reaches `allow`. *The same holds for the floors on flags that write a path the model chose, or read the run's own arguments out of a file (WP-104, WP-120: `--basetemp`, `--junitxml`, `--debug`, `--log-file`, `--rootdir`, `-o`, `-c`, `@<file>`, `--cov-report=<kind>:<dest>`, go's `-o`, profile, trace and `-pkgdir`/`-debug-*` outputs and the test binary's `-test.testlogfile`, `-test.gocoverdir` and `-test.fuzzcachedir`, `cargo --target-dir`). They are an enumeration, a tool's next such flag is not covered, and a configuration file pytest locates from its arguments (`pytest sub/` reading `sub/pytest.ini`) is the repository-content route this decision already accepts.* The boundary for what such a line runs is the sandbox, as for the
script bodies above. A reviewer stage reading a hostile merge request
is the case this paragraph is written for: §1 keeps the *policy* on the default branch, and the
sandbox, not the list, bounds what the branch's scripts do.

**A residual this amendment accepts, stated rather than implied.** Discovery now runs an
**unreviewed** repository's `make` targets, package scripts and (since WP-64) its `./.agentic/workspace/setup` script, by that literal path, at first contact (it has to, to
answer R1, R2 and R6), and the model credential is in that run's environment. Two paths out follow
from that and are not closed by the command list: the run's egress admits the git host, so a
`Makefile` can push to it with credentials of its own; and `npm run env` or `make -p` print the
environment into the transcript, which is redacted through the run's `secretEnvNames` rather than
never written. The bound on both is the sandbox — the container, the egress allow-list and the
redactor — and an operator onboarding a repository they do not trust should read this paragraph
before Step 2.

## Amendment (2026-10-03 — the founder's answer to Q98 (b)) — an opt-in static run credential where the provider cannot mint

§3 admits into a run only *"narrowly scoped, run-lifetime tokens"*. GitLab.com Free cannot mint one
(project access tokens need Premium there, research/10's 2026-09-25 addendum), so on that tier no stage
can check out a private repository and no writing stage can run at all. **The founder chose an explicit,
opt-in fallback**: an operator may declare, per git integration, a **static run credential** — a
dedicated, low-privilege token created for the platform (on GitLab: the personal access token of a
dedicated user who is a member of **only** the bound project, with the **Developer** role, scopes
`read_repository` + `write_repository`, a short expiry). It is handed to a run exactly where a minted
token would be and nowhere else. §3 is read with this exception:

- it is **opt-in and named** (`run_credential: static` on the integration, the token in its own secret
  field `run_token`); the default stays `minted`, and nothing falls back to it silently;
- it is **never the binding's own API token** (refused when the two are equal), and the platform never
  uses it for its own provider API calls;
- it is **narrowly scoped by the operator, not by the platform**: the platform states what it cannot
  verify, and the **protected default branch** remains the enforcement for pushes (Q40);
- it is **not run-lifetime**: there is no per-run revocation, so a token the agent exfiltrates (within
  the run's egress, which admits the git host) lives to the expiry the operator set. The operator guide
  and the first-test runbook say so beside the setting.

The mechanism is TD-028's amendment of the same date; the work is plan row WP-137.

## Amendment (2026-10-04 — the founder's follow-up to Q98 (b)) — the operator chooses which static run credential, including their own

The founder: *support either option and let the admin decide.* §3's exception of 2026-10-03 now admits
three operator-chosen forms, each opt-in and named on the git integration, none ever the binding's own
API token: **(i)** a dedicated low-privilege user's token (as amended 2026-10-03); **(ii)** the
**operator's own** personal access token, provided it carries **repository scopes only** — the platform
proves it cannot call the API and refuses it otherwise, and the **protected default branch with push "No
one"** is the push control the platform checks, because such a token reaches every repository its owner
can; **(iii)** a **project SSH deploy key with write access**, whose private key the platform keeps and
never places in a run container (the run asks the platform to sign). The losses of each are stated beside
the setting in the operator guide and the first-test runbook. The mechanism is TD-028's amendment of the
same date; the work is plan rows WP-141 and WP-146.

## Amendment (2026-10-05 — the product owner's request from the first local test) — a project may hand its verification to CI

The product owner, after the first local test on a PHP project: *"we should be able to configure [the
project to] rely on and check CI status only, instead of the agent trying to run tests."* Measured on
that test: a run container is 2 CPUs and 4 GiB (`packages/infrastructure/src/workspace/spec.ts`), the
project's static analysis was OOM-killed after 36 s inside it, and the project's own CI already runs
its tests and static analysis on every merge request, which the CI gate waits for (WP-136). PROGRESS
backlog 460.

**Decision.** A project setting, `verification.mode`, `local` (the default — every build before this
amendment) or `ci`. Under `ci`:

1. **Commands only narrow.** The three lists that carry *running the project* into a run's baseline —
   the project's declared commands (`PROJECT_COMMAND_ALLOW`), the lockfile installs that serve them
   (`LOCKFILE_INSTALL_ALLOW`) and the documented setup script (`WORKSPACE_SETUP_ALLOW`) — move from
   `allow` to **`block`** in every role's baseline (`CI_VERIFICATION_BLOCK`, `withVerificationMode`),
   before the organisation maximum and the project layers narrow it. Nothing is allowed that `local`
   did not allow; the read and git verbs and a stage's or a skill's additions are untouched.
   **`block`, not the `ask` fallback**, for two measured reasons: the unattended approval port denies an
   `ask` with *"do the work another way"*, which invites another spelling of the same test run, while a
   block is refused at the hook naming the pattern; and the block list matches generously, so a
   `make test` handed to `sh -c` or `env` is still refused. It is also the one list no later layer can
   shrink, so a project's `commands.allow: ["npm test"]` cannot re-grant what the mode took — it is
   reported in `ignored_allow_commands` instead. A runner no shipped list ever allowed
   (`vendor/bin/phpunit`, `npx jest`) stays on the `ask` fallback, which an unattended run denies.
2. **The platform says so.** Every run whose role holds `Bash` gets one platform-written section,
   `## Verification`, in layers 1–3 (`VERIFICATION_PROMPT`, a closed set of literals like
   `STAGE_PROMPT_FOCUS`): do not run the suite, static analysis, linters or builds; the CI gate runs them
   on the merge request, and a red pipeline returns the task to the Developer with the failing job's log.
   It states that it **replaces** the steps of a role prompt or a skill that say *run the project's
   checks*, so no role prompt changes and `ROLE_PROMPT_VERSIONS` does not move; `promptVersion` does,
   for exactly the runs it changes. Discovery gets its own text (below).
3. **Discovery reads R1, R2 and R6.** They are answered from the CI configuration and the documentation
   (a CI job that runs the suite; a job timeout or documented duration under 15 minutes; one documented
   setup command), and the readiness record prefixes the model's evidence with the platform's own
   sentence (`detectionOnCi` on each row), keyed on the mode the run was **planned** with (its settings
   snapshot) — so the record says *read, not run* whatever the model wrote.
4. **The CI gate is unchanged.** It runs in both modes; under `ci` it is the verification.

**Where the key may be written.** `PUT /api/projects/:id/config` (the settings page has a control) and
`.agentic/config.yml`. The repository file is graded **tighten-only** for this key: it may move a
project to `ci` — merge rights could already block the same commands with `commands.block` — and never
back to `local` over a `ci` setting, which is reported in the reading's `not_applied`.

**Why a top-level `verification` and not a `commands` or `policies` key.** It is not a list of command
patterns (it changes the prompt and the readiness detection too), not a policy a reviewer is held to,
and not a BD-028 feature (it turns on no agent work). `verification.mode` names the subject — where the
project's checks run — and leaves room for a later key beside it without overloading `commands`.

## Amendment (2026-10-05 — the product owner's decision from the first local test) — an unsuccessful Developer run's unfinished work is saved to its branch, and the retry continues from it

On the first local test (Autix, ticket AUT-6820) the Developer stage's run ended `failed` /
`error_max_turns` after 201 turns and 26 minutes, having made about forty-five edits and written four
new files. Nothing was committed or pushed, `tasks.branch` stayed `null`, the task went to
`needs_human`, and a retry provisioned a fresh checkout of the default branch: the work was lost and
the next attempt paid for the same exploration again. PROGRESS backlog 467.

**Decision — "save WIP, retry continues".**

1. **Whose work.** A Developer run of an ordinary task (`runs.mode = normal`) at any stage but
   `conflict_resolution`, whose checkout is a branch inside this decision's `agentic/*` namespace
   (`unfinishedWorkBranchFor`). `conflict_resolution` is excluded: its branch already carries an open
   merge request, and a `wip:` commit of a half-resolved merge would put conflict markers on the
   merge request under review, while what it loses is one `git merge` the next attempt repeats.
2. **Which endings.** `error_max_turns`, `error_max_budget_usd` that did not keep an artifact (one that
   did is `completed`, BD-010's 2026-10-05 amendment), `error_max_structured_output_retries`,
   `error_during_execution`, `timed_out`, `stalled` and `crash` (`SAVED_UNFINISHED_WORK_REASONS`). Not
   saved: a success; a person's cancel (a cancel is *throw it away* — the take-over is *keep it*); a
   take-over (exported by its own request); `shutdown` (the runner hands the stage back to start again
   by itself, and an export would lengthen a SIGTERM — discovered work in backlog 467); `permission_denied`
   (a person reads the refusal before the tree goes anywhere); `lease_expired` (no process holds a
   workspace to ask).
3. **How.** Exactly as the take-over exports: the process holding the workspace commits the tree and
   pushes the task's `agentic/<key>` branch with the **run's own** minted credential, never the
   platform's, through the same launcher verb (`POST /v1/runs/<id>/end` with an export) and the same
   helper (`exportScript`) with every guard it applies — the run container stopped first; a `.git`
   that is not the directory the platform cloned, a nested repository or an unreadable tree refused by
   name; no git configuration the run wrote read; no hook run. One flag differs, `onlyIfChanged`: the
   helper commits and pushes **only when the tree changed** — uncommitted edits, untracked files, or
   a head the project's mirror does not hold — so an attempt that changed nothing pushes nothing. No
   tarball and no longer retention: the branch is where the work goes, and the volume keeps its
   ordinary three days as the copy of last resort when the push fails.
4. **The commit message** is product/19 §7's second permitted `wip:` commit:
   `wip: unfinished attempt <n> of <stage> (<terminal reason>)` — platform text over a closed
   vocabulary. The content the run wrote passed the write-time path guard (protected paths and
   secret-shaped content) when it was written, as a take-over's does; the CI gate's tamper check judges
   the branch afterwards as it judges any push.
5. **What is recorded.** The workspace's answer — `{branch, commit_sha, pushed}` — goes to
   `runs.saved_work` (migration 0083), to `run.failed`/`run.finished`'s `saved_work`, and, for a push
   that succeeded, to `tasks.branch` when it was `null` (through `save`, the column's owner). **A push
   failure never changes the run's terminal outcome**: it is logged, and recorded as `pushed: false`.
6. **The retry continues.** A Developer run of the same stage is planned on the task's branch (it
   always was, WP-138), and when the latest ended run of that stage saved work that reached that
   branch, its prompt gets one platform-written sentence after the stage line (`previousAttemptLine`):
   the previous attempt ended `<reason>` after N turns, its unfinished work is a `wip:` commit on the
   checked-out branch, read it (`git log`, `git diff` against the default branch) and continue from it.
   **The `wip:` commit is left as it is** — the Developer's command policy has no `git rebase` or
   `git commit --amend` to squash it with, and a merge request is reviewed as a diff.
7. **What a person sees.** The run page says *Unfinished work saved: pushed to `<branch>` at
   `<sha>`* (or that the push did not succeed and where the work still is); the task page's run list
   marks the run *work saved to branch*; and the escalation's blocker brief says the work was saved
   and that a retry of the stage continues from that branch.

**Residuals, stated.** The fake-Claude e2e proves the platform's half end to end with a launcher seam
that answers as a successful push; the commit and the push over a real daemon are the Docker
provider's and the launcher's own tiers, and the `onlyIfChanged` lines were measured against a real
git (PROGRESS backlog 467). A launcher of an earlier build refuses the new `onlyIfChanged` field on
its strict end-request schema, so a mixed-version pair would fail that run's end request and leave
its container to the orphan pass (TD-028 decision 12); the shipped images are built together.

## Amendment (2026-10-06 — the product owner's decision from the first local test) — an unattended run runs its `ask` commands in the sandbox

The product owner: *"it always runs in automode because of unattended … we will never wait for
permissions so it runs in sandbox/automode."* The design was left to the orchestrator. Until this
amendment §2's `ask` list reached `canUseTool`, which in this build has nobody to ask and denied every
call with *"this instance cannot ask a human for approval yet (no Question surface is bound to a live
run)"* — and the first local test's discovery run read that as *"no network"* and wrote it into its
knowledge pages. PROGRESS backlog 480.

**Decision.**

1. **An unattended run treats a command-policy `ask` as `allow`**, because the run is sandboxed: a
   container per run, the workspace its only writable mount, egress only to the model host, the
   project's git host and the registries an operator declared, a run-scoped credential answered for
   the project's git host only, the block list, the write tools' path guard (workspace, `.git`,
   protected paths) and the write-content secret scan all still apply, and the CI gate's tamper check
   judges a protected path the branch changed whichever tool changed it (BD-024). Every `ask` that ran
   this way leaves a transcript `hook` row, `decision: allow`, reason
   *`unattended: ask allowed in the sandbox (matched "<entry>")`* (or *`(no list matches it)`*, or
   *`(a redirection writes <path>)`*), so the audit shows exactly what ran under the rule.
2. **Never loosened.** `block` stays `deny`. A line the scanner is **uncertain** about stays `deny`
   (§2's rule 5 is not weakened into allow). A **hazardous argument** of the `command` kind (it hands
   a verb a program or configuration the policy has not read — `--upload-pack`, `make --eval`,
   `npm --script-shell`, `pytest -c`) or the `trust` kind (it widens what a verb trusts — a refspec to
   a ref of its own choosing, `--no-verify`, `git merge -s ours`/`-X`, an unread package index) stays
   `deny`. A `path` hazard (a flag that writes a path — `--junitxml`, `go test -coverprofile`) runs,
   like any other write in the workspace.
3. **The git boundary is a hard carve-out, `deny` in every mode and applied to `allow` as well as to
   `ask`**, because the git host is the one place the sandbox can reach that holds other people's
   data. Refused: a `git push` that is not `git push [-u] origin agentic/<branch>…` with every branch
   named literally (no bare push, no `HEAD`, no `src:dst`, no `--tags`/`--all`/`--mirror`/
   `--follow-tags`, no `-o`/`--push-option` — `ci.skip` would skip the CI gate's pipeline — no
   `--force-with-lease`, no `--repo` other than `origin`); a fetch, pull or `ls-remote` naming a URL
   or a remote other than `origin`, `--multiple`, `--recurse-submodules`; `git clone` of anything but
   a local path, or with `--template`, a guarded `-c` or `--recurse-submodules`; `git remote add|
   set-url|rename`; `git config` **writing** a remote, a URL rewrite (`url.*.insteadOf`), a credential,
   an HTTP header or proxy (`http.*`), a transport (`protocol.*`), an SSH command, a proxy or askpass
   command, `core.fsmonitor`, a hook path, an alias, `push.*`, an include, a submodule source or a
   branch's remote — or `--edit`; the same keys through `git -c`/`--config-env` and through the
   environment (`GIT_CONFIG_*`, `GIT_SSH*`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_PROXY_COMMAND`,
   `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_DIR`, `GIT_WORK_TREE`); `--exec-path=`, `--git-dir`/
   `--work-tree` on a remote verb; `git credential*`, git's remote plumbing (`send-pack`, `fetch-pack`,
   `remote-*`, …), `archive --remote`, `submodule` other than `status`/`summary`; anything naming the
   control mount `/ctl` (the credential and ssh-agent sockets, the shim's socket and token) or the
   `agentic-runlet` helper; a write into `.git`, `~/.gitconfig` or `.git-credentials` by anything
   other than git; and a command whose **name** is computed when it runs (`$X …`, `$(…) …`). Every
   fragment is judged through every wrapper the scanner knows (`env`, `sh -c`, `eval`, `xargs`, lists,
   pipes, subshells, substitutions, quoting, `git -C`/`-c`).
4. **The setting has a safe shape**: `commands.unattended: auto | deny`, default `auto`, in the
   organisation settings, the project settings and `.agentic/config.yml`. It only tightens: `deny` from
   any layer wins (the organisation can force it; a repository file may choose it and never undo it,
   which is reported in `not_applied`). Under `deny` every `ask` is refused, which is how every run
   behaved before this amendment. **Under `auto` an `ask` entry a layer writes is no longer a way to
   stop a command**: a project that wants a command not to run writes it in `block` (§2's
   *"projects can only narrow it"* holds for `block`; a narrowed `allow` now only decides what is
   audited as an `ask`).
5. **The refusal says what failed and where to go.** A deny names the fragment and the rule (the
   block-list entry, the hazard, the git boundary's reason, the construct the scanner could not follow,
   or the `deny` mode), says it is the platform's command policy and not a network or sandbox failure,
   and points at the Read tool with offset/limit, Grep and Glob, and one command per call. A block
   still reads `command policy: block — …`.

**What changes for `verification.mode: ci`** (the 2026-10-05 amendment): its blocks are unchanged and
match through every wrapper, but a runner no shipped list names (`vendor/bin/phpunit`, `npx jest`) was
refused as an `ask` and now **runs** under `auto`; the `## Verification` prompt section is what keeps
the model from it, and a project that must stop it writes it into `commands.block`.

**Dependency additions** (`npm install <pkg>`, `pnpm add`, `pip install <pkg>`, `composer require`) now
run under `auto`. product/04:58's dependency policy is still applied — **to the diff, afterwards**: the
dependency gate (`packages/application/src/pipeline/dependency-gate.ts`, WP-38) fires when the
Developer stage completes, reads the merge request's manifest changes and allows, asks (a question
with licence and maintenance status) or returns the task. What it does not see is a package installed
without a manifest change (`npm install --no-save`, a bare `pip install`) or by a role that pushes no
diff; that package lives and dies in the run's container. A registry is reachable at all only when an
operator declared it and the run may install from a lockfile (`runMayInstallFromLockfile`).

**What the git boundary is not, stated.** It reads the command line, and under `auto` an unmatched
command runs — so an interpreter (`python3 -c '…subprocess…'`) or a script the run wrote can spell any
refused git command where no pattern sees it. The control that holds whatever the spelling is the
credential: the run's credential helper asks the shim, and the runner answers **only for the project's
git host, by exact comparison** (`RunCredentialBroker.answer`), only while the run is live. It does
**not** compare the repository **path** — git sends none to the helper unless `credential.useHttpPath`
is set — so a credential that reaches other repositories on the same host (a dedicated user's or the
operator's own static token, this decision's 2026-10-03/04 amendments) reaches them from a spelling
the boundary does not read. A minted project access token and a deploy key are scoped to the project
by the provider. Path-scoping the helper is PROGRESS backlog 481.
