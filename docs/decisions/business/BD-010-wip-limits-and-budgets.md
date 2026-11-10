# BD-010 — WIP limits per project; budgets at org/project/task/run with pause-not-kill

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/09

## Decision
Projects define `max_parallel_tasks` (default 2) and `max_tasks_in_pipeline` (default 5); the organisation defines `max_parallel_runs` (default 4). Budgets exist at organisation and project scope (daily/weekly/monthly), task scope (total cap) and run scope (per-run cap). An org/project budget admits a new run only if the window's spend, what its live runs have committed and what its unmeasured runs are held at, plus the new run's own per-run cap, stay within the limit; running runs finish. *Amended at WP-131 (session 11, backlog 406): it read "Reaching an org/project budget prevents new runs", which let one admitted run overshoot the window by its own reservation; technical/10's "budgets never overspent" is the reading kept.* Per-run caps stop the run through the SDK budget mechanism. Notifications at 50%/80%/100%.

## Rationale
Spending already made should not be wasted by killing a run; predictable worst case comes from per-run caps which are known upfront. WIP limits protect reviewers as much as budgets.

## Consequences
- Queue ordering by ticket priority then age.
- Budget windows use an organisation timezone setting, defaulting to the container's `TZ` and falling back to UTC (Q12).

## Amendment (2026-10-05, product owner — first local test on Autix, PROGRESS backlog 466)
*"When a run delivers a valid artifact in the same turn that crosses its cap, the platform keeps that artifact; the overrun is still recorded and counted."* A per-run cap still stops the run, and the money is counted exactly as for any other ending: the run row, `run.finished`, the cost ledger and the task's spend all carry the reported figure. What changes is the artifact. Before this amendment, an architect run that handed its plan to the CLI's `StructuredOutput` tool in the turn that took it past $5 lost the plan, and the task paused. Now the run ends `completed` with the terminal reason `error_max_budget_usd`. That pairing records the overrun. The stage completes, and the task cap is still checked when the next run is admitted. The artifact is kept only when the CLI accepted the tool call and the platform's own validation also accepts it. Nothing is kept from any ending other than a budget stop: `cost_unreported`, a crash, a timeout, a stall, a cancel and a hand-back all keep their current endings. technical/04 § "Budgets and limits" has the mechanism.

## Amendment (2026-10-06, M9 architect pass — first local test on Autix, PROGRESS backlogs 410 and 489)
*What its unmeasured runs are held at* applies to a run that **may have reached the model**, not to every run without a figure. A run the platform can prove never started its CLI — the process holding it records, in its own committed transaction, that it is about to ask the shim to start the CLI, and a run with no such record cannot have sent a model request — is a **measured zero**, exactly as a start failure already is, and holds nothing against any cap. Every run that did reach that point and ended without a figure stays held at its reservation, as before (WP-131's ruling is unchanged for it), and every run that ended before the record existed is treated as having reached it. Built at WP-150. Evidence: AUT-6820's developer run was refused by its shim before the CLI started (a protocol mismatch read as `auth_failed`), was recorded as a `crash` with no figure and was then held at the implementation cap of 40 USD against the task cap, for money that could not have been spent.

## Amendment (2026-10-08, M10 architect pass — PROGRESS backlog 501)
The record the 2026-10-06 amendment relies on is written **before** the shim is asked to start the CLI, so it proves the platform was about to ask, not that it asked. When the runner then learns that it did not send the request (a stop, or the shim's connection ending, arrived while the record was committing), it knows that no CLI was started, and the run is a **measured zero** as well: it holds nothing against any cap. The record itself is kept, because it is true that the platform was about to ask, and the run's ending says the request was withheld. Only a run whose holding process died between writing the record and recording its ending is still held at its reservation, because nothing then says whether the request went out. That window is one transaction. Built at WP-163.

## Amendment (2026-10-17, WP-163, session 16 — PROGRESS backlog 554)
The 2026-10-08 amendment's last sentence reads *"That window is one transaction"*. As built, the window is **the record's commit plus the ending's transaction**: a process that dies after the record commits and before its ending is recorded leaves the run held. The run is still held, so the window fails closed. WP-163 also withholds the request when a stop is asked for while the record commits, not only when the shim's connection ends.

## Amendment (2026-11-10, the product owner's feedback round, M28 — a budget pause shows its arithmetic; S-28.1)
*"Clear communication everywhere is key — the user must always understand what is wrong, why it is stuck, the rules."*

**Evidence.** AUT-6655 on Autix paused at **$10.99 of $50** and the page said it *"has spent its cap"*
(`apps/web/src/features/task-callout.tsx:246`). It had not: the task cap admits a run only when spent + held + the
stage's per-run reserve stays within the cap (`taskBudgetExhausted`, `packages/application/src/pipeline/stage-executor.ts:614-620`),
and Autix reserves **$40** per implementation run. The maintainer raised the cap to 51, 52, 53 and 54; each raise
resumed the task, was re-paused at once by the same arithmetic, and opened an empty stage attempt (4 → 8). A return also
re-drafted the merge request before the run that was supposed to follow it had been admitted.

**Decision.**
1. **The rule is unchanged and is now stated:** the task cap admits a run when *spent + held + the stage's run reserve ≤ cap*.
   This sentence replaces product/09's *"total cap … task → Paused: budget"* as the reading of the task row.
2. **A pause records and shows that arithmetic**: spent, held (with the count of unmeasured runs), the reserve of the stage
   it would run and that stage's name, the cap, and the **required cap** (spent + held + reserve). The words never say
   *spent its cap* unless spent ≥ cap.
3. **A raise below the required cap is refused** (a typed refusal naming the minimum) rather than accepted and re-paused.
   A raise at or above it resumes.
4. **A resume of a stage attempt that ran nothing reuses that attempt**; no empty attempt is opened, and none is counted
   against a loop bound.
5. **On a return, the merge request is re-drafted only once the implementation run is admitted**, so a return that pauses
   on budget leaves the MR as the person saw it.

**Rejected.** Lowering the reserve automatically to fit the cap (it would let a run start with less than its stage needs,
which is BD-010's own *predictable worst case* undone); accepting any raise and pausing again (AUT-6655's loop).
**Residual.** The reserve is the stage's per-run cap, not a forecast; a project that wants cheaper admission lowers
`stages.<id>.budget_usd`, and the pause names that lever. Slice S-28.1.

## Amendment (2026-11-10, the product owner's feedback round, M28 — an estimate is not money spent; S-28.16)
*"what is this? saying the budget is over but it shows 0.45 cost so far"* — the owner, on a task page.

**Evidence.** The card was the pre-spend **budget approval**: estimate **$123.66** against the **$50** approval
threshold, *"from 1 finished task"*. The estimate is the size weight × the mean unit cost of the project's finished tasks
(`packages/domain/src/cost/estimate.ts:35,95-113`), and the project's only finished task had cost $123.05; four tasks
were parked on it. The card said *"Approve: … may spend what was estimated"* (`apps/web/src/features/approval-text.ts:256`),
but approving changed nothing about the task's own cap ($50), so an approved task would pause at $50 anyway.

**Decision.**
1. **An estimate asks for approval only when it rests on at least 3 finished tasks** (`MIN_ESTIMATE_SAMPLES_FOR_APPROVAL
   = 3`, one named constant). With fewer, nothing is asked: the number is shown as *rough estimate from n finished
   task(s)*, and the per-task cap bounds the spend, exactly as for a task with no estimate (`basis: unknown`).
2. **Approving an estimate above the task's cap raises that task's cap to the estimate**, as part of the approval and
   recorded with it (the cap before and after). The card says so before the click: *Approving raises this task's cap
   from $50.00 to $123.66.* An estimate within the cap says *the cap stays $50.00*.
3. **The card and the waiting sentence never read as money spent.** They say what was spent so far, that this is an
   estimate made before the expensive stages, and what it rests on (n finished tasks, the size and its weight), then
   the threshold it crossed.
4. **Approvals already waiting when this ships whose estimate rests on fewer than 3 tasks are settled by the platform
   as no longer required** — recorded as decided by the platform with that reason — and their tasks continue without a
   click; the page says *Budget approval no longer required: the estimate rested on 1 finished task.*

**Rejected.** Raising the approval threshold (the four tasks would still wait on a one-sample mean); dropping the gate
(a well-founded estimate over the threshold is exactly what it is for); approving without touching the cap (the
approval would promise a spend the cap then refuses). **Residual.** Three samples is still a small mean; the label says
how many, and `estimateAccuracy` is where a later revision of the constant is measured. Design: TD-035's 2026-11-10
amendment. Slice S-28.16.

## Amendment (2026-11-10, the product owner's feedback round, M28 — a limit per owner, and what a stopped task holds; S-28.6)
**Context.** With task owners (BD-031's 2026-11-06 amendment) one person's tickets could fill a project's pipeline, and
the project ceiling counted every state but queued, done and cancelled (`packages/domain/src/policies/wip.ts:88-95`), so
tasks at *Needs you* or paused held the places the queue waited for (S-25.16's evidence: five tickets queued for days with
nothing running). The owner had already ruled that paused and `needs_human` tasks free their place; it was never built.

**Decision.**
1. **`pipeline.wip.max_tasks_per_owner`**, default **3**. The organisation's value is a maximum; a project may tighten it,
   never loosen it. A per-user override, **`users.max_tasks_in_flight`** (migration **0114**, additive), replaces it for
   that person.
2. **What counts for an owner:** the person's owned tasks in `active`, `returned`, `waiting_answers` and `waiting_approval`.
   `paused`, `needs_human` and `ready_for_merge` do not count.
3. **`max_tasks_in_pipeline` stops counting `paused` and `needs_human`.** `waiting_approval` still counts (BD-006's
   2026-11-07 amendment, clause 5, which said it counts *exactly as `needs_human` did*, now reads: it counts; `needs_human`
   no longer does).
4. **Unowned tasks** are bound by the project ceiling only.
5. **A person's own act is never refused by the owner limit**: a pick, a resume and a hand-back go through. The limit is
   enforced at admission under an advisory lock per owner, and the scheduler **skips** a full owner's task and admits the
   next one rather than stopping the queue.
6. **A ready machine that runs nothing always states one idle reason** (`idle_reason` on the worker reads): no offer, the
   owner is full, the project is full, the claim policy excludes it, and so on — never a silent idle.

**Rejected.** A per-owner limit with no organisation maximum (a project could undo it); refusing a person's pick at the
limit (the owner wants the person's choice to win). **Residual.** A person over their limit by their own picks keeps
those tasks; the scheduler simply starts none of theirs until they fall below it. Slice S-28.6.
