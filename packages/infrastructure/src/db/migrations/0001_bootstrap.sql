-- 0001 — bootstrap: version guard, least-privilege role, table registry, maintenance functions.
--
-- docs/technical/03-data-model.md, TD-006 (PostgreSQL 18 only), TD-019 (forward-only migrations).
-- Everything here is the machinery the later migrations register themselves with; it creates no
-- domain table of its own.

-- PostgreSQL 18 is a hard requirement: uuidv7() and xid8 are used throughout (TD-006).
do $$
begin
  perform uuidv7();
exception
  when undefined_function then
    raise exception 'PostgreSQL 18 or newer is required (uuidv7() is missing); found %', version();
end
$$;

-- ── The application role ─────────────────────────────────────────────────────
-- technical/03 revokes UPDATE and DELETE on the append-only tables "from the application role".
-- A privilege check only bites a role that is neither a superuser nor the object owner, and the
-- default Compose deployment connects as the database owner, so the split is created here rather
-- than left to the operator: migrations run as the owner, and the runtime pool opens its
-- connections directly as this NOLOGIN role (APP_DB_APP_ROLE in .env.example). Granting the role
-- to a dedicated login user instead works just as well.
--
-- Roles are cluster-wide, not per-database, so two databases migrating at once (CI, the
-- integration suite) can both pass an existence check and race on the CREATE; catching the
-- collision is the only way to make this idempotent. A managed PostgreSQL whose application user
-- has no CREATEROLE cannot create it at all — that degrades to a warning rather than a failed
-- migration, because the split is defence in depth, not a correctness requirement.
do $$
begin
  create role platform_app nologin;
exception
  when duplicate_object or unique_violation then
    null;
  when insufficient_privilege then
    raise warning
      'could not create the role platform_app (% lacks CREATEROLE): the append-only tables will not be protected by REVOKE. Create it manually and re-run migrate, or accept the reduced guarantee.',
      current_user;
end
$$;

-- ── Table registry ───────────────────────────────────────────────────────────
-- Drives what would otherwise be hand-maintained lists in several places: what the application
-- role may do to each table (grants), which tables are range-partitioned and on which column
-- (partition creation), and the retention window of each partitioned table (partition dropping).
--
-- `retention_days` lives here rather than being passed to the drop function, so the application
-- role can only ever trigger the retention the operator configured — see
-- platform_drop_expired_partitions below.
create table platform_table_policy (
  table_name text primary key,
  -- read_write: ordinary state. append_only: technical/03's audited tables — SELECT and INSERT,
  -- never UPDATE/DELETE/TRUNCATE. read_only: maintained by a definer function, the application
  -- may look but not touch.
  app_access text not null default 'read_write',
  partition_column text,
  retention_scope text,
  retention_days integer,
  constraint platform_table_policy_app_access
    check (app_access in ('read_write', 'append_only', 'read_only')),
  constraint platform_table_policy_retention_needs_partition
    check (retention_scope is null or partition_column is not null),
  constraint platform_table_policy_retention_days_positive
    check (retention_days is null or (retention_days >= 1 and retention_scope is not null))
);

comment on table platform_table_policy is
  'Storage policy per table (technical/03). Populated by the migration that creates each table; retention_days is written by the migrate entrypoint from APP_TRANSCRIPT_RETENTION_DAYS.';

-- ── Partition naming ─────────────────────────────────────────────────────────
create function platform_partition_name(p_table text, p_month date)
  returns text
  language sql
  immutable
  set search_path = pg_catalog
as $$
  select p_table || '_' || to_char(p_month, 'YYYY_MM');
$$;

revoke all on function platform_partition_name(text, date) from public;

-- ── Partition creation ───────────────────────────────────────────────────────
-- Creates the monthly range partitions of every registered partitioned table, from the current
-- month up to p_months_ahead months ahead, and returns what it created. Idempotent.
--
-- SECURITY DEFINER because CREATE TABLE … PARTITION OF requires ownership of the parent, and the
-- partition-auto-creation job runs as the application role, which owns nothing. EXECUTE on a
-- function is granted to PUBLIC by default, so it is revoked in the same migration, immediately
-- after the definition: doing it only inside platform_apply_grants() would leave the function open
-- to every role in any deployment that skips the grant step.
--
-- `timezone = 'UTC'` pins both current_date and the interpretation of the date literals in the
-- partition bounds. Without it, the same month computed from a session in a different time zone
-- produces a different absolute range and PostgreSQL rejects it as an overlap.
create function platform_ensure_partitions(p_months_ahead integer default 3)
  returns text[]
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  set timezone = 'UTC'
as $$
declare
  v_policy  record;
  v_offset  integer;
  v_month   date;
  v_created text[] := '{}';
  v_name    text;
begin
  if p_months_ahead is null or p_months_ahead < 0 or p_months_ahead > 120 then
    raise exception 'p_months_ahead must be between 0 and 120, got %', p_months_ahead;
  end if;

  for v_policy in
    select table_name, partition_column
    from platform_table_policy
    where partition_column is not null
    order by table_name
  loop
    for v_offset in 0 .. p_months_ahead loop
      v_month := (date_trunc('month', current_date) + make_interval(months => v_offset))::date;
      v_name  := platform_partition_name(v_policy.table_name, v_month);

      if to_regclass(format('public.%I', v_name)) is null then
        execute format(
          'create table public.%I partition of public.%I for values from (%L) to (%L)',
          v_name,
          v_policy.table_name,
          v_month,
          (v_month + interval '1 month')::date
        );
        v_created := v_created || v_name;
      end if;
    end loop;
  end loop;

  return v_created;
end
$$;

revoke all on function platform_ensure_partitions(integer) from public;

comment on function platform_ensure_partitions(integer) is
  'Creates missing monthly partitions for every registered partitioned table; returns the names created.';

-- ── Retention ────────────────────────────────────────────────────────────────
-- Drops whole partitions older than the retention window (APP_TRANSCRIPT_RETENTION_DAYS,
-- technical/03 "Retention and backups"). Only tables registered with the given retention scope are
-- considered, so metadata, artifacts, events and cost are never touched.
--
-- The window is *not* a parameter. This function is the only DELETE-shaped power the application
-- role has over an append-only table, so letting the caller name the window would be a bypass of
-- `REVOKE DELETE ON run_messages`: the role could pass one day and destroy the audit trail.
-- Instead it reads `platform_table_policy.retention_days`, which only the schema owner can write
-- (the migrate entrypoint sets it from the operator's configuration). With no retention
-- configured — the default (Q13) — the function is a no-op no matter who calls it.
create function platform_drop_expired_partitions(p_scope text)
  returns text[]
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  set timezone = 'UTC'
as $$
declare
  v_policy  record;
  v_cutoff  date;
  v_dropped text[] := '{}';
  v_part    record;
begin
  for v_policy in
    select table_name, retention_days
    from platform_table_policy
    where retention_scope = p_scope
      and retention_days is not null
    order by table_name
  loop
    -- A partition may only be dropped once every row it can hold is outside the window, so the
    -- cutoff is the first day of the month containing (today - retention).
    v_cutoff := date_trunc('month', current_date - make_interval(days => v_policy.retention_days))::date;

    for v_part in
      select c.relname, pg_get_expr(c.relpartbound, c.oid) as bound
      from pg_class parent
      join pg_inherits i on i.inhparent = parent.oid
      join pg_class c on c.oid = i.inhrelid
      where parent.relname = v_policy.table_name
        and parent.relnamespace = 'public'::regnamespace
      order by c.relname
    loop
      -- Bounds read "FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')"; a partition is expendable
      -- only when its exclusive upper bound is at or before the cutoff.
      if (substring(v_part.bound from 'TO \(''([0-9-]+)')::date) <= v_cutoff then
        execute format('drop table public.%I', v_part.relname);
        v_dropped := v_dropped || v_part.relname;
      end if;
    end loop;
  end loop;

  return v_dropped;
end
$$;

revoke all on function platform_drop_expired_partitions(text) from public;

comment on function platform_drop_expired_partitions(text) is
  'Drops whole partitions older than the configured retention window of one retention scope (technical/03).';

-- ── Grants ───────────────────────────────────────────────────────────────────
-- Re-applied by the migrate entrypoint on every run, so a migration that adds a table never has to
-- remember to grant it. SECURITY INVOKER, and EXECUTE revoked from PUBLIC below: only the schema
-- owner may run it.
create function platform_apply_grants(p_role text default 'platform_app')
  returns boolean
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  v_table  record;
  v_access text;
begin
  if to_regrole(quote_ident(p_role)) is null then
    raise warning
      'role % does not exist, so no privileges were applied; the append-only tables are protected only by the application''s own discipline',
      p_role;
    return false;
  end if;

  -- The runtime opens its connections directly as p_role, which needs membership unless the login
  -- role is a superuser. The role's creator can hand that membership out, so the common
  -- single-account deployment configures itself; anything else is reported loudly, because the
  -- application would otherwise fail to connect with nothing in the migration log to explain it.
  if current_user <> p_role then
    begin
      execute format('grant %I to current_user', p_role);
    exception
      when insufficient_privilege then
        null;
    end;

    if not pg_has_role(current_user, p_role, 'USAGE') then
      raise warning
        'role % cannot assume %: run "GRANT % TO %" as a superuser, or set APP_DB_APP_ROLE to a role it is a member of',
        current_user, p_role, p_role, current_user;
    end if;
  end if;

  execute format('grant usage on schema public to %I', p_role);

  for v_table in
    select c.oid, c.relname
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p')
      and c.relname not in ('platform_migrations', 'platform_table_policy')
    order by c.relname
  loop
    -- A partition inherits its root's policy; pg_partition_root() returns the table itself for a
    -- plain table, so the coalesce only guards a null from a non-partitioned relation. An
    -- unregistered table is read_write, which is the default for ordinary state.
    select coalesce(p.app_access, 'read_write')
      into v_access
      from platform_table_policy p
      where p.table_name = coalesce(
        (select r.relname from pg_class r where r.oid = pg_partition_root(v_table.oid)),
        v_table.relname
      );

    execute format('grant select on public.%I to %I', v_table.relname, p_role);

    if coalesce(v_access, 'read_write') = 'read_only' then
      execute format(
        'revoke insert, update, delete, truncate on public.%I from %I', v_table.relname, p_role);
    elsif coalesce(v_access, 'read_write') = 'append_only' then
      execute format('grant insert on public.%I to %I', v_table.relname, p_role);
      execute format('revoke update, delete, truncate on public.%I from %I', v_table.relname, p_role);
    else
      execute format('grant insert, update, delete on public.%I to %I', v_table.relname, p_role);
    end if;
  end loop;

  -- The registry and the migration log are readable but never writable by the application.
  -- retention_days in particular: it is what bounds platform_drop_expired_partitions().
  execute format('grant select on public.platform_table_policy to %I', p_role);
  execute format('grant select on public.platform_migrations to %I', p_role);

  execute format('grant usage, select on all sequences in schema public to %I', p_role);

  -- Partition maintenance runs as the application role (the WP-05 cron job); nothing else does.
  -- EXECUTE was already revoked from PUBLIC where each function is defined, so this only adds the
  -- one role that needs it.
  execute format('grant execute on function platform_ensure_partitions(integer) to %I', p_role);
  execute format('grant execute on function platform_drop_expired_partitions(text) to %I', p_role);

  -- pg-boss owns its schema and needs full DML there (TD-004).
  if to_regnamespace('pgboss') is not null then
    execute format('grant usage on schema pgboss to %I', p_role);
    execute format('grant all privileges on all tables in schema pgboss to %I', p_role);
    execute format('grant all privileges on all sequences in schema pgboss to %I', p_role);
    execute format('grant execute on all functions in schema pgboss to %I', p_role);
  end if;

  return true;
end
$$;

revoke all on function platform_apply_grants(text) from public;

comment on function platform_apply_grants(text) is
  'Applies the least-privilege grant set of technical/03 to the application role, returning whether it could. Re-run after every migration.';
