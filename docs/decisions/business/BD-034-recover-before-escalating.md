# BD-034 — The platform recovers by itself before it escalates

- **Status:** accepted
- **Date:** 2026-11-26
- **Deciders:** the product owner
- **Relates to:** BD-008 (amends it), BD-010, BD-032, TD-031, technical/02, product/04

## Context
The product owner's rule, verbatim: *"If there is ANYTHING recoverable that agentic can solve, it must not escalate to a human."*

The incident that prompted it was fontai's GO-705 (goparking, GitLab MR !784) on 2026-11-26:

- **The CI gate.** The gate parked the task with *"the "ci_gate" gate could not be decided after 5 attempts: pipeline 19204 is running"*. Five checks 30 s apart give up after about 2 min, and the pipeline needed about 12. It then failed on ECS, a code-style fault that the `ci_fix` loop exists to fix. Commit 7f31c64c (WP-136, widened) bounded the CI wait by `ci_timeout_minutes` on every binding. That timeout still escalated a pipeline that was merely slower than it.
- **Refinement.** `refinement` ended `error_during_execution` with 0 turns four times while the worker was not ready yet. Every one of those runs parked the task, and the fifth attempt succeeded.

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
| Run ended before the model took a turn (`failed`/`stalled`, 0 turns, `error_during_execution`/`crash`/`stalled`) | escalate at once | re-plan the same stage entry, 1 → 16 min apart, 6 times (≈47 min), then escalate naming the runs |
| `runner` stopped mid-run (shutdown hand-back) | 2 hand-backs | 5 hand-backs |
| Usage limit ended the run | 1 re-plan | 3 re-plans |
| Worker lost the run's lease | 1 re-plan | 3 re-plans, each excluding the machines that lost it |

## Rationale
An escalation costs a person's attention and stops the task for hours, which is far more than another provider read or another offer of a run that never started. The conditions above end by themselves: a pipeline finishes, a provider answers again, a worker reconnects, a usage limit resets. Escalating them makes people watch the platform's infrastructure for it, and it hides the escalations that do need a person among ones that do not.

Money stays bounded. A turnless run, a run that never started and a gate read cost nothing or almost nothing. Every run that is re-run is charged as any run is, so the task's budget (BD-010) still caps the retries that do spend.

## Alternatives considered
- **Raise only the counts and keep the 30 s cadence.** Rejected because a count tuned for one provider's latency is wrong for the next one. A time bound measured from the stage entry survives restarts and replays (TD-004), and backoff keeps a long wait cheap.
- **No bound at all.** Rejected because BD-008's "every loop is bounded" still holds. A pipeline stuck for a day, or a worker that cannot reach the model for an hour, is something a person has to look at.
- **Re-offer a run nobody claimed instead of escalating at the offer timeout.** Not done here. The offer already waits for a claimant for `offer_timeout_seconds` (24 h by default). A day with no claimant means no worker and no runner are configured, which is the "missing infrastructure" case above.

## Consequences
- BD-008's *"Nothing retries silently"* now reads: nothing retries **unboundedly**, and every retry is visible. Each retried run is a `runs` row and each gate read is logged; only a bound that is truly spent tells a person.
- **Left as escalations on purpose** (they are human-only, or real exhaustion): template and configuration refusals, `reject` verdicts, the autonomy dial, question and approval outcomes, BD-008's iteration limits, CI convergence on three identical failures, a held `manual` pipeline unchanged on retry, a `manual` pipeline or no pipeline at the CI timeout, non-retryable start failures (`invalid_spec`, a forbidden mint), permission refusals, secret leaks, the offer timeout, and a model-side failure after real turns (`error_max_turns`, `timed_out`, a missing artifact).
- **Follow-ups**, listed in BACKLOG:
  - `pipeline.outbound` duties still escalate after their queue's three tries. Changing a live queue's retry options needs a queue migration (TD-004); the provider executor's own 429/5xx retries absorb most blips meanwhile.
  - A re-plan that was lost between its commit and its enqueue is escalated by the stranded-stage row rather than re-planned.
  - A task parked at the CI timeout is not resumed when its pipeline's webhook arrives later.
