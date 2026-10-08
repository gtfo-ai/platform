# TD-029 — Ticket lifecycle slots live on the task-management binding; one claim before admission; one human-return window over four signals; review threads found again by marker

- **Status:** accepted
- **Date:** 2026-10-08
- **Deciders:** architect, session 15 (the product rulings it builds are BD-031's, decided by the product owner on 2026-10-08)
- **Relates to:** BD-031, BD-007, BD-008, BD-017, BD-022, BD-023, BD-025, BD-027, TD-003, TD-004, TD-005, TD-012, product/04, technical/02, /03, /06, /12, PROGRESS backlog 535, 536, 537, 538, Q118, WP-170…WP-183

## Context

BD-031 states what the product does. This record decides how, against code read at `516d9044`:

- `status_mapping` is a free record from a task state or stage id to a status name in
  `.agentic/config.yml` (`packages/contracts/src/config.ts:940-958`). `statusMappingHandler` applies
  it on seven task events through the `status` duty (`packages/application/src/pipeline/workpad.ts:95-105`,
  `:262-274`, `:324-366`).
- The pick-up rule lives on the Jira **binding**, where `pickup_status` wins over `pickup_label`
  (`packages/integrations/src/providers/jira-cloud/config.ts:53-59`). It is written by
  `PUT /api/projects/:id/bindings` (`apps/server/src/routes/onboarding.ts:802`). No screen edits it or
  `status_mapping`.
- `transition` takes a **target status name**. The Jira adapter resolves the transition by
  `transition.to.name` (`jira-cloud/index.ts:837-920`, `:1444-1453`). So backlog 535's worry, that it
  might match a transition label, is already answered in the code.
- The port has no read of statuses, transitions or comments, and no assign
  (`packages/application/src/ports/integrations/task-management.ts:297-392`). The binding's own account
  is fetched with `GET myself` inside the adapter only (`jira-cloud/index.ts:520-529`).
- The review window returns a `ready_for_merge` task only for **resolvable, unresolved** threads that
  hold a person's note (`packages/application/src/pipeline/review-threads.ts:104-105`,
  `packages/application/src/pipeline/jobs.ts:1539`). GitLab lists a general note as its own discussion,
  and the adapter maps it to `resolvable: false` (`packages/integrations/src/providers/gitlab/provider.ts:531-541`).
  So a general note arms the window (`saga.ts:1651-1690`) and is then dropped. A ticket comment reaches
  only ask-the-task (`packages/application/src/ask/commands.ts:239-259`), and `ticket.status.changed` is
  declared unconsumed (`packages/application/src/events/consumption.ts:214`).
- Review-only mode already posts findings with path and line, plus a summary, through
  `IntegrationActionExecutor` (`packages/application/src/pipeline/review-only.ts:929-1021`).
  `replyToDiscussion` and `resolveDiscussion` exist on the GitLab adapter
  (`gitlab/provider.ts:1049-1075`) and have no caller.

Vendor facts are in `docs/research/15-tracker-lifecycle-and-mr-conversation.md`.

## Decision

1. **The slots live on the task-management binding**, in a `lifecycle` block of the binding's
   configuration overlay, beside `pickup_status` and `pickup_label`. One schema, `ticketLifecycleSchema`, is
   defined in `packages/contracts`, and every task-management provider's binding schema embeds it:
   `{in_progress?, in_review?, approved?, qa?, returned?: string[] (≤ 10), done?, claim?: boolean,
   take_assigned_tickets?: boolean}`. **`pick_up_from` is `pickup_status`**: the same field under its
   product name, so intake (the normaliser and the poll's JQL) keeps reading the one place it reads
   today. Why the binding and not `.agentic/config.yml`: the names belong to the tracker, not to the
   repository. They change when the binding changes, the provider's schema can validate them, and intake
   already reads the binding. A status name is compared case-insensitively, as `transition` already does
   (`jira-cloud/index.ts:1423-1424`).
   - **Validation at save** (`PUT …/bindings`): the single slots are pairwise distinct and distinct from
     `pick_up_from`; `returned` is disjoint from all of them; and every named status is in the
     provider's loaded set (decision 2), read through the executor. A name outside the set is
     `422 lifecycle_status_unknown`, naming the slot and the name. An unreadable provider is
     `503 lifecycle_statuses_unavailable`, and nothing is saved, because a mapping that was never checked
     is the failure ruling 7 exists to prevent.
   - **The claim switch:** `claim` defaults to **true when a `lifecycle` block is present**. A binding
     written before this milestone has no block, so it neither claims nor skips assigned tickets and
     behaves exactly as today (BD-031 ruling 2, and the e2e flow (iii)). The setup surface writes a block
     for every project it saves, so a project set up from now on claims unless a maintainer turns it off.
     This reconciles ruling 5 (the platform claims) with ruling 2 (a project with nothing mapped behaves
     as today).
2. **Port additions** (technical/06): `listStatuses()` → `{id, name, category: todo | in_progress |
   done | unknown, raw_category}`, the union over issue types; `listTransitions(ref)`; `selfIdentity()`;
   `assignToSelf(ref)`; `unassign(ref)`, which unassigns only if the assignee is the binding's own account
   and otherwise answers `changed: false`; and `listComments(ref, {since, limit})`. Reads are plain reads.
   `assignToSelf` and `unassign` are mutations through the executor. Capabilities declare each one. An
   adapter that cannot implement one throws `IntegrationError('unsupported')` **naming the method**, and
   the shared contract suite asserts both branches. Jira uses research J1, J3, J4, J5 and J6, never J2.
   The git port gains no method: its `listDiscussions` contract is tightened so that a general note is
   listed as its own discussion whatever `resolvable` says.
   > **Amendment, as built at WP-171 (2026-10-08):** no `IntegrationError('unsupported')` exists; the refusal is the port's existing `IntegrationUnsupportedError(provider, member)`, code `unsupported_capability`, with `action` set to the member's name, which is how "naming the method" is asserted (technical/06, "As built at WP-171").
3. **Relation to `status_mapping`.** When a binding maps any slot other than `pick_up_from`, the slots are
   the project's ticket lifecycle and **`status_mapping` is not applied at all**. The effective-config
   read publishes `status_mapping_superseded: true` and a warning. A project with no slot mapped applies
   `status_mapping` exactly as today. One writer per moment means no ordering between two queued duties
   to reason about.
4. **When each slot is written.** All transitions go through one `pipeline.outbound` duty,
   `ticket_lifecycle` (notification-shaped in `JOB_EXHAUSTION`). It is never called inside a transaction,
   and it targets the status, never a transition label.
   - `in_progress`: at the claim (decision 5), and on every entry into a developer-role stage
     (`implementation`, `conflict_resolution`).
   - `in_review`: on entry into `code_review`.
   - `approved`: on `task.stage.completed` with verdict `approve` of the **last enabled agent review
     stage**. That is `business_review`, or `code_review` where the task's template or dial disables business
     review. It is never written on re-entry into a gate, so a default-branch move cannot pull a ticket
     back out of QA.
   - `qa`: on entry into `qa`.
   - `done`: on entry into `merged_gate`. A merge is the fact the tracker records, and the retrospective
     is the platform's own business, so product/04 S9's *ticket → Done* moves here.
   - `pick_up_from`: at release (decision 5).

   An unmapped slot writes nothing, and the stage runs. A failed write does not block the stage. It
   leaves its audit row and a `warn` log naming the slot.
5. **The claim.** It happens in the `stage.execute` job, between its transactions, before any **agent**
   run is admitted, beside `ensureTicketSnapshot` (`packages/application/src/pipeline/jobs.ts:753`).
   Gates claim nothing. `ensureTicketClaim` acts when the task has a ticket and a claiming binding, and
   its claim is absent or stale. It runs four steps:
   1. read `selfIdentity`;
   2. `assignToSelf`;
   3. `transition` to `in_progress` if that slot is mapped;
   4. re-read the ticket.

   An assignee other than the binding's own account escalates the task to `needs_human` with reason
   `ticket_assigned_elsewhere` and posts one ticket comment, opened by the marker
   `agentic:claim-refused:<task>`. No run starts. A refused assign (no *Assign Issues* permission)
   escalates with `ticket_claim_failed` and a brief that names the permission. In shadow mode the writes
   are `would_have`, and the claim is recorded as `shadow`, not confirmed.

   The record is `tasks.ticket_claim` (migration **0088**), written only by the claim and release
   functions through a narrow method. Two events record it: `ticket.claimed` and `ticket.claim.refused`.
   A human return (decision 7) marks the claim stale in the return's own transaction, so the next agent
   admission re-claims.

   **Release** is a `ticket_release` duty, on `task.cancelled` and on the person's *Rework* command
   (`reworkStageCommand`, `packages/application/src/pipeline/commands.ts:1343`). It unassigns (only when
   the assignee is still the binding's own account) and transitions to `pick_up_from` if that is mapped.
   It records `ticket.released`. An escalation and a take-over keep the claim.

   **Intake skip:** `runIntakeCheck` already reads the ticket before inserting the task
   (`saga.ts:429-435`). On a claiming binding, an assignee who is neither nobody nor the binding's own
   account creates no task unless `take_assigned_tickets` is true. Instead it records
   `ticket.intake.skipped {reason: 'assigned'}`. A webhook-only binding re-matches only when the pick-up
   rule fires again; the poll re-matches on the next update. This is stated in the setup guide.
6. **Whose note is it.** A note or ticket comment belongs to the **platform** when it opens with a
   platform marker. On the merge request that is `isPlatformNote` (`review-threads.ts:70-88`). On a ticket
   it is `marker_id`, or `PLATFORM_COMMENT_MARKERS` (`packages/domain/src/ask/ask.ts:135`). A system note
   belongs to nobody. **Every other note is a person's**, whatever its `resolvable`, `resolved` or `type`.
   The decision is **never** made by author, because a binding may be authenticated with a person's own
   account (the first local test's was), and an author check would then silence that person (Q118). Every
   platform write path opens its body with a marker. A census in the application tier holds that, so
   *agent-written notes never trigger a return* is a checked property and not a hope.
7. **One human-return window.** It covers the human stages `qa` and `ready_for_merge`. The `mr.comment.debounce`
   queue and its 2-minute window (BD-007) are kept. The window is now armed by `mr.review.comment`,
   `ticket.comment.added`, `ticket.status.changed`, and `ticket.updated` whose `changed_fields` names the
   status. When it fires, it re-reads three things: the ticket's status, the merge request's discussions
   and the ticket's comments. Its **horizon** is the start of the task's latest `implementation` run.
   That includes words written while the agent's review stages ran, and it does not reset when a gate
   re-enters the human stage.
   - **Return** when the status is in `returned`, or is the `in_progress` or `pick_up_from` status, or
     when a person's non-acknowledgement word (decision 8) is newer than the horizon.
   - **Feedback** is every person's word newer than the horizon, from both the merge request and the
     ticket. Each is redacted, collapsed to one line and tagged by the platform (`[mr thread N]`,
     `[mr note N]`, `[ticket comment N]`, `[status]`), and bounded as `review-threads.ts` bounds today
     (`:21-41`). A status-only return carries platform text instead: it names the status, tells the agent
     to read the conversation (`get_conversation`), and to ask a question if it finds nothing to fix.
   - **The interpreter signal stays `mr.review.comment` for every form.** Per-task template snapshots
     (TD-003) of tasks in flight already carry that edge from `ready_for_merge`. The forms that caused
     the return are recorded in a new `task.human_return` event, appended in the same transaction. The
     return spends `human_rounds` (BD-008).
   - At an **agent** stage, nothing returns. The words reach the next run through the context pack and
     the tool (decision 11).
   - A **status signal at an agent stage** is logged and ignored. That includes the echo of the
     platform's own `in_progress`, which arrives after the task has left the human stage.
8. **The acknowledgement rule.** It is pure, in `packages/domain`, and tested in both directions. A
   word is an acknowledgement when, after Unicode NFKC normalisation, lower-casing, and removal of
   @-mentions, punctuation and whitespace, it is **empty** (emoji only, mentions only) or **every**
   remaining token is in the acknowledgement vocabulary, and its original length is at most 80
   characters. The shipped vocabulary is English: `thanks`, `thank`, `you`, `thx`, `ty`, `lgtm`, `ok`,
   `okay`, `+1`, `great`, `nice`, `cool`, `looks`, `good`, `approved`, `perfect`, `done`, plus the
   emoji 👍 ✅ 🎉 🙏. A project **adds** words in its own language through the
   settings key `human_returns.acknowledgements`. It can never remove the shipped ones, and the key is
   graded *not applied* when it comes from the repository file, because an added word loosens what the
   agent is held to (technical/12). *"Looks
   good, but rename X"* is not an acknowledgement. **The failure direction is chosen:** an
   acknowledgement the rule does not recognise returns the task, which costs one run and at most one
   question. A request misread as thanks would be lost. A model classifier was rejected because it
   cannot be tested exhaustively and spends money on every comment.
9. **The `qa` stage's shape.** It is a `kind: 'human'` stage in the shared merge tail, declared
   `enabled: false` between `rebase_gate` and `ready_for_merge`. `rebase_gate.pass_to` becomes `qa`, and the
   interpreter's walk over a disabled target lands on `ready_for_merge` exactly as before
   (`packages/domain/src/pipeline/interpreter.ts:403`). Its `on` edges:

   | Event | To |
   |---|---|
   | `mr.review.comment` | `implementation` (every return form, decision 7) |
   | `ticket.status.changed` | `ready_for_merge` (a pass) |
   | `default_branch.moved` | `rebase_gate` |
   | `mr.merged` | `merged_gate` |

   A **pass** is the ticket leaving the `qa` status for a status that is not a return status (decision 7).
   QA after the rebase gate means a person tests a branch that already applies.

   **Whether a task has the stage is frozen** at creation in `tasks.qa_stage` (migration 0088), set when
   the binding maps `qa`. Every compile site passes it beside the dial, and the compile-sites census
   holds that no site asks the settings port. A mapping changed mid-task does not reshape a task in
   flight.

   `RETURN_LOOPS` gains `qa → human_rounds`. The merge request stays a draft through `qa` and is
   marked ready at `ready_for_merge`, as product/04 S7 says.
10. **The review conversation on the merge request.**
    - **Findings:** after `code_review` completes, a `review_findings_post` duty posts each finding as a
      thread through the executor, anchored where both `file` and `line` are present. If GitLab refuses
      the anchor, the finding is re-posted at merge-request level with its location in the body. Then one
      summary note is posted. The body opens with `<!-- agentic:review-finding:<task>.<run>.<finding> -->`
      or `<!-- agentic:review-summary:<task>.<run> -->`. A finding id outside `[A-Za-z0-9._-]{1,40}` is
      replaced by its index. The executor's idempotency keys are `review_finding:<task>:<run>:<finding>`
      and `review_summary:<task>:<run>`. Rendering is shared with review-only
      (`review-only.ts:446-455`), never copied.
    - **Replies:** `ImplementationNotes` gains `thread_replies: [{thread_id, kind: fixed | documented |
      needs_person | not_changed, reply, person?}]`. After the developer stage completes, a
      `conversation_replies` duty validates each `thread_id` against a fresh `listDiscussions` and drops an
      unknown one with a log. It then replies with the platform marker `agentic:reply:<task>.<run>.<n>`,
      redacted and bounded. A `needs_person` reply opens with platform text naming the person the model
      named, and states that the platform has not done the action. A reply to a ticket-comment request is
      a ticket comment with the same marker.
    - **Resolution:** `ReviewVerdict` gains `resolved_threads: string[]`. A `review_threads_resolve` duty
      resolves only a named thread whose first note opens with this task's `review-finding` marker,
      never a person's thread.
    - Nothing here needs storage: threads are found again by marker, as `isPlatformNote` already does.
      Shadow mode and the dial apply as they do to every executor write. A dial level at which a stage
      does not run posts nothing for it.
11. **Every agent reads the conversation.** A read-only platform tool, `get_conversation`, answers the
    merge request's discussions (every note, from bots and people, with system notes left out and
    platform notes labelled `platform: true`) and the ticket's comments. They are redacted, bounded
    newest-first and presented oldest-first, and each carries its `thread_id` or comment id. The planner
    adds a `conversation` data block to every agent stage's prompt for a task with a merge request or a
    ticket. It is bounded, its truncation is announced on the marker (never in the body), and it lists the
    `thread_id`s that decision 10's replies and resolutions must use. Both are untrusted data (BD-022).
12. **Two installations sharing one service account** are **filed, not built**, as PROGRESS backlog
    **538** (minor). The assignee settles every case BD-031 names: a person; two projects bound with
    different accounts; two installations with different accounts. The shared account is the one case it
    cannot settle, and it is an operator's choice that the setup guide advises against. A label naming
    the installation interacts with label pick-up rules (`pickup_label`), so it needs its own design.

## Rationale

- The binding already owns the pick-up rule and the provider's validation.
- A single writer per moment is easier to reason about than two duties racing on one ticket.
- The claim sits where the ticket snapshot is already read, outside a transaction and before admission,
  so it adds no new job shape.
- One window keeps BD-007's batching and BD-008's bound for all four forms.
- Markers rather than stored thread ids follow what review-only and the conflict warning already do
  (BD-012's *derived, not stored* in spirit).
- The acknowledgement rule fails toward running, which is the recoverable direction.

## Alternatives considered

- **Slots in `.agentic/config.yml` beside `status_mapping`.** Rejected because intake cannot read the
  repository file when it normalises a webhook, and status names would then live in two places
  (`pickup_status` on the binding, the rest in the repository).
- **Applying both `status_mapping` and the slots.** Rejected because two queued duties would move one
  ticket in an order the queue decides (`workpad.ts`'s ordering note).
- **Claim inside `intake_check`.** Rejected because a WIP-queued task would hold a ticket it is not
  working, and a returned task needs the same re-claim.
- **A table of review threads.** Rejected for now: markers are already the rule, and a table is a second
  source of truth to keep in step with the provider.
- **QA before the rebase gate.** Rejected: a conflict resolved after a person's QA would send the task
  back through QA. Placed after the gate, QA re-runs only on a branch move with conflicts.

## Consequences

- Migration **0088**: `tasks.ticket_claim jsonb null` and `tasks.qa_stage boolean not null default false`,
  plus the column-ownership partition (`packages/infrastructure/src/pipeline/tasks-column-ownership.test.ts`).
- New events: `ticket.claimed`, `ticket.claim.refused`, `ticket.released`, `ticket.intake.skipped` and
  `task.human_return`. `ticket.status.changed` gains its first consumer.
- New duties: `ticket_lifecycle`, `ticket_release`, `review_findings_post`, `conversation_replies` and
  `review_threads_resolve`, each declared in `JOB_EXHAUSTION`.
- Prompts change for every role (the conversation block), and for the developer and the reviewer
  (replies, resolutions). That needs eval cases and `ROLE_PROMPT_VERSIONS` bumps.
- Residuals, stated:
  - A binding on a person's own account claims as that person (Q118).
  - An unrecognised acknowledgement costs one run.
  - A webhook-only binding does not re-match a ticket that was unassigned.
  - GitLab's reply to an individual note remains **[unverified]**: WP-173 records the documented answer and a fallback to a new general note (divergence 8); the live check is in `docs/TODO.md`.
