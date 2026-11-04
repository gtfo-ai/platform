-- migration-class: additive
-- 0092 — `platform_migrations.class`: the class each migration declares, recorded on apply (WP-271,
-- TD-032 decision 1, the TD-011 amendment of 2026-11-04).
--
-- Until now every migration was the same to the migrator, so nothing told an automatic updater
-- whether the build before a release could still run on the schema after it. From this file on,
-- every migration opens with a header line — `-- migration-class: additive` or
-- `-- migration-class: contract; expands: <nnnn>_<name>` — that `loadMigrations` parses and
-- `migrations:check` enforces, and the migrator writes the declared class into this column in the
-- same transaction as the file's own DDL. This file is the first to declare one, and it is
-- recorded with it: the column exists by the time its own row is inserted.
--
-- Every row applied before this file keeps `null`, which TD-032 reads as `contract` — those files
-- were never classified, and editing them to add a header would change the checksum every
-- installed database recorded (forward-only, TD-011).
--
-- **Additive by its own rule**: a nullable column the previous build never names, and its check
-- added `not valid` and then validated — every existing row is `null`, which the check admits. The
-- previous build's migrator inserts without the column, so its rows are `null` too.
alter table platform_migrations add column class text;

alter table platform_migrations add constraint platform_migrations_class_known
  check (class in ('additive', 'contract')) not valid;

alter table platform_migrations validate constraint platform_migrations_class_known;

comment on column platform_migrations.class is
  'The class the migration declared in its header (TD-032 decision 1): additive or contract. Null for every migration applied before 0092, read as contract.';
