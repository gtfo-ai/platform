-- 0054 — whether any process is holding an account's inbound connection **now** (WP-72, PROGRESS
-- backlog 200).
--
-- WP-43 made the process that serves `/webhooks/*` hold Slack's Socket Mode connection, and posted
-- an approval with buttons whenever the binding's *configuration* said a click could arrive
-- (`capabilities().buttons`). A configuration cannot say whether a process is holding the socket:
-- on a deployment with no API process running — a worker-only topology, or an API container that
-- is down — the notify duty still posted buttons that no door would receive, which is the dead
-- control WP-32 refused to ship.
--
-- **One row per account, renewed by whichever process holds it.** `startInboundConnections`
-- writes the row the moment a connection opens and renews it on an interval while it is held;
-- the notify duty reads it before it posts buttons and posts text naming the task page when it
-- is not fresh. Freshness is `expires_at > now()`, and **both** halves use the database's clock —
-- the writer sets `expires_at = now() + ttl`, the reader compares with `now()` — so two processes
-- whose wall clocks disagree cannot disagree about whether a holder is alive.
--
-- **The key is the account, not the holder.** Slack keeps up to ten connections per app and two
-- `api` replicas hold two (WP-43); the question the duty asks is "does *any* process hold one", so
-- the last renewal wins the row and `holder` is a diagnostic naming who wrote it. A holder that
-- stops deletes the row only if it is still the one named there, so a replica shutting down does
-- not erase a *later* renewal by a live replica — but when the stopping replica wrote the row last,
-- the delete removes it while another replica still holds a socket, and approvals go out as text
-- until that replica's next renewal (up to its renew interval, 20 s). That fails safe: text, never
-- a button nobody answers. A holder that dies leaves the row to expire.
--
-- **Retention: bounded by construction.** At most one row per integration, cascaded with it.
create table held_connection_liveness (
  integration_id uuid primary key references integrations (id) on delete cascade,
  holder text not null,
  renewed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint held_connection_liveness_holder_shape check (length(holder) between 1 and 200),
  constraint held_connection_liveness_expires_after_renewal check (expires_at > renewed_at)
);

-- `read_write`: renewed in place, deleted when its holder stops.
insert into platform_table_policy (table_name, app_access)
values ('held_connection_liveness', 'read_write');
