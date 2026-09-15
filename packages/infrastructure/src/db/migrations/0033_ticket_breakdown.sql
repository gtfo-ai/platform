-- 0033 — the spike template and the epic-split variant (WP-40, product/04:117, product/18:45).
--
-- > *"**Spike template** Research/analysis tickets: `Intake → Refinement → Architecture (produces a
-- > document instead of a plan) → Human`. Output is a markdown report attached to the ticket and
-- > stored in the KB under `research/`. No MR. Variant **epic split** (opt-in): the input is an epic
-- > and the output is a proposed ticket breakdown with acceptance criteria for the PM to accept."*
--
-- `TaskManagementPort.createTicket` has existed with a capability flag since WP-08 and has had **no
-- caller** in any ring; `BUILTIN_TEMPLATE_IDS` has carried `spike` since WP-15 with nothing shipping
-- it. What neither had was somewhere to put a proposal a human has not decided yet, which is what
-- this migration is.
--
-- ## Two enum values, and why they are safe in this transaction
--
-- `alter type … add value` may run inside a transaction block (PostgreSQL 12+), which is what this
-- migration runner holds every file in, but the new label may **not be used** in the same
-- transaction. Nothing below uses one: the table's own `status` is `text` with a check constraint,
-- and the first row naming `'ResearchReport'` or `'TicketBreakdown'` is written by a run in a later
-- transaction. Migrations 0018, 0024 and 0030 are the precedent.
--
-- Each value is **appended**, because `alter type … add value` without `before`/`after` appends and
-- `test/integration/db/enums.integration.test.ts` compares the database's labels with the zod enums
-- *in order*.
alter type artifact_type add value 'ResearchReport';
alter type artifact_type add value 'TicketBreakdown';

-- ## The queue
--
-- One row per **proposed child ticket**, which is Q85's recommendation and the shape its reasoning
-- forces: a breakdown is N independent decisions and an `approvals` row is one, so a PM who wants
-- five of seven children has to have a row per child to say so. `approval_kind` is therefore
-- **untouched** — no `'breakdown'` value is added — and the shape here is `kb_proposals`': a status,
-- who decided and when, and a rejection that leaves the row rather than deleting it (product/10:52
-- — the platform learns from rejections).
--
-- `title`, `description`, `acceptance_criteria` and `rationale` are **model output over untrusted
-- input** (BD-022), and `reason` is a human's free text. Every one of them is **stored redacted**:
-- TD-012's pattern rules are applied by the writer — `redactBreakdownChild` in
-- `pipeline/epic-split.ts` for the model's fields, `decideBreakdown` for the reason — so this table
-- is the platform's **sixth** untrusted-text sink (after `inbox`, `kb_chunks`,
-- `tasks.ticket_snapshot`, `tasks.review_subject` and `task_asks`) rather than a projection of
-- `artifacts.data`, which still holds the unredacted copy (PROGRESS backlog 35). What that
-- redaction cannot do is step 1 — a *binding's* own credential values — because the queue is
-- written inside the dispatcher's transaction where no binding can be resolved; that half is
-- applied at the call by the adapter's redactor (`ticketWrites.createChildTicket`), which is the
-- write that leaves the platform. `redaction_count` is the summed count over both writers, for
-- migration 0014's and 0024's reason: it is the only trace a redactor that stopped working leaves.
--
-- No `varchar` and no size constraint, for `tasks.history_sample`'s reason: the writer has already
-- bounded the text, and a column bound here would refuse a row the writer believed it had bounded —
-- doubly so now, because a placeholder is longer than the value it replaced, so a bound here would
-- refuse exactly the rows the redaction saved.
--
-- `status` is `text` with a check rather than an enum: three values, this feature's own vocabulary,
-- nothing joins on them, and an enum would be a third `alter type` the next time the queue learns a
-- state. `history_bootstrap_batches.status` made the same call for the same reason.
--
-- `ticket_key`/`ticket_url` are what `createTicket` produced. They stay `null` on an accepted child
-- whose call has not happened yet, which is the honest difference between *accepted* and *created* —
-- and the predicate the `breakdown_create` duty re-derives its work from when it fires (TD-004).
create table ticket_breakdown_items (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  -- The run whose artifact proposed it. `on delete set null` rather than cascade: losing the run
  -- must not delete a decision a human made about what it proposed.
  run_id uuid references runs (id) on delete set null,
  artifact_id uuid not null references artifacts (id) on delete cascade,
  position integer not null,
  title text not null,
  description text not null,
  acceptance_criteria jsonb not null,
  size text not null,
  rationale text not null,
  status text not null default 'queued',
  decided_by_user_id uuid references users (id) on delete set null,
  decided_at timestamptz,
  -- **A human's own words** about the decision — untrusted text like everything above it, bounded
  -- by `decideBreakdownRequestSchema` at the route and redacted by the command that stores it
  -- (`routes/breakdown.ts` → `decideBreakdown`), which is the only writer this column has.
  reason text,
  ticket_key text,
  ticket_url text,
  -- How many replacements the redactor made in this row's stored text, summed over both writers:
  -- the model's fields at the insert, plus the reason's at the decision (`redaction_count + $n`).
  -- `not null default 0` so a row written before it is counted as *nothing redacted* rather than
  -- unknown — which is true of every row this table can have, since the column ships with it.
  redaction_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint ticket_breakdown_items_status_known
    check (status in ('queued', 'accepted', 'rejected')),
  constraint ticket_breakdown_items_position_nonnegative check (position >= 0),
  constraint ticket_breakdown_items_size_known check (size in ('S', 'M', 'L', 'XL')),
  -- "Decided" is one fact with two columns: a row that is not `queued` has a decider and an
  -- instant, and a `queued` one has neither. The shape `history_bootstrap_batches_completed_pair`
  -- uses, and it is what stops a half-written decision from reading as a decision.
  constraint ticket_breakdown_items_decided_triple
    check ((status <> 'queued') = (decided_at is not null)),
  -- A ticket exists only for a child somebody accepted. A `rejected` or `queued` row carrying a
  -- ticket key would be a ticket the platform filed without a decision, which is the one thing
  -- product/04:117's *"for the PM to accept"* forbids.
  constraint ticket_breakdown_items_ticket_needs_acceptance
    check (ticket_key is null or status = 'accepted'),
  -- One row per child of one artifact: the queue is written once per stage attempt, by a handler
  -- the dispatcher already makes exactly-once, and this index is what decides if that ever changes.
  constraint ticket_breakdown_items_one_per_position unique (artifact_id, position)
);

-- The queue as a human reads it: every child of one task, in order.
create index ticket_breakdown_items_task_idx on ticket_breakdown_items (task_id, position);

-- Registered rather than defaulted, so the "the registry lists every table" invariant of
-- `test/integration/db/migrations.integration.test.ts` stays true. `read_write`: the rows are
-- inserted by the pipeline, moved by a human's command and stamped by an outbound duty.
insert into platform_table_policy (table_name, app_access)
values ('ticket_breakdown_items', 'read_write');
