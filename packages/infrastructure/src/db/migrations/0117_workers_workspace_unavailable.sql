-- migration-class: additive
-- 0117 — a machine that cannot provision a run's workspace stops claiming, and says why (S-28.12).
--
-- On the Autix core (2026-11-10) one machine's Docker had no free address pools; its worker kept
-- claiming runs and failing each within seconds, faster than the healthy machines could claim, and
-- a task was escalated after three attempts with no word of which machine or why. Since S-28.12 a
-- provisioning failure before the CLI is asked for is handed back (`release provision_failed`,
-- which keeps the worker off that offer and spends no attempt), and the worker reports why:
--
--   workspace_unavailable_at      when the worker hit it; `null` while it can provision.
--   workspace_unavailable_cause   the classified cause (`WORKSPACE_UNAVAILABLE_CAUSES`:
--                                 docker_networks_exhausted, docker_unreachable, image_missing,
--                                 disk_full, unknown) — a closed vocabulary the server parses.
--   workspace_unavailable_detail  the launcher error's first line as the worker redacted it,
--                                 bounded at 500 characters — untrusted text, rendered as text.
--
-- Written by the release, cleared by the worker's next claim (its retry or its owner's *Try
-- again*). The Workers screen's row then carries the `workspace_unavailable` claim blocker.
--
-- Additive by TD-032's list: three nullable columns with no default, which the previous build
-- never names.
alter table workers add column workspace_unavailable_at timestamptz;
alter table workers add column workspace_unavailable_cause text;
alter table workers add column workspace_unavailable_detail text;
