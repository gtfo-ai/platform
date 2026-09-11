-- 0014 — what the webhook ingress needs on top of 0005's `inbox` (WP-15c).
--
-- `inbox` has existed since `0005_events.sql:113` and nothing has ever written a row, because
-- nothing in production received a delivery. WP-15c is the endpoint, and building it found two
-- columns the table does not have. Both are recorded in `docs/technical/PROGRESS.md` under
-- "Architect ruling (WP-15c)".

-- **The row is stored redacted, so the count is the only signal that the redactor ran.**
--
-- technical/06 says the endpoint "stores the raw payload (audit)" and TD-012's write list does not
-- name `inbox`, so a naive ingress writes the delivery verbatim. That is a live credential on every
-- delivery, with no attacker and nothing planted: GitLab's legacy scheme sends the binding's own
-- webhook secret as **plain text** in `X-Gitlab-Token`
-- (<https://docs.gitlab.com/user/project/integrations/webhooks/>, "sent as plain text in the
-- `X-Gitlab-Token` HTTP header"). So `headers` and `payload` are written `redactJson`-redacted, and
-- this column is what makes "the redactor should have hidden something and did not" observable
-- rather than invisible — the same argument `integration_actions.redaction_count` carries.
--
-- **It is the sum over the redactions the endpoint performs on this row** — the headers, the
-- payload and the ignore/error detail — and deliberately *not* the delivery key's alone: the key is
-- redacted inside the provider adapter (`InboundNormaliser.deliveryKey`), its count is ~always 0,
-- and a column that reads 0 for ever is a dead signal. The adapter's own count is not observable
-- from the endpoint at all, because the port returns a string.
alter table inbox add column redaction_count integer not null default 0;

-- **The signature verdict is a stored fact, because the payload can no longer produce it.**
--
-- Every signature scheme in TD-024 is computed over the delivery's bytes. Once `payload` is stored
-- redacted those bytes are gone, so no later reader — an operator, a support query, a re-processing
-- tool — can recompute whether the delivery was authentic. Recording the answer is the only way the
-- row keeps it.
--
-- The default is `false` and it is kept rather than dropped, which is the opposite of the two
-- columns 0013 added and is deliberate: `redaction_count` defaulting to 0 would spell "nobody wrote
-- the column" the same way as "nothing was redacted" (standing rule 18), while `verified`
-- defaulting to *false* spells an unwritten column as **unverified**, which is the refusing
-- direction. A writer that forgets it understates its own trust rather than overstating it.
alter table inbox add column verified boolean not null default false;

alter table inbox alter column redaction_count drop default;

alter table inbox
  add constraint inbox_redaction_count_non_negative check (redaction_count >= 0);

-- `inbox` is the one table 0005 created without registering it (0011's note: "Every table registers
-- itself with `platform_table_policy`"). The access it needs is the default — `read_write`, because
-- the row is updated when a later build moves normalisation off the request path — so this changes
-- no grant; it closes the gap in the registry that made the omission invisible.
-- `on conflict do nothing` like `0011_auth.sql`: the registry is a statement of intent, and a
-- migration that fails because somebody registered the table by hand is a migration that fails for
-- a reason nobody needs to act on.
insert into platform_table_policy (table_name, app_access)
values ('inbox', 'read_write')
on conflict (table_name) do nothing;
