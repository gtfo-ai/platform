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
read-only and lockfile verbs are removed with `ask` or `block`, never by omission. **An organisation
layer that replaces the maximum is not composed on this build**: `organisationCommandMaximum` is
called only from `mergeProjectConfig`, which no production path calls, so an admin has no way to
set a stricter list today; when one is composed, the narrowing must be judged against *that* list
for the non-project verbs as well, or Q97's rule keeps a baseline git verb the organisation
removed — it can never reach a verb the
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
nobody enumerated reaches `allow`. The boundary for what such a line runs is the sandbox, as for the
script bodies above. A reviewer stage reading a hostile merge request
is the case this paragraph is written for: §1 keeps the *policy* on the default branch, and the
sandbox, not the list, bounds what the branch's scripts do.

**A residual this amendment accepts, stated rather than implied.** Discovery now runs an
**unreviewed** repository's `make` targets and package scripts at first contact (it has to, to
answer R1, R2 and R6), and the model credential is in that run's environment. Two paths out follow
from that and are not closed by the command list: the run's egress admits the git host, so a
`Makefile` can push to it with credentials of its own; and `npm run env` or `make -p` print the
environment into the transcript, which is redacted through the run's `secretEnvNames` rather than
never written. The bound on both is the sandbox — the container, the egress allow-list and the
redactor — and an operator onboarding a repository they do not trust should read this paragraph
before Step 2.
