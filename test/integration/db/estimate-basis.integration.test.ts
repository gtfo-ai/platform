/**
 * Migration **0022**'s two check constraints, against a real PostgreSQL (WP-28, Q71).
 *
 * The columns themselves are held to the Drizzle definitions by `schema-parity.integration.test.ts`
 * and their round trip through `CostStore.saveEstimate` by the shared cost-store suite. What neither
 * covers is the thing the migration *adds beyond a column*: the **pairing**, which is what makes
 * `estimate_basis` able to say three different things rather than two.
 *
 *  - `null` — the estimator has not run on this task;
 *  - `'unknown'` with a null estimate and zero samples — it ran and **refused**, because the project
 *    has no finished task to estimate from (standing rule 16: not a zero);
 *  - a basis with a number — the figure and where it came from.
 *
 * A `not null default 0` on `estimate_samples` would have collapsed the first two into the second,
 * which is why the constraint is asserted from both sides (standing rule 42) rather than described
 * in the migration's prose. The constraint names are asserted too: a rename is a schema change
 * somebody should have to notice, and an assertion on `rejects.toThrow()` alone would pass for a
 * typo in the column name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { withClient } from '../support/postgres.js';

let database: MigratedDatabase;
let projectId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('estimate-basis');
  await withClient(database.connectionString, async (client) => {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('estimate-basis') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as string;
  });
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

let ticket = 0;

/** Inserts a task with the given estimate columns; returns the error message, or `null`. */
const insertTask = async (columns: {
  basis: string | null;
  samples: number | null;
  estimateUsd?: number | null;
}): Promise<string | null> => {
  ticket += 1;
  return withClient(database.connectionString, async (client) => {
    try {
      await client.query(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template,
                            estimate_usd, estimate_basis, estimate_samples)
         values ($1, 'fake-jira', $2, 'https://jira.example.test/x', 'feature', $3, $4, $5)`,
        [projectId, `ACME-${ticket}`, columns.estimateUsd ?? null, columns.basis, columns.samples],
      );
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
};

describe('migration 0022 — what a task’s estimate is allowed to say', () => {
  it('accepts all three honest shapes', async () => {
    // Never estimated; the estimator's refusal; and a real figure with its provenance.
    expect(await insertTask({ basis: null, samples: null })).toBeNull();
    expect(await insertTask({ basis: 'unknown', samples: 0, estimateUsd: null })).toBeNull();
    expect(
      await insertTask({ basis: 'project_history', samples: 7, estimateUsd: 12.5 }),
    ).toBeNull();
    expect(await insertTask({ basis: 'org_history', samples: 3, estimateUsd: 4 })).toBeNull();
  });

  it('refuses a sample count with no basis, and a basis with no sample count', async () => {
    // Both directions of the pairing: a count with no statement attached, and a statement with no
    // count. Either one alone would let a reader believe the other field had been forgotten.
    expect(await insertTask({ basis: null, samples: 0 })).toContain(
      'tasks_estimate_samples_paired',
    );
    expect(await insertTask({ basis: 'project_history', samples: null })).toContain(
      'tasks_estimate_samples_paired',
    );
  });

  it('refuses a basis the platform does not publish', async () => {
    // `estimateBasisSchema` is the wire vocabulary and this is its storage half; a word only one of
    // them knows is exactly the drift the check exists for.
    expect(await insertTask({ basis: 'a_guess', samples: 1 })).toContain(
      'tasks_estimate_basis_known',
    );
  });

  it('refuses a negative sample count', async () => {
    expect(await insertTask({ basis: 'project_history', samples: -1 })).toContain(
      'tasks_estimate_samples_nonnegative',
    );
  });

  it('leaves an existing row alone — the migration backfills nothing, deliberately', async () => {
    // A task that already carried a number got it from a basis nobody recorded, and writing a word
    // into that column now would be inventing the provenance it exists to carry (standing rule 86).
    // So a pre-0022 row is exactly the first shape above, and the readers say "basis not recorded".
    ticket += 1;
    const row = await withClient(database.connectionString, async (client) => {
      const inserted = await client.query<{ estimate_basis: string | null }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template,
                            estimate_usd)
         values ($1, 'fake-jira', $2, 'https://jira.example.test/x', 'feature', 9)
         returning estimate_basis, estimate_samples`,
        [projectId, `ACME-${ticket}`],
      );
      return inserted.rows[0];
    });
    expect(row?.estimate_basis).toBeNull();
  });
});
