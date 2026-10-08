# BD-031 — The tracker's lifecycle is the project's mapping: optional status slots, a claimed ticket, a human QA stage, every form of a human return, and the review conversation on the merge request

- **Status:** accepted
- **Date:** 2026-10-08
- **Deciders:** the product owner (rulings 1–7 below, decided on 2026-10-08); the architect, session 15, wrote them down and owns the technical choices in TD-029
- **Relates to:** BD-005, BD-007 (amended here), BD-008, BD-017, BD-022, BD-023, BD-027, product/04, product/06, product/17, TD-029, PROGRESS backlog 535, 536, 537, 538, Q118

## Context

The product owner's first local test (Autix, GitLab and Jira Cloud) showed three gaps, filed as
PROGRESS backlog 535, 536 and 537 with a worked example (one Jira site's 21 statuses, one ticket, one
merge request):

- The platform knows one tracker status at most, the binding's pick-up status. A project cannot say which
  of its statuses mean *in progress*, *in review*, *approved* or *QA*, cannot pick them from the
  tracker's own list, and has no human QA phase before merge.
- Nothing claims a ticket on the tracker, so a person, a second project or a second installation
  can work the same ticket in parallel with an agent.
- The code review's findings never reach the merge request, nothing answers or resolves a thread,
  no agent reads the merge request's conversation, and the human review in the example arrived as
  two **general notes** (`resolvable: false`) that the platform's review window does not count
  (measured by the architect's pass, PROGRESS § "Architect ruling (M10 head, session 15)").

## Decision

Decided by the product owner on 2026-10-08. These rulings override any contrary sentence in the
product and technical documents, which are amended to match.

1. **Status names are per environment.** No status or transition name is assumed anywhere: not in code,
   templates, defaults, prompts, or tests other than fixtures. Every name comes from the project's
   mapping, chosen from the statuses loaded from that tracker. One tracker's names are one example among
   many: another tracker may call the same phase *Waiting for review* or *Testing*.
2. **Lifecycle slots, every one optional.** A project maps named slots to its tracker's statuses:
   - `pick_up_from`: intake matches only this status. A label is still allowed instead, as today.
   - `in_progress`: set when the agent claims the ticket, and again when it picks a returned ticket back up.
   - `in_review`: set when the agent's code-review stage starts.
   - `approved`: set when the agent's review has passed and its findings are fixed.
   - `qa`: the human-in-the-loop phase.
   - `returned`: one or more statuses that mean *back to the agent*. A person moving the ticket from
     `qa` or `approved` back to the `in_progress` or `pick_up_from` status also counts as a return.
   - `done`: optional.

   The common flow is *backlog → in progress → waiting for review → approved → QA*. When a slot is not
   mapped, the platform makes no transition at that point and still runs the stage. A project with
   nothing mapped behaves exactly as today. Slots map to status **names**. The platform works out the
   transition into a status itself and never stores a transition label, because a tracker's transition
   labels can differ from its status names and can carry emoji.
3. **QA is a human stage before merge.** The merge request stays open during QA. The pipeline gains an
   optional human `qa` stage after the agent's code review and approval. It is active when the `qa`
   slot is mapped. It ends when the ticket moves on (approved by a person, then on to merge as today) or
   when the task is returned.
4. **QA, or any human stage, can return the task, and the agent picks it up again.** These four forms
   are one signal:
   - (a) a person changes the status to a `returned` status, or back to `in_progress` or `pick_up_from`;
   - (b) new merge-request diff discussions;
   - (c) new merge-request general notes, including notes with `resolvable: false`;
   - (d) new comments on the ticket.

   A return re-claims the ticket (`in_progress`) and re-enters implementation. Every human word since the
   last run goes in as return feedback, inside untrusted data blocks. The task then goes through the
   agent's code review again, then `approved`, then `qa`. A status change with no new comment still
   returns the task: the agent reads the merge request and ticket conversation to find out what to fix,
   and asks a question if it finds nothing. A comment on a task at a human stage returns it even with
   no status change. A pure acknowledgement ("thanks", "LGTM") does not return it. TD-029 decision 8
   is the rule, and it is tested. Notes the agents write never trigger a return.
5. **Claim.** Before the first run is admitted, the platform assigns the ticket to the binding's own
   account, moves it to `in_progress` if that slot is mapped, and re-reads the ticket. If someone else
   is the assignee, the task is refused with a named reason and a comment on the ticket, and no run
   starts. Intake skips a ticket that is already assigned to a person, unless the project opts in. On
   cancel or rework, the platform unassigns itself and moves the ticket back to `pick_up_from` if that
   slot is mapped. Two installations can share one service account; whether they need a label naming
   the installation is the architect's ruling, and it was **filed** as PROGRESS backlog 538 (TD-029
   decision 12).
6. **The merge-request conversation (537).** The code reviewer's findings are posted on the merge request
   as discussions, anchored to a file and line where the diff allows, plus one summary note. The
   developer's fix run replies on each thread it addressed. The reviewer resolves a thread only after a
   re-review confirms the fix. Every agent at every stage can read all of the merge request's notes
   (diff threads and general notes, from bots and people) and the ticket's comments. It reads them
   through a read-only platform tool and through the context pack, as untrusted data blocks (BD-022). A
   person's note may mix a code change, a documentation-only change, and an action only a person can
   take. The agent does the first two, and answers the third on the merge request, naming who must act
   and never claiming it is done. Every write goes through `IntegrationActionExecutor` and respects
   shadow mode and the autonomy dial (BD-027).
7. **Setup.** The task-management port gains a read of the project's statuses, each with its category,
   and a read of transitions. The wizard and the project settings offer the slots as pick lists, loaded
   from the provider and validated against the loaded set when saved. Every slot may be left empty. The
   readiness output lists unmapped slots as information, never as a failure.

**What a project must build against.** Jira (task management) and GitLab (git) come first. Every other
provider's adapter implements the new port methods, or refuses each one **by name with a contract
test**, never silently (BD-017).

## Amendment to BD-007

BD-007 says that *"every unresolved MR discussion thread opened by a mapped user generates an event"*,
and that the return is batched from **unresolved threads**. From 2026-10-08 a return at any human stage
(`qa` and `ready_for_merge`) is triggered by any of ruling 4's four forms. A general note counts whether
or not the provider calls it resolvable. The batching window is unchanged. Its unit is now every
person's word since the task's last implementation run started, not the open-thread count. The
human-rounds bound (BD-008) is spent the same way.

## Rationale

The tracker is where the team already works. A platform that cannot place a ticket in the team's own
statuses, or that lets two workers take one ticket, makes the team watch two boards. The product
owner's example shows a human review that the platform never heard: it was written in the form the
merge request's UI offers first, a general comment. "Be ready for everything" is the only rule that
survives a second team's habits.

## Alternatives considered

- **Fixed status names with per-tracker defaults.** Rejected by ruling 1: no two trackers agree, and a
  default that is wrong for a tracker fails at the first transition rather than at setup.
- **A QA state after merge** (backlog 535 (d)'s other option). Rejected by ruling 3: in the example, QA
  happened on the open merge request, before merge.
- **Return only on threads the provider marks resolvable** (today's window). Rejected by ruling 4(c).
  GitLab's own documentation contradicts itself on whether a general note is resolvable
  (`docs/research/15-tracker-lifecycle-and-mr-conversation.md` G2).

## Consequences

- product/04 gains the `qa` stage, the slots, the claim and the return forms. product/06 and product/17
  gain the setup step and the informational readiness line. technical/02, /03, /06 and /12 are amended
  (TD-029).
- An unrecognised acknowledgement returns the task. That costs one run and at most a question, never a
  lost request (TD-029 decision 8).
- A binding authenticated with a person's own account cannot tell the platform's claim from that
  person's own assignment. Q118 asks whether to require a dedicated account.
- Work: `technical/13-implementation-plan.md` § "Milestone M10", WP-170…WP-183, ahead of WP-163…WP-169
  by the product owner's priority.
