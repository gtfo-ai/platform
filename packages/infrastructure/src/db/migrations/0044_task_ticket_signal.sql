-- 0044 — the task's last provider signal about its ticket (WP-60, Q61 (b), PROGRESS backlog 59),
-- and the provider's instant of the merge-request head it records (PROGRESS backlog 182).
--
-- `tasks.ticket_snapshot` (0015) is read once at intake and again at stage start only when it is
-- **absent**, because until WP-60 nothing told the platform that a ticket changed: an edited
-- description reached no event at all. `ticket.updated` is that signal now, and this column is where
-- its consumer leaves it: the platform's receipt time of the newest `ticket.updated` for the task's
-- ticket, a platform instant like `ticket_snapshot_at` (two processes' clocks; the skew bound is in
-- `isTicketSnapshotStale`), so the stage-start rule is one comparison —
-- re-read when `ticket_snapshot_at < ticket_signal_at`.
--
-- **One writer** (`TaskRepository.recordTicketSignal`), which only ever moves it forward
-- (`greatest(…)`), and not the whole-row `save`: the partition `tasks-column-ownership.test.ts`
-- holds. Nullable with no default: `null` is "no edit announced since the task existed", which is
-- every row this migration finds.
--
-- No index: the writer's predicate is `(project_id, ticket_provider, ticket_key)`, and
-- `tasks_project_id_ticket_key_mode` already leads with two of the three.
alter table tasks add column ticket_signal_at timestamptz;

-- `mr_head_at` — the provider's instant (`mr.updated`'s `updated_at`) of the revision in
-- `mr_ref.head_sha`, written only by `TaskRepository.saveMergeRequestHead`, which moves the head
-- **forward only** by it: GitLab documents no delivery order, and the conflict warning, the diff
-- coalescer and the risk routing key on this head, so a late delivery for an older push must not move
-- it back (WP-60 review round 1; the CI gate reads the provider's live head instead, round 2). `null` until the first announced push; a head a pushing stage records through `save`
-- carries no provider instant and leaves it as it was.
alter table tasks add column mr_head_at timestamptz;
