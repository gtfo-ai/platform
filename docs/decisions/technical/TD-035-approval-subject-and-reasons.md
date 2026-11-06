# TD-035 — An approval records its subject and its reasons at the gate; the decide command echoes the subject it was shown; the reasons are a closed vocabulary the UI words

- **Status:** accepted
- **Date:** 2026-11-06
- **Relates to:** BD-006 (2026-11-06 amendment), BD-003, BD-022, BD-026, BD-027, BD-030, TD-011, TD-032, product/19 §11 and §14, technical/02, technical/03

## Context

`approvals` has no subject and no reason for asking (`0004_pipeline.sql:177-187`, `approvalRecordSchema` at
`packages/contracts/src/records.ts:109-119`). The plan gate already holds both — it loads the plan artifact and
evaluates the policy (`packages/application/src/pipeline/saga.ts:1103-1143`) — and throws them away:
`requiresPlanApproval` answers a boolean and short-circuits on the first cause
(`packages/domain/src/policies/autonomy.ts:241-262`). The budget gate logs estimate and threshold and stores
neither (`saga.ts:1281-1290`). So the task page can only say "Plan approval · requested" (owner, 2026-11-06).
`artifacts` rows are versioned per `(task_id, type, version)` and written once (`0004_pipeline.sql:138-150`).
`knowledge` and `rework` are declared kinds that no writer creates (technical/02, WP-15i note).

## Decision

1. **Reasons are computed where the decision is made.** `requiresPlanApproval` becomes
   `planApprovalReasons(input) → readonly PlanApprovalReason[]` (empty = no approval), evaluating **every** rule
   in a fixed order, no short-circuit. Closed vocabulary (snake_case on the wire, strict zod, discriminated on `code`):
   `risk_class {classes: string[]}` (sorted) · `probation {completed: int, of: int}` ·
   `policy_always {source: 'dial'|'stage_override'}` · `size_at_or_above {size, threshold, source}`.
   The saga passes which fields its stage override supplied, so `source` is a fact, not a guess. Budget:
   `estimate_above_threshold {estimate_usd, threshold_usd}`. The shadow skip (BD-006 WP-34) stays before the call.
2. **Subject.** Plan: the `ImplementationPlan` artifact the gate loaded — its id is stored, its version read
   through the FK (artifacts are immutable). Budget: a snapshot `{estimate_usd, threshold_usd, estimate_basis,
   estimate_samples}`. Knowledge would be its `kb_proposals` id; rework is **not decided** — the first writer of
   either kind amends this record before writing one.
3. **Storage — migration `0103_approval_subject_and_reasons.sql`, `-- migration-class: additive`:** nullable
   `approvals.subject_artifact_id uuid` (FK to `artifacts`, added `not valid` then validated), nullable
   `subject_detail jsonb` (the budget snapshot), nullable `reasons jsonb` (a non-empty array when present; check
   added `not valid` then validated). Written **once, at insert**; `ApprovalRepository.save` never names them
   (its decision-columns-only rule, `store.ts:2597`). **No backfill** — a data rewrite is `contract` (TD-032 §1).
4. **Wire.** The task DTO's approvals gain `subject` (union on `kind`: plan `{artifact_id, artifact_version,
   stage, attempt, basis: 'recorded'|'derived'}`, budget the snapshot) and `reasons`, both nullish; **`null`
   means "not recorded"** and the UI says so. The `task.approval.requested` payload is **unchanged in this
   slice**: payload schemas are strict, and an older build reading a new event during an additive rollback
   (TD-032 §2) would refuse it. Adding them to the event is a follow-up once a build that parses them has shipped.
5. **Old rows, honestly.** The read projection may derive a plan subject only by the exact chain
   `artifacts.produced_by_run_id → runs.task_stage_id → task_stages(task, stage, attempt)` of the approval, with
   exactly one `ImplementationPlan` at the end, and labels it `basis: 'derived'`; anything else is `null`. Reasons
   are never derived (the policy may have changed since).
6. **Deciding on evidence.** `decideApprovalRequestSchema` gains `subject_artifact_id` (optional in the schema,
   **required by the command to approve a plan**). Approve is refused with a typed 409 when the echo ≠ the subject
   (`approval_subject_mismatch`), when the subject is no longer the task's latest `ImplementationPlan`
   (`approval_subject_superseded`), or when the subject is `null` (`approval_subject_unrecorded`). Reject stays
   allowed. No `superseded` status: in this build a newer plan cannot be stored while a plan approval is pending
   (`waiting_approval` runs no stage; hand-back is refused there, `commands.ts:2359`; a reject closes the approval
   before the new attempt) — the 409 is the guard, and a path that makes it reachable amends this record.
7. **Retirement is UI copy keyed by `code`**, built from the reason's parameters and linking to the setting
   (dial / stage override / `policies.risk_classes` / probation). No server-written text. Who decides is unchanged
   (`task.approve_plan`, `can_decide_approval`).

## Rejected alternatives

- Show "the latest plan" — approves whatever is newest, not what was asked about; the owner's exact complaint.
- Free-text reason column — the UI cannot word or link it, and it would be platform prose to keep in sync.
- Backfill in the migration — `contract` class under TD-032, and a guess for every row the join cannot pin.

## Consequences / residuals

- A pre-0103 plan approval whose plan cannot be derived can only be rejected, which spends one
  `architecture_revisions` round (BD-006 2026-10-06). Accepted: few rows, and the alternative is a blind approve.
- Approvals-per-reason over time is now countable (*are we getting asked less?*); no metric is built here.
- technical/03's `approvals` line and technical/02's approval paragraph are updated by the slice that lands this.
- **As built (S-25.1).** Decision 3's check is `check (reasons <> '[]')`: TD-032's amendment C admits a `not valid`
  check on an existing table only as column-versus-literal atoms, so `jsonb_typeof(reasons) = 'array'` cannot be
  stated there. The column refuses an empty list; that it is an array of known reasons, and that `subject_detail` is
  the budget snapshot, is held by the one writer's strict zod schemas and by the reader, which parses the same
  schemas and refuses a row that does not. A chat (Slack) button still decides through the aggregate without an
  echo — decision 6 guards the HTTP command only (BACKLOG 1200).
