-- 0057 — a minted run credential redacted in every process by its shape, and the shadow writes
-- counted (WP-80: PROGRESS backlog 259 per TD-012's M5 amendment, and backlog 131).
--
-- ## `minted_credential_shapes`
--
-- A run credential is redacted by **exact value** only in the process that minted it: the value
-- lives in that process's memory (`RunScopedSecrets`) and nowhere else, which is the point. Every
-- other process — on the shipped topology `app`, which ingests every webhook — relied on the
-- gitleaks-derived `gitlab-token` rule, which knows GitLab's default `glpat-` prefix and nothing
-- else, while a GitLab administrator can change that prefix and project access tokens inherit it.
--
-- TD-012's M5 amendment: the minting process records a **non-secret shape** of the value — the
-- prefix the provider declares, a closed character class, the exact length — and every process
-- compiles one pattern rule per unexpired shape. A shape names no character of the random part, so
-- this table holds nothing a credential could be rebuilt from (BD-002, TD-012's "originals are
-- never stored"); the shared registry of values that would have been the alternative is rejected
-- for 0.1 by that amendment.
--
-- **Written in the mint's audit transaction.** The `IntegrationAuditLog` adapter writes this row in
-- the same transaction as the `mint_credential` row in `integration_actions` it describes, so a
-- mint on record always has its shape on record. An upsert on the shape: the table holds one row per
-- distinct shape per integration, and `expires_at` is the latest credential of that shape's expiry.
--
-- **Read by every process**, `where expires_at > now()`, at start and on a refresh timer. An expired
-- row is ignored rather than deleted: the table is as small as the set of shapes the instance's
-- providers produce (for GitLab, one per distinct length per integration), so no sweep is owed.
--
-- The checks are the application's shape schema restated, so a row the redactor would refuse to
-- compile cannot be stored: the prefix alphabet excludes whitespace and every regular-expression
-- metacharacter a prefix could need escaping for except `.` and `+`, which the compiler escapes.
create table minted_credential_shapes (
  integration_id uuid not null references integrations (id) on delete cascade,
  prefix text not null,
  charset text not null,
  length integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (integration_id, prefix, charset, length),
  constraint minted_credential_shapes_prefix_shape check (prefix ~ '^[A-Za-z0-9_.+=/@:-]{3,32}$'),
  constraint minted_credential_shapes_charset check (charset in ('alnum', 'token', 'token_dotted')),
  constraint minted_credential_shapes_length check (length between 16 and 512 and length > char_length(prefix))
);

create index minted_credential_shapes_expires_idx on minted_credential_shapes (expires_at);

-- `read_write`: an upsert moves `expires_at` forward.
insert into platform_table_policy (table_name, app_access)
values ('minted_credential_shapes', 'read_write');

-- ## The shadow writes, counted (backlog 131)
--
-- `shadow_reports.comparison` held the **pre-redaction** document beside the `ShadowReport` artifact
-- that went through `redactArtifactData`, and the two were byte-identical only because the redactor
-- was empty. Since WP-80 both are the one redacted document, and this column is that redaction's
-- count. `shadow_batch_tickets.human_mr_ref` — the provider's merged-merge-request entry the report's
-- `human_mr` is copied from — was stored with no redactor at all; it now passes through the
-- project's git binding redactor and this column counts it.
--
-- **Nullable, no default** — migration 0038's shape: `null` is a row written before this migration,
-- when nothing counted; `0` is "the redactor ran and replaced nothing". A default of `0` would spell
-- those two the same way (standing rule 18).
alter table shadow_reports add column redaction_count integer;
alter table shadow_batch_tickets add column redaction_count integer;
