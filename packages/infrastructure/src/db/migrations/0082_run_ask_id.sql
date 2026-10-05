-- 0082 — `runs.ask_id`: which ask a run answered (WP-149, PROGRESS backlog 445).
--
-- An ask that a `runner` stop hands back (WP-144) is started again at most twice. The bound was
-- counted in the `task.ask` job's payload (`hand_backs`), because `task_asks.run_id` keeps only the
-- latest run and nothing else named an ask's earlier runs — so a deduplicated enqueue, or an old
-- payload retried, could reset or undercount it. The count is now read from the runs themselves —
-- `RunRepository.askShutdownEndings`, `terminal_reason = 'shutdown'` — as the stage's is from its
-- entry's runs (`shutdownEndings`), which needs this link.
--
-- Written once, by the ask executor's `runs.insert`; a stage run writes null. `on delete set null`
-- as `task_asks.run_id`'s own reference is: the two rows point at each other and losing one must not
-- delete the other. Every run before this migration is null — an ask then in flight counts its
-- earlier hand-backs as none, which can allow it up to `MAX_ASK_HAND_BACKS` more starts, once.
alter table runs add column ask_id uuid references task_asks (id) on delete set null;
create index runs_ask_id_idx on runs (ask_id) where ask_id is not null;
