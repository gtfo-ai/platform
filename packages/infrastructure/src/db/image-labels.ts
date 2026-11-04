/**
 * The three labels the `platform` image carries for the updater (TD-032 decision 2, WP-272).
 *
 * An automatic code rollback from build B to build A is admitted only when A can run on B's schema
 * **and** on B's rows. The migration classes answer the first half for the statements; these
 * labels answer what no class can see:
 *
 * - **`org.platform.schema-guard`** — the version of `assertSchemaIsKnown` the build carries. `2` is
 *   the guard that starts on an all-`additive` unknown future; a build without the label (or with
 *   `1`) refuses every unknown migration, so a rollback to it can never be code-only.
 * - **`org.platform.rollback-floor`** — raised by every row that changes what existing rows mean to
 *   the runtime; a rollback is admitted only between equal floors. `migrations:check` holds a
 *   `raises-rollback-floor` migration to a larger value here than at its base.
 * - **`org.platform.pgboss-schema`** — the pg-boss schema version `runMigrations` installs, which no
 *   migration class sees; a rollback is admitted only between equal versions.
 *
 * **Where each value lives.** A Dockerfile `LABEL` cannot take a value a `RUN` computed, so the
 * labels are written in `docker/app.Dockerfile`, and this module is the value the *code* answers
 * with (`migrate --plan` prints it). `image-labels.test.ts` holds the two equal. The pg-boss value
 * is never typed here: it is read off the installed pg-boss's own `package.json` (`pgboss.schema`,
 * the number pg-boss's `Contractor` installs and migrates to), the Dockerfile's single literal is
 * checked against that same installed file **during the image build**, and the unit test compares
 * both with the version pg-boss writes into its own construction plan.
 */
import { createRequire } from 'node:module';
import * as z from 'zod';

export const SCHEMA_GUARD_LABEL = 'org.platform.schema-guard';
export const ROLLBACK_FLOOR_LABEL = 'org.platform.rollback-floor';
export const PGBOSS_SCHEMA_LABEL = 'org.platform.pgboss-schema';

/** The guard this build carries: 2 admits an all-`additive` unknown future (TD-032 decision 2). */
export const SCHEMA_GUARD_VERSION = 2;

/**
 * The rollback floor (TD-032 decision 2). **Raise it with the Dockerfile label** in a row that
 * changes what existing rows mean to the runtime (M22: WP-274, WP-276, WP-285, WP-286).
 *
 * **2 since WP-274** (migration 0094, `raises-rollback-floor`): this build writes a `run_offers` row
 * for every run and relies on the per-task index over them; a build before it writes none.
 *
 * **3 since WP-276** (no migration): the `stage.execute` job ends at the offer, so a live database
 * holds `created` runs with **open** offers that only a claimant runs. A build before it claims an
 * offer only in the job that wrote it, so it would leave every such offer open for ever — and its
 * per-task index would refuse the task's next stage.
 */
export const ROLLBACK_FLOOR = 3;

const pgBossManifestSchema = z.object({
  pgboss: z.object({ schema: z.number().int().positive() }),
});

/**
 * The pg-boss schema version the installed package installs: `pgboss.schema` in its manifest,
 * which is what its `Contractor` reads (`dist/contractor.js`: `packageJson.pgboss.schema`).
 * Resolved from this package, so it is the pg-boss `runMigrations` imports.
 */
export const readPgBossSchemaVersion = (): number =>
  pgBossManifestSchema.parse(createRequire(import.meta.url)('pg-boss/package.json')).pgboss.schema;

/** The three labels, keyed by name, as the image carries them. */
export const imageLabels = (): Readonly<Record<string, string>> => ({
  [SCHEMA_GUARD_LABEL]: String(SCHEMA_GUARD_VERSION),
  [ROLLBACK_FLOOR_LABEL]: String(ROLLBACK_FLOOR),
  [PGBOSS_SCHEMA_LABEL]: String(readPgBossSchemaVersion()),
});
