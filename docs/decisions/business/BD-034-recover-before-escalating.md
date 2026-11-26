# BD-034 — The platform recovers by itself before it escalates

- **Status:** accepted
- **Date:** 2026-11-26
- **Deciders:** the product owner
- **Relates to:** BD-008 (amends it), BD-010, BD-032, TD-031, technical/02, product/04

## Context
The product owner's rule, verbatim: *"If there is ANYTHING recoverable that agentic can solve, it must not escalate to a human."*

The incident that prompted it was fontai's GO-705 (goparking, GitLab MR !784) on 2026-11-26:

- **The CI gate.** The gate parked the task with *"the "ci_gate" gate could not be decided after 5 attempts: pipeline 19204 is running"*. Five checks 30 s apart give up after about 2 min, and the pipeline needed about 12. It then failed on ECS, a code-style fault that the `ci_fix` loop exists to fix. Commit 7f31c64c (WP-136, widened) bounded the CI wait by `ci_timeout_minutes` on every binding. That timeout still escalated a pipeline that was merely slower than it.
- **Refinement.** `refinement` ended `error_during_execution` with 0 turns four times while the worker was not ready yet. Every one of those runs parked the task, and the fifth attempt succeeded. Two paths in the platform produce that signature:
  - a start failure (`recordNotStarted`, wall time 0), which retried only three times 30 s apart when transient, and escalated at once otherwise;
  - a CLI that never reached the model (`recordUnsuccessful`), which escalated at once.

  Both transient cases are covered below. Which of the two GO-705 hit was not read from the production database for this decision.

Before this decision, the following conditions also parked a task, although each one ends by itself:

- every other gate after the same five checks (a provider computing mergeability, a custom gate waiting for its event);
- a provider outage at a gate after 60 minutes;
- a transport failure to start a run after three attempts 30 s apart;
- a `runner` stopped by a deploy for the third time in a stage;
- a usage limit for the second time;
- a lost worker for the second time.

## Decision
A task reaches *Needs human* only when the platform truly cannot make progress by itself:

- a decision only a person may take: an approval, a product question, a `reject` verdict, a template or configuration that is invalid, an autonomy-dial halt, a merge request closed or merged by a person;
- missing credentials or permissions;
- a budget cap (which **pauses** the task, BD-010);
- a loop that is really exhausted **after real agent attempts** (BD-008's iteration limits, CI convergence on three identical failures, review findings that did not change).

A transient or self-fixable condition must **wait, retry with backoff, or go to the agent loop that fixes it** (a failed pipeline goes to `ci_fix`, a conflict to the rebase loop). Where a bound is still needed to stop an endless loop, it is a **long time-based bound with backoff**, not a small attempt count. The brief of an escalation at that bound says exactly what was tried: how long, how often, and which runs.

As built on 2026-11-26:

| Path | Before | After |
|---|---|---|
| CI gate, pipeline still `pending`/`running` at `ci_timeout_minutes` | escalate | keep waiting, one read every 5 min, until 24 h from the gate's entry (or the timeout, if that is longer); a `manual` pipeline or no pipeline still escalates at the timeout |
| Any other gate answering "not yet" (rebase gate mergeability, custom `on`-event gate) | 5 checks × 30 s | time from the entry, backoff from 30 s up to 5 min: 60 min for a provider computation, 24 h for a declared event |
| Provider outage at a gate | 60 min (the CI gate: its CI timeout) | 24 h from the first failure (the CI gate: the later of that and its CI timeout) |
| Transport failure to start a run | 3 attempts, 30 s apart (≈1 min) | 8 attempts, backoff 30 s → 10 min (≈35 min) |
| Run ended before the model took a turn (`failed` / `error_during_execution`, the CLI's result reporting 0 turns) | escalate at once | re-plan the same stage entry, 1 → 16 min apart, 6 times (≈47 min), then escalate naming the runs |
| `runner` stopped mid-run (shutdown hand-back) | 2 hand-backs | 5 hand-backs |
| Usage limit ended the run | 1 re-plan | 3 re-plans |
| Worker lost the run's lease | 1 re-plan | 3 re-plans, each excluding the machines that lost it |

## Rationale
An escalation costs a person's attention and stops the task for hours, which is far more than another provider read or another offer of a run that never started. The conditions above end by themselves: a pipeline finishes, a provider answers again, a worker reconnects, a usage limit resets. Escalating them makes people watch the platform's infrastructure for it, and it hides the escalations that do need a person among ones that do not.

Money stays bounded. A gate read costs nothing, and a run that never started or never reached the model costs what the CLI measured, which is usually nothing. Every run that is re-run is charged as any run is, so the task's budget (BD-010) still caps the retries that do spend. A start that had already asked for its CLI but measured nothing is held at its reservation against the task cap (rule 16). A long series of those therefore ends in a budget **pause**, not an unbounded spend.

## Alternatives considered
- **Raise only the counts and keep the 30 s cadence.** Rejected because a count tuned for one provider's latency is wrong for the next one. A time bound measured from the stage entry survives restarts and replays (TD-004), and backoff keeps a long wait cheap.
- **No bound at all.** Rejected because BD-008's "every loop is bounded" still holds. A pipeline stuck for a day, or a worker that cannot reach the model for an hour, is something a person has to look at.
- **Re-offer a run nobody claimed instead of escalating at the offer timeout.** Not done here. The offer already waits for a claimant for `offer_timeout_seconds` (24 h by default). A day with no claimant means no worker and no runner are configured, which is the "missing infrastructure" case above.

## Consequences
- BD-008's *"Nothing retries silently"* now reads: nothing retries **unboundedly**, and every retry is visible. Each retried run is a `runs` row and each gate read is logged; only a bound that is truly spent tells a person.
- **Left as escalations on purpose.** Each of these is human-only, a real exhaustion, or a failure that another attempt does not fix:
  - template and configuration refusals, `reject` verdicts, the autonomy dial, and question and approval outcomes;
  - BD-008's iteration limits, including `rebase_rechecks` (10);
  - CI convergence on three identical failures, and review findings that did not change;
  - a held `manual` pipeline unchanged on retry, and a `manual` pipeline or no pipeline at the CI timeout;
  - non-retryable start failures (`invalid_spec`, a forbidden mint, a CLI spawn the platform refused), permission refusals and secret leaks;
  - the offer timeout;
  - a failure after the agent took turns (`error_max_turns`, `timed_out`, an API error mid-run, a missing artifact or merge request), and a `crash` or a stall, whose turn count reads 0 only because no result was read and which may follow real work. Another run would spend again on what may be the same ending. A person reads the transcript.
- **Reviewed in the follow-ups below** (BACKLOG 1659): write-conflict exhaustion, a `stage.execute` job that keeps throwing, the event dead-letter sink, the `mr.comment.debounce` and expired-job endings, and the platform merge's lost `mr.merged` signal.
- **Follow-ups** (BACKLOG 1656–1659): delivered by the amendment below.

## Amendment 2026-11-26 — the follow-ups

The product owner asked for the four follow-ups end to end. As built:

| Path | Before | After |
|---|---|---|
| A `pipeline.outbound` duty a person waits on (`mr_pipeline`, `mr_ready`, `ready_head_check`, `dependency_gate`, `review_only_post`, `ticket_lint_post`, `spike_report`, `breakdown_create`) failing on a provider outage (BACKLOG 1656) | 3 tries, 30 s then 60 s (≈1.5 min), then escalate | 25 tries backing off from 30 s to 15 min (≈5 h), then escalate with a brief saying how long and how often; the queue's row is moved by the queue migration `0001_pipeline_outbound_retry_hours` (TD-004's 2026-11-26 amendment) |
| The same duties refused by the provider (`IntegrationError.retryable` false: a credential, a permission, a request the provider calls wrong) | 3 tries, then escalate | unchanged: escalate at the third try, and the job then **ends** rather than spending the hours (the brief says the provider refused it) |
| `mr.comment.debounce` (the review window) failing on a provider outage (BACKLOG 1659) | 3 tries 30 s apart, then escalate | the same ≈5 h policy, through `0002_mr_comment_debounce_retry_hours`; a later comment's wake-up folds onto the retrying job, which re-reads every thread |
| An owed re-plan lost between its settle's commit and its `stage.execute` enqueue: a shutdown hand-back, a transport failure to start, a turnless run, a lost or usage-limited run past its first (BACKLOG 1657) | escalated by the stranded-stage row (only the **first** lost or usage-limited ending was re-planned) | re-planned by the stranded-stage row, once **per ended run**, with the ended run's model and effort; each ending's own bound still escalates in its settling transaction |
| A task the CI gate's wait parked (a `manual` pipeline or no pipeline at the timeout, the 24 h ceiling) when its pipeline's `ci.pipeline.finished` arrives later (BACKLOG 1658) | the event was dropped; a person handed the task back | the pipeline resumes the gate at a new attempt (`task.resumed` by the pipeline, no human round spent) and the gate's own settlement judges the result: green moves on, red returns to `ci_fix` |
| Write conflicts on the job side (`retryOnTaskConflict`) | 3 immediate re-reads, then escalate | 6 attempts with a jittered backoff from 25 ms (≈0.8 s), then escalate; the bus re-runs a handler 6 times and then falls through to the dispatch's own retry, never to a person |
| A `stage.execute` job that keeps failing for a reason another try may fix — a provider or the database not answering (by error class and code), a write that lost its races | pg-boss's 2 retries, one stranded-stage re-enqueue, then escalate | re-enqueued once per failed job, 0, 5, 10, 20, 40 then 60 min after each failure, up to 8 failed jobs (≈4 h), then escalate naming how many re-enqueues over how long; any other failure keeps its one re-enqueue |

**Left as escalations on purpose** (each a real exhaustion or a failure another attempt does not fix):

- **The event dead-letter sink** (10 dispatches over ≈20 minutes with backoff, then `needs_human`). A handler makes no provider call (WP-15d), and while a dispatch retries, every later event of its stream waits behind it (`hasEarlierPending`); an attempt is counted in the dispatcher's own transaction, so a database that is down cannot record one either. What reaches ten attempts is a poison event — a payload or a handler bug every retry repeats — and a longer wait only holds the stream longer. `APP_DISPATCH_MAX_ATTEMPTS` stays the operator's knob.
- **The expired-job ending** (`expired_job`): with the long policy, a try that expires is retried like a throw; only the queue's **last** try expiring escalates, hours later, and then whether the work happened is unknown — a person reads it.
- **The platform merge's lost `mr.merged`** (3 passes ≈10 minutes apart): the first pass already records the merge through the inbox, and a later pass with the same delivery id is a duplicate, so more passes change nothing. A task still at Ready after the platform recorded its own merge is a defect a person has to look at.
- **A provider's refusal** at a bound-and-escalate duty (above), a `stage.execute` job that keeps failing for a reason that is not transient (a schema refusal, a type error, an expired two-hour try), and a write conflict that loses six times in a row over most of a second (a writer that keeps rewriting the row).
- **A poll-only binding's late result**: no webhook reaches it after the gate parked the task, so its CI-timeout escalation is still resumed by a person (BACKLOG 1663).

Money stays bounded as before: none of these retries starts a paid run that the task's budget does not cap.
