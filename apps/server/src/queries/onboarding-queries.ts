/**
 * The writes the onboarding wizard makes — product/06 steps 1 and 4 (WP-21).
 *
 * They live here, beside `identity-queries.ts`, for the reason that file states: `apps/server` is a
 * composition root and may name Drizzle directly, and inventing a repository port for "create a
 * project" would be a port with one caller and no second implementation. Everything the *pipeline*
 * writes goes through `PipelineStore`; nothing here touches a task, a run or an artifact.
 *
 * ## Four things that are decided rather than incidental
 *
 * **A credential never crosses the API.** `POST /api/integrations` takes `secret_refs` — the
 * **names** of environment variables — and this module reads the value out of the process
 * environment (or its `_FILE` companion, TD-020) and seals it with the same envelope the binding
 * loader opens. So a credential is supplied the way every other one is, by the operator to the
 * process, and the wizard never becomes a place a token is typed into a browser (BD-002).
 *
 * **Every command writes a `human_actions` row.** technical/08 § "Rate limits and safety": *"all
 * human actions recorded in `human_actions` and `config_audit`"*. The table is `append_only` in
 * `platform_table_policy`, so the row is the audit — nothing updates or deletes it — and its
 * `params` carry the `Idempotency-Key` the client sent, which is what lets an operator tell one
 * double-clicked create from two deliberate ones.
 *
 * **Idempotency is two mechanisms, because one of them cannot see the difference that matters.**
 * `projects.key`, `(integrations.org_id, type, name)` and `(tasks.project_id, ticket_key, mode)`
 * are unique indexes, so a retried create finds the row and answers with it instead of making a
 * second. A unique key cannot tell that retry from a **different** request sent under a used
 * `Idempotency-Key`, so every performed command also records a digest of its canonical request
 * beside the key in `human_actions` and {@link findIdempotentAttempt} refuses a later request whose
 * digest differs. There is still no stored *response* — a repeat with the same key and body is
 * answered by re-reading the resource, which is the same answer and one fewer thing to keep
 * consistent.
 *
 * **`PUT …/bindings` is the whole set.** A binding missing from the request is deleted, which is
 * what makes the step re-submittable and what lets an operator correct a mistake without a second
 * endpoint. The delete cascades nothing: `bindings` is referenced by nothing.
 */
import type {
  AutonomyLevel,
  Id,
  IntegrationType,
  JsonObject,
  ProjectBindingSummary,
  ProjectRecord,
} from '@platform/contracts';
import { projectRecordSchema } from '@platform/contracts';
import { db as dbAdapters, secrets as secretAdapters } from '@platform/infrastructure';
import type { ProviderCatalogueEntry } from '@platform/integrations';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { HttpError } from '../errors.js';
import type { Database } from './identity-queries.js';

const { bindings, humanActions, integrations, organizations, projects, secrets } =
  dbAdapters.schema;

/** The organisation this deployment is (product/01: a self-hosted instance has one). */
export const findOrganisationId = async (database: Database): Promise<string | null> => {
  const rows = await database.select({ id: organizations.id }).from(organizations).limit(1);
  return rows[0]?.id ?? null;
};

/**
 * The lock key the organisation bootstrap serialises on.
 *
 * An arbitrary constant, in the same spirit as the migrator's: two concurrent first-project
 * requests must not each create an organisation, and `organizations` has no unique column to
 * conflict on. Any value works as long as nothing else in the platform picks the same one, so it is
 * named here rather than inlined.
 */
export const ORGANISATION_BOOTSTRAP_LOCK = 4_214_210_001;

/**
 * The deployment's organisation, created on the first project if it does not exist yet.
 *
 * **Something has to create it and nothing did.** `bootstrapAdministrator` creates the first *user*
 * and deliberately no organisation (it goes through Better Auth's own sign-up so the password is
 * hashed by the code a login verifies it with), and every other row that needs an `org_id` — a
 * project, an integration — is written by a command that comes later. So a fresh instance had an
 * administrator who could not create a project, which WP-21 is the first work package to notice
 * because it is the first one to serve `POST /api/projects`. product/01 says a self-hosted instance
 * *has* one organisation, so creating it on demand is the reading with no second concept in it.
 *
 * **Serialised on an advisory lock**, because there is no unique key to conflict on: under READ
 * COMMITTED two concurrent requests would both see an empty table and both insert. The lock is
 * transaction-scoped, so it is released by the commit whatever happens.
 *
 * The name is a placeholder an administrator renames from the organisation settings; it is
 * deliberately not derived from the first project, which would make the organisation look like it
 * belongs to that project.
 */
export const ensureOrganisation = async (database: Database): Promise<string> => {
  const existing = await findOrganisationId(database);
  if (existing !== null) {
    return existing;
  }
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ORGANISATION_BOOTSTRAP_LOCK})`);
    const raced = await tx.select({ id: organizations.id }).from(organizations).limit(1);
    const found = raced[0]?.id;
    if (found !== undefined) {
      return found;
    }
    const inserted = await tx
      .insert(organizations)
      .values({ name: 'Default organisation' })
      .returning({ id: organizations.id });
    const created = inserted[0]?.id;
    if (created === undefined) {
      throw new HttpError(500, 'internal_error', 'the organisation row was not created');
    }
    return created;
  });
};

const toProjectRecord = (row: {
  id: string;
  key: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  agenticDir: string;
  knowledgeDir: string;
  autonomyLevel: AutonomyLevel;
  readinessLevel: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): ProjectRecord =>
  projectRecordSchema.parse({
    id: row.id,
    key: row.key,
    name: row.name,
    repo_url: row.repoUrl,
    default_branch: row.defaultBranch,
    agentic_dir: row.agenticDir,
    knowledge_dir: row.knowledgeDir,
    autonomy_level: row.autonomyLevel,
    readiness_level: row.readinessLevel,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });

const PROJECT_COLUMNS = {
  id: projects.id,
  key: projects.key,
  name: projects.name,
  repoUrl: projects.repoUrl,
  defaultBranch: projects.defaultBranch,
  agenticDir: projects.agenticDir,
  knowledgeDir: projects.knowledgeDir,
  autonomyLevel: projects.autonomyLevel,
  readinessLevel: projects.readinessLevel,
  status: projects.status,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};

export interface CreateProjectInput {
  readonly key: string;
  readonly name: string;
  readonly repoUrl: string;
  readonly defaultBranch?: string;
  readonly knowledgeDir?: string;
}

export type CreateProjectResult =
  | { readonly status: 'created'; readonly project: ProjectRecord }
  /** A project with this key already exists — the create is idempotent on it. */
  | { readonly status: 'exists'; readonly project: ProjectRecord };

/**
 * Creates a project, or answers with the one that already has this key.
 *
 * `on conflict (key) do nothing` and then a read, rather than a read and then an insert: two wizard
 * clicks race, and the unique index is what actually decides. The read afterwards is what turns the
 * loser into an answer rather than into a 500.
 */
export const createProject = async (
  database: Database,
  orgId: string,
  input: CreateProjectInput,
  /**
   * The `human_actions` row, written in the **same transaction as the insert**.
   *
   * It carries the `Idempotency-Key` and the request digest, so it is not only the audit: it is the
   * record `findIdempotentAttempt` reads to refuse a reused key. Written separately, a crash between
   * the insert and the audit leaves a project nobody can be refused a *different* request for.
   */
  audit?: HumanActionInput,
): Promise<CreateProjectResult> => {
  const inserted = await database.transaction(async (tx) => {
    const created = await tx
      .insert(projects)
      .values({
        orgId,
        key: input.key,
        name: input.name,
        repoUrl: input.repoUrl,
        ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
        ...(input.knowledgeDir === undefined ? {} : { knowledgeDir: input.knowledgeDir }),
      })
      .onConflictDoNothing({ target: projects.key })
      .returning(PROJECT_COLUMNS);
    if (created[0] !== undefined && audit !== undefined) {
      await insertHumanAction(tx, {
        ...audit,
        params: { ...audit.params, project_id: created[0].id },
      });
    }
    return created;
  });
  const row = inserted[0];
  if (row !== undefined) {
    return { status: 'created', project: toProjectRecord(row) };
  }
  const existing = await database
    .select(PROJECT_COLUMNS)
    .from(projects)
    .where(eq(projects.key, input.key))
    .limit(1);
  const found = existing[0];
  if (found === undefined) {
    // Unreachable: the insert conflicted, so a row with this key exists. Named rather than
    // non-null-asserted, because a 500 with no message is the worst answer to a race.
    throw new HttpError(
      409,
      'conflict',
      `project key "${input.key}" was taken and released while this request ran; try again`,
    );
  }
  return { status: 'exists', project: toProjectRecord(found) };
};

export const findProjectById = async (
  database: Database,
  projectId: string,
): Promise<ProjectRecord | null> => {
  const rows = await database
    .select(PROJECT_COLUMNS)
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toProjectRecord(row);
};

/**
 * Reads a credential out of the process environment, honouring TD-020's `_FILE` convention.
 *
 * The name is the operator's own configuration and is echoed in the refusal; the **value** never
 * is. An empty value is a refusal rather than an empty credential (standing rule 18).
 *
 * ## The name is caller-chosen, so it is checked against an operator-declared allow-list first
 *
 * `secret_refs` reaches this function from an HTTP body written by an `integration.write` caller.
 * Without a constraint that caller can name `APP_SECRET_KEY`, `DATABASE_URL` or
 * `ANTHROPIC_API_KEY` and have the platform seal **its own** secret into a `secrets` row that a
 * provider adapter is then built with — and a provider's `base_url` is caller-chosen too (no host
 * allow-list; see the residual below), so that is two API calls to send the envelope key to a host
 * the caller picked.
 *
 * It is an **allow-list** (`APP_INTEGRATION_SECRET_ENV`), not a deny-list of the platform's own
 * names: a deny-list is a claim about every variable the platform will ever have and is wrong the
 * first time one is added — standing rule 55's lesson, one ring out from paths. Empty means nothing
 * is readable, which is the fail-closed direction and is the default.
 *
 * **Residual, stated rather than implied:** nothing constrains a provider's `base_url`. A caller
 * who *is* allowed to read `GITLAB_TOKEN` can still point the GitLab integration at a host they
 * control and have the probe send that token there. A host allow-list for provider configuration is
 * a separate piece of work, recorded in `PROGRESS.md` under Discovered work; this allow-list closes
 * the half where the credential is the **platform's own**, which is the one no provider
 * configuration should ever be able to reach.
 */
export interface SecretSource {
  read(name: string): Promise<string>;
}

export class MissingSecretError extends Error {
  override readonly name = 'MissingSecretError';
}

/** A name the caller may not read. Distinct from {@link MissingSecretError}: it is a refusal. */
export class ForbiddenSecretNameError extends Error {
  override readonly name = 'ForbiddenSecretNameError';
}

export const environmentSecretSource = (
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => Promise<string>,
  /**
   * The declared names, from `APP_INTEGRATION_SECRET_ENV`. **Required, never defaulted**: a default
   * of "everything" is the defect this parameter exists to make impossible, and a default of
   * "nothing" would let a composition root forget it and still look configured (standing rule 31).
   */
  allowed: Iterable<string>,
): SecretSource => {
  const declared = new Set(allowed);
  return {
    read: async (name: string) => {
      if (!declared.has(name)) {
        /**
         * The refusal says nothing about whether the variable **exists**.
         *
         * A message that distinguished "not declared" from "declared but unset" would make this
         * endpoint an oracle for the process's environment: a caller could walk names and learn
         * which ones the platform has. It names the setting and the declared list, both of which
         * are the operator's own configuration.
         */
        throw new ForbiddenSecretNameError(
          `this deployment does not permit reading "${name}" as an integration credential. ` +
            `Add it to APP_INTEGRATION_SECRET_ENV (declared: ${declared.size === 0 ? 'none' : [...declared].join(', ')}) and restart the process`,
        );
      }
      const filePath = env[`${name}_FILE`];
      if (filePath !== undefined && filePath.length > 0) {
        const value = (await readFile(filePath)).trim();
        if (value.length === 0) {
          throw new MissingSecretError(`${name}_FILE points at a file with nothing in it`);
        }
        return value;
      }
      const value = env[name];
      if (value === undefined || value.length === 0) {
        throw new MissingSecretError(
          `no value for ${name}: set it (or ${name}_FILE) in the environment of this process, then create the integration again`,
        );
      }
      return value;
    },
  };
};

export interface CreateIntegrationInput {
  readonly type: IntegrationType;
  readonly provider: string;
  readonly name: string;
  readonly config: JsonObject;
  /** Environment variable names, one per credential field the provider declares. */
  readonly secretRefs: Readonly<Record<string, string>>;
}

export interface IntegrationRow {
  readonly id: string;
  readonly type: IntegrationType;
  readonly provider: string;
  readonly name: string;
}

export type CreateIntegrationResult =
  | { readonly status: 'created'; readonly integration: IntegrationRow }
  | { readonly status: 'exists'; readonly integration: IntegrationRow };

/**
 * Refuses a `config` document that carries one of the provider's **credential** fields.
 *
 * **This is what makes "no credential crosses this API" true rather than claimed**, and three
 * docblocks claim it. `secret_refs` is checked against `provider.secretFields`, but `config` is an
 * opaque `jsonObjectSchema` on the wire — so `POST /api/integrations` with
 * `config: { api_token: "…" }` stored a **plaintext** credential in `integrations.config`: a value
 * `SecretStore` does not know about, that no rotation walks (rotation reads
 * `integrations.secret_ids`), and that the binding loader and the prober then merge into the
 * adapter anyway (`{...account.config, ...secrets}`).
 *
 * **The read-side strip is not the guard.** `publishableConfig` removes exactly these keys before
 * `GET /api/integrations` publishes a row, which is why the leak was not visible from the API — and
 * a guard whose only layer is the one that hides the value is standing rule 22's shape. The strip
 * stays: it covers rows written before this check existed and rows an operator wrote with `psql`.
 * This is the layer that stops the row being created.
 *
 * `createIntegration` is the **only** writer of `integrations.config` in this repository
 * (`writeIntegrationHealth` names `health` and nothing else; `PATCH /api/integrations/:id` is
 * unbuilt), so one call site is the whole coverage. A second writer has to come through here.
 */
export const assertNoCredentialInConfig = (
  config: JsonObject,
  provider: ProviderCatalogueEntry,
): void => {
  const declared = new Set(provider.secretFields);
  const offending = Object.keys(config).filter((key) => declared.has(key));
  if (offending.length > 0) {
    // The **key names**, never the values: this message reaches a log and an HTTP response, and the
    // values are exactly what the caller should not have sent.
    throw new HttpError(
      400,
      'credential_in_config',
      `"${offending.join('", "')}" ${offending.length === 1 ? 'is a credential field' : 'are credential fields'} of provider "${provider.id}" and must not be sent in \`config\`: name the environment variable in \`secret_refs\` instead, so the value is read by this server and sealed into \`secrets\` rather than stored in a column`,
    );
  }
};

/**
 * Creates an integration with its credentials sealed into `secrets`.
 *
 * The secret ids are generated here rather than by the column default because the id is in the
 * envelope's AAD, so it has to exist before the ciphertext does (`envelope.ts` — the same reason
 * the e2e harness's `seedWorld` does it by hand).
 *
 * A `secret_refs` entry naming a field the provider does not declare is refused: it would seal a
 * value the loader will never merge, which is a credential stored for nothing. A **`config`** key
 * that names one is refused too — {@link assertNoCredentialInConfig} says why that is the
 * load-bearing half.
 */
export const createIntegration = async (
  database: Database,
  input: {
    readonly orgId: string;
    readonly integration: CreateIntegrationInput;
    readonly provider: ProviderCatalogueEntry;
    readonly secretSource: SecretSource;
    readonly secretKey: secretAdapters.SecretKey;
    readonly newId: () => string;
    /** The audit row, written in the same transaction — see {@link createProject}'s. */
    readonly audit?: HumanActionInput;
  },
): Promise<CreateIntegrationResult> => {
  assertNoCredentialInConfig(input.integration.config, input.provider);

  const declared = new Set(input.provider.secretFields);
  const unknown = Object.keys(input.integration.secretRefs).filter((field) => !declared.has(field));
  if (unknown.length > 0) {
    throw new HttpError(
      400,
      'invalid_request',
      `provider "${input.provider.id}" declares no credential field named ${unknown.join(', ')}; it declares ${[...declared].join(', ') || 'none'}`,
    );
  }

  const existing = await database
    .select({
      id: integrations.id,
      type: integrations.type,
      provider: integrations.provider,
      name: integrations.name,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.orgId, input.orgId),
        eq(integrations.type, input.integration.type),
        eq(integrations.name, input.integration.name),
      ),
    )
    .limit(1);
  const found = existing[0];
  if (found !== undefined) {
    // Idempotent on `(org_id, type, name)`. Nothing is re-sealed and no secret row is orphaned:
    // re-reading the environment here would write a second `secrets` row nothing points at.
    return { status: 'exists', integration: found as IntegrationRow };
  }

  /**
   * The credentials are **read before the transaction opens** and sealed inside it.
   *
   * `secretSource.read` touches the filesystem for a `_FILE` companion, and a transaction held
   * across a file read is a pooled connection held across somebody else's I/O — the same shape
   * CLAUDE.md's *transaction / no transaction / transaction* rule exists for, one ring smaller.
   * Everything after it is database work.
   */
  const sealed: { readonly id: string; readonly ciphertext: Buffer }[] = [];
  for (const [field, ref] of Object.entries(input.integration.secretRefs)) {
    const value = await input.secretSource.read(ref);
    const secretId = input.newId();
    sealed.push({
      id: secretId,
      ciphertext: secretAdapters.sealSecret(
        input.secretKey,
        secretAdapters.secretDocument(field, value),
        secretId,
      ),
    });
  }

  /**
   * **One transaction for the `secrets` rows and the `integrations` row that points at them.**
   *
   * Separately, a failure between them orphans ciphertext nothing references — and this module's
   * own idempotency comment calls such a row unrotatable, because rotation walks
   * `integrations.secret_ids`. Nothing would ever delete it, and nothing would ever report it.
   */
  const row = await database.transaction(async (tx) => {
    for (const secret of sealed) {
      await tx
        .insert(secrets)
        .values({ id: secret.id, ciphertext: secret.ciphertext, keyId: input.secretKey.keyId });
    }
    const inserted = await tx
      .insert(integrations)
      .values({
        orgId: input.orgId,
        type: input.integration.type,
        provider: input.integration.provider,
        name: input.integration.name,
        config: input.integration.config,
        secretIds: sealed.map((secret) => secret.id),
      })
      .returning({
        id: integrations.id,
        type: integrations.type,
        provider: integrations.provider,
        name: integrations.name,
      });
    const created = inserted[0];
    if (created !== undefined && input.audit !== undefined) {
      await insertHumanAction(tx, {
        ...input.audit,
        params: { ...input.audit.params, integration_id: created.id },
      });
    }
    return created;
  });
  if (row === undefined) {
    throw new HttpError(500, 'internal_error', 'the integration row was not created');
  }
  return { status: 'created', integration: row as IntegrationRow };
};

export const listProjectBindings = async (
  database: Database,
  projectId: string,
): Promise<readonly ProjectBindingSummary[]> => {
  const rows = await database
    .select({
      integrationId: bindings.integrationId,
      type: integrations.type,
      provider: integrations.provider,
      name: integrations.name,
      config: bindings.config,
    })
    .from(bindings)
    .innerJoin(integrations, eq(integrations.id, bindings.integrationId))
    .where(eq(bindings.projectId, projectId))
    .orderBy(integrations.type, integrations.name);
  return rows.map((row) => ({
    integration_id: row.integrationId as Id,
    type: row.type,
    provider: row.provider,
    name: row.name,
    config: row.config,
  }));
};

/**
 * Replaces a project's bindings with exactly the set given.
 *
 * One transaction: a wizard that removed every binding and then failed to add the new ones would
 * leave a project the pipeline cannot run at all.
 */
export const replaceProjectBindings = async (
  database: Database,
  projectId: string,
  items: readonly { readonly integrationId: string; readonly config?: JsonObject }[],
): Promise<void> => {
  const ids = items.map((item) => item.integrationId);
  await database.transaction(async (tx) => {
    if (ids.length > 0) {
      const known = await tx
        .select({ id: integrations.id })
        .from(integrations)
        .where(inArray(integrations.id, ids));
      const missing = ids.filter((id) => !known.some((row) => row.id === id));
      if (missing.length > 0) {
        throw new HttpError(
          400,
          'invalid_request',
          `no integration with id ${missing.join(', ')}; create the integration before binding it`,
        );
      }
    }
    await tx.delete(bindings).where(eq(bindings.projectId, projectId));
    for (const item of items) {
      await tx.insert(bindings).values({
        projectId,
        integrationId: item.integrationId,
        config: item.config ?? {},
      });
    }
  });
};

export interface WriteProjectConfigInput {
  readonly config: JsonObject;
  readonly hash: string;
  readonly autonomyLevel?: AutonomyLevel;
  /** The hash the client last read; `undefined` skips the check. */
  readonly baseHash?: string;
}

export type WriteProjectConfigResult =
  | { readonly status: 'written' }
  | { readonly status: 'not_found' }
  /** The stored configuration moved since the client read it (technical/08's `base_hash`). */
  | { readonly status: 'conflict'; readonly currentHash: string | null };

/**
 * Writes the project's configuration, and the autonomy dial with it.
 *
 * **Narrow, like every other writer that shares a row** (standing rule 79): the statement names
 * `config`, `config_source`, `config_hash`, `updated_at` and — only when the caller sent one —
 * `autonomy_level`. It never names `readiness_level`, which `PostgresReadinessStore` owns and which
 * the discovery job may be writing at the same moment.
 */
export const writeProjectConfig = async (
  database: Database,
  projectId: string,
  input: WriteProjectConfigInput,
): Promise<WriteProjectConfigResult> => {
  const current = await database
    .select({ hash: projects.configHash })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = current[0];
  if (row === undefined) {
    return { status: 'not_found' };
  }
  if (input.baseHash !== undefined && (row.hash ?? 'unconfigured') !== input.baseHash) {
    return { status: 'conflict', currentHash: row.hash };
  }
  const updated = await database
    .update(projects)
    .set({
      config: input.config,
      // Every key came from this request, so every key's source is `project`. The per-key map is
      // what `GET …/config` publishes; a repository's `.agentic/config.yml` overwrites it with
      // `repo` when the merge runs (technical/12).
      configSource: { '*': 'project' },
      configHash: input.hash,
      updatedAt: new Date(),
      ...(input.autonomyLevel === undefined ? {} : { autonomyLevel: input.autonomyLevel }),
    })
    .where(
      input.baseHash === undefined
        ? eq(projects.id, projectId)
        : and(
            eq(projects.id, projectId),
            input.baseHash === 'unconfigured'
              ? sql`${projects.configHash} is null or ${projects.configHash} = 'unconfigured'`
              : eq(projects.configHash, input.baseHash),
          ),
    )
    .returning({ id: projects.id });
  if (updated.length === 0) {
    // The row moved between the read above and this write — the optimistic check doing its job.
    return { status: 'conflict', currentHash: row.hash };
  }
  return { status: 'written' };
};

/**
 * Writes `integrations.health` — the column `GET /api/integrations` publishes and that nothing
 * wrote before WP-21. The read's own description carried the sentence *"nothing does in this
 * build, and `POST /api/integrations/:id/test` is the endpoint that would"*; this is that
 * endpoint, and that sentence is corrected there rather than left true-sounding.
 *
 * **One column** (standing rule 79): the statement never names `config` or `secret_ids`, which
 * belong to the create and which a wizard may be writing at the same moment.
 */
export const writeIntegrationHealth = async (
  database: Database,
  integrationId: string,
  probe: { readonly ok: boolean; readonly checkedAt: string; readonly detail: string },
): Promise<void> => {
  await database
    .update(integrations)
    .set({
      health: {
        status: probe.ok ? 'ok' : 'down',
        checked_at: probe.checkedAt,
        // Provider text, already through the integration's redactor (`createIntegrationProber`).
        detail: probe.detail,
      },
    })
    .where(eq(integrations.id, integrationId));
};

/**
 * Records a human action — technical/08 § "Rate limits and safety" (append-only, technical/03).
 *
 * `taskId` is null for every wizard command: the wizard configures a project, and `human_actions`
 * has no project column. The project id therefore travels in `params`, which is where the audit
 * reader looks anyway.
 *
 * `bodyDigest` is what makes technical/08's `Idempotency-Key` mean what the documents say it
 * means — see {@link findIdempotentAttempt}.
 */
export interface HumanActionInput {
  readonly userId: string;
  readonly action: string;
  readonly params: JsonObject;
  readonly taskId?: string | null;
}

/** The insert itself, so a caller inside a transaction and one outside share one statement. */
const insertHumanAction = async (
  executor: Pick<Database, 'insert'>,
  input: HumanActionInput,
): Promise<void> => {
  await executor.insert(humanActions).values({
    taskId: input.taskId ?? null,
    userId: input.userId,
    action: input.action,
    params: input.params,
  });
};

export const recordHumanAction = async (
  database: Database,
  input: HumanActionInput,
): Promise<void> => insertHumanAction(database, input);

/**
 * What a previous attempt under this `Idempotency-Key` asked for, or `null` when there was none.
 *
 * **This is the store technical/08's header implies, built out of a table that already exists.**
 * The idempotency of each wizard command is its unique key (`projects.key`,
 * `(integrations.org_id, type, name)`, `(tasks.project_id, ticket_key, mode)`), which makes a
 * *retry* cheap and correct — but a unique key cannot tell a retry from a **different request sent
 * under a used key**, and four places in this repository claim it can. `human_actions` is
 * append-only (`platform_table_policy`), one row is written per performed command, and it already
 * carries the key; adding a digest of the canonical body to the same row is the whole mechanism,
 * with no new table and no migration.
 *
 * What it is **not**: a stored *response*. A repeat with the same key and the same body is answered
 * by re-reading the resource through its natural key, not by replaying bytes — which is the same
 * answer and is one fewer thing to keep consistent. A repeat with a *different* body is a 409.
 *
 * Scoped by `action` as well as by the key, deliberately: two different commands are allowed to
 * share a key (a client that uses one key per wizard step would otherwise collide with itself), and
 * what must not happen is one command being replayed with different arguments.
 *
 * ## Two residuals, named rather than implied
 *
 * **A crash between the effect and the record.** `createProject` and `createIntegration` write the
 * `human_actions` row **inside** the transaction that performs the effect, so for those two there is
 * no window. `POST …/discovery` cannot: its effect is a pipeline transaction in the application
 * ring that this route does not hold, so a crash between the two leaves a discovery task whose key
 * has no digest, and a later *different* request under that key is answered by the natural key
 * (`already_started`) instead of being refused. The direction is the safe one — nothing is created
 * twice — and the cost is a 409 that does not happen.
 *
 * **Two concurrent requests with the same key.** Both read "no previous attempt" before either
 * commits (READ COMMITTED), so both proceed and the second is not refused; the unique key still
 * stops a second row, so what is lost is again only the 409. Closing it needs a **unique index on
 * `(action, params->>'idempotency_key')`**, which is a migration and which would also turn a
 * legitimate retry into a constraint violation that this function would have to catch and read as
 * "already performed" — a different design, not a stricter one. Nobody owns it; `PROGRESS.md`
 * carries it.
 */
export const findIdempotentAttempt = async (
  database: Database,
  action: string,
  key: string,
): Promise<{ readonly bodyDigest: string | null } | null> => {
  const rows = await database
    .select({ params: humanActions.params })
    .from(humanActions)
    .where(
      and(
        eq(humanActions.action, action),
        sql`${humanActions.params} ->> 'idempotency_key' = ${key}`,
      ),
    )
    .orderBy(desc(humanActions.createdAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const digest = (row.params as Record<string, unknown>).body_digest;
  return { bodyDigest: typeof digest === 'string' ? digest : null };
};
