-- 0069 — what the last maintenance pass found blocking a project (WP-113, Q111 (c)).
--
-- ## `projects.maintenance_last_blocker`
--
-- Q111, answered (c) by the founder: a project whose maintenance pipeline is paused at Observe gets
-- **one** digest line when the pause begins and **one** when it ends, and nothing on the days
-- between. A transition needs the previous pass's answer, and nothing stored it: the nightly pass
-- (`packages/application/src/maintenance/scheduler.ts`) returns a blocker per project and the
-- report sink answered `nothing_to_report` for every one of them. This column is the previous answer.
--
-- **The blocker the last pass recorded, by its platform code** — the four values of
-- `MaintenanceBlocker`, held by the check below so a value the code does not know is refused at the
-- write rather than read as "no blocker". **Nullable, no default**: `null` is "the last pass found
-- nothing blocking, or no pass has recorded one" — every project before this migration. A project
-- already paused when this migration lands therefore gets its *began* line on the first pass after
-- it, which is the one line it was never sent.
--
-- **One writer**: `MaintenanceBlockerStore.recordBlocker`
-- (`packages/infrastructure/src/maintenance/postgres-maintenance-blocker-store.ts`), a
-- compare-and-set (`where maintenance_last_blocker is not distinct from $expected`) after the pass
-- has published the transition, so a pass whose publication failed (or whose write failed after
-- the publication) leaves the old value and the next pass announces again: at-least-once, never
-- silence. Two passes on one day are deduplicated by the transition row's same-day identity, not by
-- this compare-and-set, which runs after publication.
-- **One reader**: `MaintenanceBlockerStore.lastBlocker`. The census
-- `packages/infrastructure/src/maintenance/maintenance-blocker-writers.test.ts` holds the writer.

alter table projects add column maintenance_last_blocker text;

alter table projects add constraint projects_maintenance_last_blocker_known
  check (
    maintenance_last_blocker is null
    or maintenance_last_blocker in (
      'feature_disabled',
      'paused_at_observe',
      'no_chore_types',
      'no_chore_template'
    )
  );
