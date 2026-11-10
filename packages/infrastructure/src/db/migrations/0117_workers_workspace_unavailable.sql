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
--   workspace_unavailable_detail  the launcher error's first line as the worker redacted it and
--                                 the core redacted again, bounded at 500 characters — untrusted
--                                 text, rendered as text.
--   workspace_unavailable_until   the cool-down: the claim's eligibility refuses the worker until
--                                 it passes, so a broken machine cannot re-claim at once. Lifted
--                                 (null) by the worker's retry claim (`?workspace_retry=1`).
--
-- The hand-back does **not** exclude the worker from the offer (a permanent per-offer exclusion
-- would keep a lone, repaired machine off its own task until the offer timed out); the cool-down
-- does the keeping-off instead. The record is cleared when a run's CLI is asked for (`spawn`) —
-- proof that this machine provisions again — never by a mere claim. The Workers screen's row
-- carries the `workspace_unavailable` claim blocker while `workspace_unavailable_at` is set.
--
-- Additive by TD-032's list: four nullable columns with no default, which the previous build
-- never names.
alter table workers add column workspace_unavailable_at timestamptz;
alter table workers add column workspace_unavailable_cause text;
alter table workers add column workspace_unavailable_detail text;
alter table workers add column workspace_unavailable_until timestamptz;
