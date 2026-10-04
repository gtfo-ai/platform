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
 * beside the key — in `command_idempotency` since WP-67, completed by the `human_actions` row in
 * the same statement set — and {@link findIdempotentAttempt} refuses a later request whose digest
 * differs. There is still no stored *response* — a repeat with the same key and body is
 * answered by re-reading the resource, which is the same answer and one fewer thing to keep
 * consistent.
 *
 * **`PUT …/bindings` is the whole set.** A binding missing from the request is deleted, which is
 * what makes the step re-submittable and what lets an operator correct a mistake without a second
 * endpoint. The delete cascades nothing: `bindings` is referenced by nothing.
 */
import type { IntegrationEgressPolicy } from '@platform/application';
import { egressHostOf, RECREATE_TO_APPLY_SETTING } from '@platform/application';
import type {
  AutonomyLevel,
  Id,
  IntegrationType,
  IsoDateTime,
  JsonObject,
  JsonValue,
  MaterialisedAutonomy,
  ProjectBindingSummary,
  ProjectRecord,
} from '@platform/contracts';
import { projectRecordSchema } from '@platform/contracts';
import { DEFAULT_AUTONOMY_LEVEL, materialiseAutonomy } from '@platform/domain';
import { db as dbAdapters, secrets as secretAdapters } from '@platform/infrastructure';
import type { ProviderCatalogueEntry } from '@platform/integrations';
import {
  configIssuesOf,
  declaresStaticRunCredential,
  findShippedProvider,
  staticRunCredentialWriteIssues,
} from '@platform/integrations';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { HttpError } from '../errors.js';
import { completeCommandAttempt, findCommandAttempt } from './idempotency-queries.js';
import type { Database } from './identity-queries.js';
import {
  describeConfigIssues,
  publishableConfig,
  storedConfigRefusal,
} from './integration-queries.js';

const {
  bindings,
  commandIdempotency,
  humanActions,
  integrations,
  organizations,
  projects,
  secrets,
  tasks,
} = dbAdapters.schema;

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
        // BD-027:14 — the dial is materialised at **selection time**, and a project that has not
        // reached step 4 has still selected one: the column's default, `supervised`. Writing the
        // preset here rather than leaving the column null is what makes the level the row starts
        // with mean the same thing a year from now (`migrations/0021_autonomy_materialised.sql`).
        autonomyPolicies: materialiseAutonomy({
          level: DEFAULT_AUTONOMY_LEVEL,
          at: new Date().toISOString() as IsoDateTime,
          // The wizard's creator did not choose a *dial position*; they created a project. Naming
          // them here would read as "this person set Supervised", which they did not.
          appliedBy: null,
        }),
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
 * provider adapter is then built with — and a provider's `base_url` is caller-chosen too, so that
 * was two API calls to send the envelope key to a host the caller picked. The second half of that
 * is closed since WP-51: {@link assertHostIsDeclared}.
 *
 * It is an **allow-list** (`APP_INTEGRATION_SECRET_ENV`), not a deny-list of the platform's own
 * names: a deny-list is a claim about every variable the platform will ever have and is wrong the
 * first time one is added — standing rule 55's lesson, one ring out from paths. Empty means nothing
 * is readable, which is the fail-closed direction and is the default.
 *
 * **The other half, closed at WP-51** (PROGRESS backlog 48). This list closes the case where the
 * credential is the **platform's own**; a caller who *is* allowed to read `GITLAB_TOKEN` could
 * still point the GitLab integration at a host they control and have the probe send that token
 * there. {@link assertHostIsDeclared} is the write-time refusal for that, and the executor's own
 * `egress` option refuses the call for a row this function never saw. What remains is the residual
 * that survives both: an operator who declares a host is trusting it, and the platform does not
 * check where that name resolves (`createIntegrationEgressPolicy` lists what it cannot see).
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
            `Add it to APP_INTEGRATION_SECRET_ENV (declared: ${declared.size === 0 ? 'none' : [...declared].join(', ')}) ${RECREATE_TO_APPLY_SETTING}`,
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
          `no value for ${name}: set it (or ${name}_FILE) in the environment of this process, then create the integration again — or, for an existing one, re-seal it (\`POST /api/integrations/:id/secrets\`)`,
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
 * Two call sites are the whole coverage because `createIntegration` and, since WP-100,
 * `updateIntegrationConfig` (`PATCH /api/integrations/:id`) are the only writers of
 * `integrations.config` — a claim about every other file, so it is not asserted here: it is held by
 * `queries/integration-config-writers.test.ts`, whose declared list is those two statements, and
 * whose docblock states the spellings it cannot see (standing rule 63, PROGRESS backlog 130). A
 * third writer fails that census until it is declared there, and has to come through here. This
 * refusal has **no** call-time twin, deliberately: the write answers the question once, and the
 * census is the cheaper closure.
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
 * Refuses a `config` document that would point this binding at a host nobody declared (WP-51,
 * PROGRESS backlog 48).
 *
 * **The write-time half of the egress allow-list**, and it is half on purpose: `integrations.config`
 * outlives the list that admitted it, so the executor asks the same question again at call time
 * (`createIntegrationEgressPolicy`, `IntegrationActionExecutorOptions.egress`). A row written before
 * an operator narrowed the list, or written with `psql`, reaches the second check and not this one.
 * What this one buys is the refusal arriving *where the mistake is made*, naming the host and the
 * setting, instead of six screens later as a failed probe.
 *
 * **Every string in the document that parses as an absolute URL is checked**, rather than a declared
 * per-provider field name. Standing rule 7: a table of "which key holds the host" is a table that
 * drifts, and the first provider with a second URL field would have one key checked and one not.
 * Measured against the five shipped schemas, nothing else in a config document parses as an absolute
 * URL — a `project` is `acme/api`, a `channel` is `#agentic`, a `team_id` is `T…`, an `organization`
 * is a slug — so the sweep costs no false refusal on the shipped field *values* and covers a sixth
 * provider the day it exists. **A default is swept too** (WP-73b, PROGRESS backlog 245): the caller
 * passes the body with the provider's `configDefaults` under it, so a Sentry or Slack body that
 * leaves `base_url` out is judged by the host it will actually call. That is the *effective*
 * document field by field, not a full parse of the provider's schema: the create body carries no
 * credential fields and a strict parse would refuse every one of them. **A false refusal**: `new URL()` is the parser and any colon-bearing string parses —
 * `'Mon: 9-5'` and `mailto:…` both answer 403 `integration_host_not_permitted` — so a value that
 * is not a URL is not "left alone" if it carries a colon; the shipped schemas have no such field,
 * and the direction is the fail-closed one.
 *
 * The walk is recursive over objects and arrays because `config` is `jsonObjectSchema` on the wire —
 * strictly shaped only once the provider's own schema sees it, which since WP-100 happens *after*
 * this guard ({@link assertConfigParses}), so the host refusal keeps its own code and message. Rule
 * 14: this is a runtime check over a body that reached the process as JSON, not a claim `tsc` makes.
 *
 * It runs on both writers of the column — the create and `updateIntegrationConfig` — and on a
 * binding's overlay (`assertBindingConfigsParse`); `queries/integration-config-writers.test.ts` is
 * what holds that the first two are the only writers.
 *
 * @throws {HttpError} 403 `integration_host_not_permitted` — the request is well formed and this
 * deployment does not permit it, which is the reading `secret_name_not_permitted` already has.
 */
export const assertHostIsDeclared = (config: JsonObject, egress: IntegrationEgressPolicy): void => {
  const visit = (value: JsonValue): void => {
    if (typeof value === 'string') {
      // Not every string is a URL, and one that is not is not this guard's business: `egressHostOf`
      // returns `null` for it and the value is left alone.
      if (egressHostOf(value) === null) {
        return;
      }
      const verdict = egress.check(value);
      if (!verdict.allowed) {
        // The verdict's message, never the value: a config document is a place somebody may have
        // pasted a credential, and this message reaches an HTTP response and a log line.
        throw new HttpError(403, 'integration_host_not_permitted', verdict.message);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) {
        visit(item);
      }
    }
  };
  visit(config);
};

/**
 * Refuses a configuration document the provider's own schema refuses (WP-100, PROGRESS backlog 328).
 *
 * The question `bindings/loader.ts` and `bindings/prober.ts` ask at **use**, asked at the **write**
 * — rule 20's refusal moved to where the mistake is made. It runs through the catalogue
 * (`configIssuesOf`), never a constructed provider: a write surface holds no secrets, executor or
 * clock. Credential fields are judged separately — {@link assertNoCredentialInConfig} refuses one
 * in the body, and the secrets are sealed rather than stored — so the document is parsed without
 * them.
 *
 * @throws {HttpError} 400 `invalid_integration_config`, naming each key path in the message and in
 * `details`, never a value.
 */
export const assertConfigParses = (config: JsonObject, provider: ProviderCatalogueEntry): void => {
  const issues = configIssuesOf(provider, config);
  if (issues.length > 0) {
    throw new HttpError(
      400,
      'invalid_integration_config',
      `the configuration is refused by provider "${provider.id}"'s schema at: ${describeConfigIssues(issues)}. Its required fields are ${
        provider.configFields
          .filter((field) => field.required)
          .map((field) => field.name)
          .join(', ') || 'none'
      } (GET /api/integrations/providers lists them all); credentials go in \`secret_refs\`, never in \`config\``,
      issues.map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }
};

/**
 * **A static run credential is refused at every write, by name** (TD-028 decision 13 item 1,
 * WP-137): `static` with no run token, a run token equal to the API token (the two decrypted values
 * compared), and an expiry passed or more than the provider's bound ahead — the configuration-only
 * rules (`static` beside minting, no username, no expiry) are {@link assertConfigParses}' already.
 * `secrets` is the integration's whole credential set as it will be **after** the write. Paths and
 * the rule's words only, never a value.
 */
export const assertStaticRunCredentialWrite = (
  provider: ProviderCatalogueEntry,
  config: Readonly<Record<string, unknown>>,
  secretValues: Readonly<Record<string, string>>,
  now: Date,
): void => {
  const issues = staticRunCredentialWriteIssues(
    provider.staticRunCredential ?? undefined,
    config,
    secretValues,
    now,
  );
  if (issues.length > 0) {
    throw new HttpError(
      400,
      'run_credential_refused',
      `the static run credential is refused: ${issues.map((issue) => `${issue.path} — ${issue.message}`).join('; ')}`,
      issues.map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }
};

/**
 * The integration's sealed credentials, opened — field to value — for the static run credential's
 * write checks only (WP-137). A row that cannot be opened is skipped: it already fails every load,
 * and the check then reads its field as absent, which refuses rather than admits.
 */
const openSealedValues = async (
  tx: Pick<Database, 'select'>,
  key: secretAdapters.SecretKey,
  secretIds: readonly string[],
): Promise<Record<string, string>> => {
  if (secretIds.length === 0) {
    return {};
  }
  const rows = await tx
    .select({ id: secrets.id, ciphertext: secrets.ciphertext })
    .from(secrets)
    .where(inArray(secrets.id, [...secretIds]));
  const values: Record<string, string> = {};
  for (const row of rows) {
    try {
      const document = secretAdapters.secretDocumentSchema.parse(
        JSON.parse(secretAdapters.openSecret(key, row.ciphertext, row.id)),
      );
      values[document.field] = document.value;
    } catch {
      // Never the plaintext and never the error's text: the field reads as absent.
    }
  }
  return values;
};

/**
 * **A static integration is bound by one project** (TD-028 decision 13 item 1): the run token's
 * reach is a membership the platform cannot see, and a second project would share it. Asked under
 * a transaction-scoped advisory lock on the integration, so two binding writes of two projects —
 * which both hold the integration row only `for share` — cannot both pass. `exceptProject` is the
 * project being written (its own rows are replaced); `null` counts every binding.
 */
export const assertStaticIntegrationBindable = async (
  tx: Pick<Database, 'execute'>,
  integrationId: string,
  exceptProject: string | null,
  bindingsAfter: number,
): Promise<void> => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`static-run-credential:${integrationId}`}, 0))`,
  );
  const { rows } = await tx.execute<{ project_id: string }>(sql`
    select project_id from bindings
     where integration_id = ${integrationId}
       and (${exceptProject}::uuid is null or project_id <> ${exceptProject}::uuid)
     order by project_id`);
  if (rows.length + bindingsAfter > 1) {
    throw new HttpError(
      409,
      'static_run_credential_shared',
      `integration ${integrationId} gives its runs a static run credential, and a static integration may be bound by one project only — its run token reaches every project its user is a member of, which the platform cannot see (TD-028 decision 13); it is bound by ${rows.map((row) => row.project_id).join(', ') || 'no other project'}. Create a second integration with its own dedicated run token instead`,
    );
  }
};

export interface UpdateIntegrationConfigInput {
  readonly integrationId: string;
  /** Keys to set. */
  readonly set: JsonObject;
  /** Keys to delete. */
  readonly remove: readonly string[];
  /** `APP_INTEGRATION_HOSTS`, required for the reason `createIntegration` gives. */
  readonly egress: IntegrationEgressPolicy;
  /**
   * Opens the sealed credentials a static run credential's write check compares (WP-137). Absent,
   * a write into `static` reads no run token and is refused — never admitted unchecked.
   */
  readonly secretKey?: secretAdapters.SecretKey;
  /** The time a declared expiry is judged at; the process clock when absent. */
  readonly now?: Date;
  readonly audit: HumanActionInput;
}

export type UpdateIntegrationConfigResult =
  | { readonly status: 'not_found' }
  | { readonly status: 'written'; readonly changed: readonly string[] };

/**
 * `PATCH /api/integrations/:id`'s write — the second writer of `integrations.config` (WP-100), and
 * the repair criterion 4's refusal points at.
 *
 * It goes through **every check the create makes**, in the create's order, over the merged
 * document: no credential key in what is set ({@link assertNoCredentialInConfig}), every URL on a
 * declared host with the provider's defaults beneath ({@link assertHostIsDeclared}), and the
 * provider's schema ({@link assertConfigParses}). A read-modify-write under a row lock
 * (`select … for update`), so two concurrent patches serialise rather than one erasing the other's
 * keys.
 *
 * **Narrow** (standing rule 79): the statement names `config` and `health` and nothing else —
 * never `secret_ids`, which the create owns. `health` is reset to `{}` (published as `unknown`)
 * because the verdict stored there was about the configuration this write replaced; a probe racing
 * the write may put a verdict about either document back, which the next test corrects.
 */
export const updateIntegrationConfig = async (
  database: Database,
  input: UpdateIntegrationConfigInput,
): Promise<UpdateIntegrationConfigResult> => {
  const both = input.remove.filter((key) => key in input.set);
  if (both.length > 0) {
    throw new HttpError(
      400,
      'invalid_request',
      `${both.join(', ')} is both set in \`config\` and named in \`remove\`; send each key once`,
    );
  }
  return database.transaction(async (tx) => {
    const rows = await tx
      .select({
        provider: integrations.provider,
        config: integrations.config,
        secretIds: integrations.secretIds,
        retiredAt: integrations.retiredAt,
      })
      .from(integrations)
      .where(eq(integrations.id, input.integrationId))
      .for('update');
    const row = rows[0];
    if (row === undefined) {
      return { status: 'not_found' } as const;
    }
    assertNotRetired(input.integrationId, row.retiredAt);
    const provider = findShippedProvider(row.provider);
    if (provider === undefined) {
      // No schema to parse the merged document with, and no field list to tell a credential from a
      // setting — writing blind would store a document nothing can check (rule 20).
      throw new HttpError(
        409,
        'provider_not_shipped',
        `integration ${input.integrationId} names provider "${row.provider}", which this build does not ship, so its configuration cannot be checked or changed here`,
      );
    }
    assertNoCredentialInConfig(input.set, provider);
    const stored = row.config;
    const next: Record<string, JsonValue> = Object.fromEntries(
      Object.entries(stored).filter(([key]) => !input.remove.includes(key)),
    );
    Object.assign(next, input.set);
    assertHostIsDeclared({ ...provider.configDefaults, ...next }, input.egress);
    assertConfigParses(next, provider);
    if (declaresStaticRunCredential(provider.staticRunCredential ?? undefined, next)) {
      // WP-137: the run token must already be sealed (and not be the API token), and a static
      // integration may be bound by one project — a PATCH is the other door into `static`.
      assertStaticRunCredentialWrite(
        provider,
        next,
        input.secretKey === undefined
          ? {}
          : await openSealedValues(tx, input.secretKey, row.secretIds),
        input.now ?? new Date(),
      );
      await assertStaticIntegrationBindable(tx, input.integrationId, null, 0);
    }
    const changed = [...new Set([...Object.keys(stored), ...Object.keys(next)])]
      .filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(next[key]))
      .sort();
    await tx
      .update(integrations)
      .set({ config: next, health: {} })
      .where(eq(integrations.id, input.integrationId));
    await insertHumanAction(tx, {
      ...input.audit,
      params: { ...input.audit.params, changed_keys: changed },
    });
    return { status: 'written', changed } as const;
  });
};

/**
 * Refuses a write to a **retired** integration (WP-114, PROGRESS backlog 331): its credentials are
 * destroyed, it is never loaded, and a configuration, a credential, a binding or a probe of it would
 * be a write to a row nothing reads. One refusal, one code, so a client can branch on it.
 */
export const assertNotRetired = (integrationId: string, retiredAt: Date | null): void => {
  if (retiredAt !== null) {
    throw new HttpError(
      409,
      'integration_retired',
      `integration ${integrationId} was retired at ${retiredAt.toISOString()}: its credentials are destroyed and it refuses every write. Create a new integration instead`,
    );
  }
};

/**
 * How far back the retire looks for a minted credential of the integration — a partition-pruning
 * bound only, the mint's own recorded `expires_at` is the precise cut. A week, the run-credential
 * recovery's own re-validation lookback (`postgres-run-credential-store.ts`), against the 48 hours a
 * credential this build mints can live.
 */
export const LIVE_MINT_LOOKBACK = '7 days';

/**
 * The minted credentials of an integration nothing has **confirmed** revoked and whose expiry has
 * not passed (WP-114) — TD-028 decision 10 revokes a minted credential through the integration that
 * minted it, so retiring that integration (and destroying its credential) would leave the token
 * live until it expires. The predicate is the run-credential recovery's
 * (`packages/infrastructure/src/recovery/postgres-run-credential-store.ts`) asked from the
 * integration's side and without the run: a `mint_credential` row that is `ok` and carries a
 * `revoke_id`, an `expires_at` still in the future (or one that is not an instant, treated as live),
 * and no `revoke_credential` row for that `revoke_id` that is `ok` with `revoked: true`. A recovery
 * attempt answered `not_found` is recorded `revoked: false` — **unconfirmed** — and still counts here:
 * "no such token" from an adapter cannot be told from "already gone".
 */
const liveMintsOf = async (
  tx: Pick<Database, 'execute'>,
  integrationId: string,
): Promise<{ readonly count: number; readonly latestExpiry: string | null }> => {
  const { rows } = await tx.execute<{ count: number; latest_expiry: string | null }>(sql`
    select count(*)::int as count, max(m.result ->> 'expires_at') as latest_expiry
      from integration_actions m
     where m.integration_id = ${integrationId}
       and m.created_at > now() - ${LIVE_MINT_LOOKBACK}::interval
       and m.action = 'mint_credential'
       and m.status = 'ok'
       and m.result ->> 'revoke_id' is not null
       and case
             when m.result ->> 'expires_at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$'
             then (m.result ->> 'expires_at')::timestamptz > now()
             else true
           end
       and not exists (
         select 1
           from integration_actions v
          where v.integration_id = m.integration_id
            and v.created_at > now() - ${LIVE_MINT_LOOKBACK}::interval
            and v.action = 'revoke_credential'
            and v.payload ->> 'revoke_id' = m.result ->> 'revoke_id'
            and v.status = 'ok'
            and v.result ->> 'revoked' = 'true'
       )`);
  const row = rows[0];
  return { count: Number(row?.count ?? 0), latestExpiry: row?.latest_expiry ?? null };
};

export type RetireIntegrationResult =
  | { readonly status: 'not_found' }
  | { readonly status: 'already_retired' }
  | { readonly status: 'retired'; readonly destroyedSecrets: number };

/**
 * `DELETE /api/integrations/:id` — **retires** the integration (WP-114, PROGRESS backlog 331).
 *
 * The row is **kept**: `integration_actions.integration_id` is a `NOT NULL` foreign key and the audit
 * must keep naming the credential each call was made with (BD-003). What goes is the credential —
 * the integration's `secrets` rows are **deleted** — and the row is marked `retired_at`, its
 * `secret_ids` emptied and its `health` reset. From then on it is never loaded (the binding
 * repository answers no account for it and the loader refuses a binding of it), it is listed as
 * retired, and every write refuses it ({@link assertNotRetired}).
 *
 * Refused, each by name, while
 *
 *  - a **binding** names it — `409 integration_bound`, naming the projects: a bound integration is
 *    one a project's pipeline loads, and retiring it would turn the project's next call into a
 *    `BindingLoadError`;
 *  - it is the organisation's flagged chat account (`notifications.organisation_default`) — `409
 *    integration_is_organisation_default` (backlog 387): every organisation alarm would fail;
 *  - an **unexpired, unconfirmed minted credential** of it exists — `409
 *    integration_has_live_credential` ({@link liveMintsOf}): the integration is where TD-028 decision
 *    10 revokes it, and destroying its credential would leave the token live until it expires.
 *
 * ## The lock (standing rule 9)
 *
 * The check and the retire are one transaction under the **`integrations` row lock**: this takes it
 * `for update`, a bindings `PUT` takes it `for share` before it inserts ({@link replaceProjectBindings}),
 * and a mint's audit row takes it `for key share` through `integration_actions.integration_id`'s
 * foreign key when the executor records the mint. Each conflicts with `for update`, so whichever
 * commits first decides: a bind or a mint recorded first is seen here and refuses the retire; a
 * retire committed first is read by the bind, which refuses.
 *
 * **A mint whose call is in flight across the retire** (backlog 386, closed in WP-114's pre-review
 * round). No transaction is open across a provider call, so the lock covers the mint's **record**,
 * not its call: a mint in flight while its project is unbound and the integration retired is
 * recorded after the retire, on a retired row. The mint therefore reads `retired_at` **after** its
 * record committed and, finding it set, revokes through the adapter it already holds — which kept
 * the account's decrypted credential — and refuses the run start
 * (`MintingIntegrationLiveness` in `packages/application/src/pipeline/integrations.ts`). The order
 * is sound because the record's `for key share` and this `for update` conflict: a record that
 * commits first is seen here; a retire that commits first is seen by the mint's read. What is left
 * is a revoke that fails at the provider, named in the refusal.
 */
export const retireIntegration = async (
  database: Database,
  input: { readonly integrationId: string; readonly audit: HumanActionInput },
): Promise<RetireIntegrationResult> =>
  database.transaction(async (tx) => {
    const rows = await tx
      .select({ secretIds: integrations.secretIds, retiredAt: integrations.retiredAt })
      .from(integrations)
      .where(eq(integrations.id, input.integrationId))
      .for('update');
    const row = rows[0];
    if (row === undefined) {
      return { status: 'not_found' } as const;
    }
    if (row.retiredAt !== null) {
      return { status: 'already_retired' } as const;
    }
    const bound = await tx
      .select({ key: projects.key })
      .from(bindings)
      .innerJoin(projects, eq(projects.id, bindings.projectId))
      .where(eq(bindings.integrationId, input.integrationId))
      .orderBy(projects.key);
    if (bound.length > 0) {
      throw new HttpError(
        409,
        'integration_bound',
        `integration ${input.integrationId} is bound to project${bound.length === 1 ? '' : 's'} ${bound
          .map((binding) => binding.key)
          .join(
            ', ',
          )}; remove it from each project's bindings (PUT /api/projects/:id/bindings) before retiring it`,
      );
    }
    // WP-114 pre-review, backlog 387: the organisation's flagged chat account. Read after this
    // row's `for update`, so a `PATCH /api/org` that flagged it and committed first is seen, and one
    // still writing holds this row `for share` until it commits (`replaceOrganisationSettings`).
    const flagged = await tx.execute<{ flagged: string | null }>(sql`
      select o.settings -> 'notifications' ->> 'organisation_default' as flagged
        from organizations o
        join integrations i on i.org_id = o.id
       where i.id = ${input.integrationId}`);
    if (flagged.rows[0]?.flagged === input.integrationId) {
      throw new HttpError(
        409,
        'integration_is_organisation_default',
        `integration ${input.integrationId} is the organisation's chat account (notifications.organisation_default); name another account or remove the setting with PATCH /api/org before retiring it`,
      );
    }
    const live = await liveMintsOf(tx, input.integrationId);
    if (live.count > 0) {
      throw new HttpError(
        409,
        'integration_has_live_credential',
        `integration ${input.integrationId} minted ${live.count} run credential${live.count === 1 ? '' : 's'} that nothing has confirmed revoked and that ${live.count === 1 ? 'has' : 'have'} not expired (the latest expires ${live.latestExpiry ?? 'at an unreadable instant'}); it is where a revoke is sent (TD-028 decision 10), so it cannot be retired until ${live.count === 1 ? 'that credential is' : 'they are'} revoked or expired`,
      );
    }
    const destroyed =
      row.secretIds.length === 0
        ? []
        : await tx
            .delete(secrets)
            .where(inArray(secrets.id, row.secretIds))
            .returning({ id: secrets.id });
    await tx
      .update(integrations)
      .set({ retiredAt: sql`now()`, secretIds: [], health: {}, updatedAt: sql`now()` })
      .where(eq(integrations.id, input.integrationId));
    await insertHumanAction(tx, {
      ...input.audit,
      params: { ...input.audit.params, destroyed_secrets: destroyed.length },
    });
    return { status: 'retired', destroyedSecrets: destroyed.length } as const;
  });

export type ResealIntegrationSecretsResult =
  | { readonly status: 'not_found' }
  /** This caller's key already performed a re-seal: nothing was sealed. */
  | { readonly status: 'replayed' }
  | {
      readonly status: 'resealed';
      readonly sealedFields: readonly string[];
      /** Sealed rows this request destroyed: the named fields' old rows and any unreadable row. */
      readonly destroyedSecrets: number;
    };

/**
 * `POST /api/integrations/:id/secrets` — **re-seals** an integration's credentials (WP-114, PROGRESS
 * backlog 331). The create's rules exactly: `secret_refs` is credential **field** → the **name** of
 * an environment variable, on the operator-declared `APP_INTEGRATION_SECRET_ENV` allow-list
 * (`input.secretSource`, which refuses any other name), read by the server and sealed — a credential
 * never crosses the API (BD-002, TD-020). A field the provider does not declare is refused.
 *
 * **A named field replaces that field's sealed row; an unnamed field keeps its own.** The field a
 * row holds travels inside its plaintext (`{field, value}`), so the existing rows are opened to tell
 * which to replace. A row that **cannot be opened** — sealed under another key, corrupt — is
 * destroyed too: it already made every load of the integration fail, and keeping it would keep the
 * integration broken after a re-seal meant to repair it (the audit row counts it). The old rows are
 * **deleted**, not kept beside the new ones: a rotated token that leaked must leave the database.
 *
 * `health` is reset to `{}` (published `unknown`): the stored verdict was about the old credential.
 *
 * ## Idempotency: the claim is taken with the effect
 *
 * `Idempotency-Key` is required (technical/08: a client may retry). This function holds the
 * effect's transaction, so the key's `command_idempotency` row is inserted **inside** it — the
 * ordering `routes/idempotency.ts` calls *claim with the effect*: a second request under the same
 * key blocks on the first's uncommitted row (and on the row lock before it), meets it once the first
 * commits, and is answered `replayed` without reading the environment into a seal or writing
 * anything. The values are read and sealed **before** the transaction opens, for the create's
 * reason (a `_FILE` read is I/O a held connection must not wait on); on a replay those ciphertexts
 * are simply dropped.
 *
 * Under the `integrations` row lock (`for update`), so a retire and a re-seal of one integration
 * serialise, and a retired integration refuses ({@link assertNotRetired}).
 */
export const resealIntegrationSecrets = async (
  database: Database,
  input: {
    readonly integrationId: string;
    readonly secretRefs: Readonly<Record<string, string>>;
    readonly secretSource: SecretSource;
    readonly secretKey: secretAdapters.SecretKey;
    readonly newId: () => string;
    /** The caller's key and the request's digest — the claim's identity. */
    readonly idempotency: { readonly key: string; readonly digest: string };
    /** A static run credential's declared expiry is judged at it (WP-137); the process clock when absent. */
    readonly now?: Date;
    readonly audit: HumanActionInput;
  },
): Promise<ResealIntegrationSecretsResult> => {
  const current = await database
    .select({ provider: integrations.provider, retiredAt: integrations.retiredAt })
    .from(integrations)
    .where(eq(integrations.id, input.integrationId))
    .limit(1);
  const found = current[0];
  if (found === undefined) {
    return { status: 'not_found' };
  }
  assertNotRetired(input.integrationId, found.retiredAt);
  const provider = findShippedProvider(found.provider);
  if (provider === undefined) {
    throw new HttpError(
      409,
      'provider_not_shipped',
      `integration ${input.integrationId} names provider "${found.provider}", which this build does not ship, so its credential fields are unknown here`,
    );
  }
  const declared = new Set(provider.secretFields);
  const fields = Object.keys(input.secretRefs).sort();
  const unknown = fields.filter((field) => !declared.has(field));
  if (unknown.length > 0) {
    throw new HttpError(
      400,
      'invalid_request',
      `provider "${provider.id}" declares no credential field named ${unknown.join(', ')}; it declares ${[...declared].join(', ') || 'none'}`,
    );
  }

  // Read and sealed before the transaction, for `createIntegration`'s reason.
  const sealed: { readonly id: string; readonly ciphertext: Buffer }[] = [];
  const resealedValues: Record<string, string> = {};
  for (const field of fields) {
    const value = await input.secretSource.read(input.secretRefs[field] as string);
    resealedValues[field] = value;
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

  return database.transaction(async (tx) => {
    const rows = await tx
      .select({
        secretIds: integrations.secretIds,
        config: integrations.config,
        retiredAt: integrations.retiredAt,
      })
      .from(integrations)
      .where(eq(integrations.id, input.integrationId))
      .for('update');
    const row = rows[0];
    if (row === undefined) {
      return { status: 'not_found' } as const;
    }
    assertNotRetired(input.integrationId, row.retiredAt);
    if (declaresStaticRunCredential(provider.staticRunCredential ?? undefined, row.config)) {
      // WP-137: the credential set after this write — the sealed ones it keeps, the ones it seals —
      // still holds a run token that is not the API token, before anything is claimed or written.
      assertStaticRunCredentialWrite(
        provider,
        row.config,
        {
          ...(await openSealedValues(tx, input.secretKey, row.secretIds)),
          ...resealedValues,
        },
        input.now ?? new Date(),
      );
    }
    const claimed = await tx
      .insert(commandIdempotency)
      .values({
        userId: input.audit.userId,
        action: input.audit.action,
        idempotencyKey: input.idempotency.key,
        bodyDigest: input.idempotency.digest,
      })
      .onConflictDoNothing()
      .returning({ claimedAt: commandIdempotency.claimedAt });
    if (claimed[0] === undefined) {
      return { status: 'replayed' } as const;
    }

    const stored =
      row.secretIds.length === 0
        ? []
        : await tx
            .select({ id: secrets.id, ciphertext: secrets.ciphertext })
            .from(secrets)
            .where(inArray(secrets.id, row.secretIds));
    const named = new Set(fields);
    const replaced: string[] = [];
    let unreadable = 0;
    for (const secret of stored) {
      const field = fieldOfSealedRow(input.secretKey, secret.id, secret.ciphertext);
      if (field === null) {
        unreadable += 1;
        replaced.push(secret.id);
      } else if (named.has(field)) {
        replaced.push(secret.id);
      }
    }
    for (const secret of sealed) {
      await tx
        .insert(secrets)
        .values({ id: secret.id, ciphertext: secret.ciphertext, keyId: input.secretKey.keyId });
    }
    if (replaced.length > 0) {
      await tx.delete(secrets).where(inArray(secrets.id, replaced));
    }
    // A referenced id with no row (a hand edit) is dropped as well: it can only fail a load.
    const present = new Set(stored.map((secret) => secret.id));
    const kept = row.secretIds.filter((id) => present.has(id) && !replaced.includes(id));
    // Assembled here rather than spread inside `.set(`: the `integrations.config` writer census
    // counts any statement it cannot rule out, and this one names `secret_ids` and `health` only.
    const secretIds = kept.concat(sealed.map((secret) => secret.id));
    await tx
      .update(integrations)
      .set({ secretIds, health: {}, updatedAt: sql`now()` })
      .where(eq(integrations.id, input.integrationId));
    await insertHumanAction(tx, {
      ...input.audit,
      params: {
        ...input.audit.params,
        // Field names, never values — what was re-sealed, never what with.
        secret_fields: fields,
        destroyed_secrets: replaced.length,
        unreadable_destroyed: unreadable,
        idempotency_key: input.idempotency.key,
        body_digest: input.idempotency.digest,
      },
    });
    return { status: 'resealed', sealedFields: fields, destroyedSecrets: replaced.length } as const;
  });
};

/** The credential field a sealed row holds, or `null` when it cannot be opened under this key. */
const fieldOfSealedRow = (
  key: secretAdapters.SecretKey,
  secretId: string,
  ciphertext: Buffer,
): string | null => {
  try {
    return secretAdapters.secretDocumentSchema.parse(
      JSON.parse(secretAdapters.openSecret(key, ciphertext, secretId)),
    ).field;
  } catch {
    // Never the plaintext and never the error's text into a response: the row is counted.
    return null;
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
    /**
     * `APP_INTEGRATION_HOSTS`, as a policy — **required, never defaulted** (WP-51).
     *
     * The same argument `redactor` carries one ring out: an optional policy is an absent one on the
     * day a composition root forgets it, and "closed" would look here exactly like a working list.
     */
    readonly egress: IntegrationEgressPolicy;
    readonly secretSource: SecretSource;
    readonly secretKey: secretAdapters.SecretKey;
    readonly newId: () => string;
    /** A static run credential's declared expiry is judged at it (WP-137); the process clock when absent. */
    readonly now?: Date;
    /** The audit row, written in the same transaction — see {@link createProject}'s. */
    readonly audit?: HumanActionInput;
  },
): Promise<CreateIntegrationResult> => {
  assertNoCredentialInConfig(input.integration.config, input.provider);
  // The body over the provider's defaults: a field the body leaves out is judged by the value the
  // provider will use for it (WP-73b, backlog 245).
  assertHostIsDeclared(
    { ...input.provider.configDefaults, ...input.integration.config },
    input.egress,
  );
  // The provider's own schema, before the row exists (WP-100, backlog 328): a create that answered
  // 201 over `config: {}` stored a row every binding load and every probe then refused.
  assertConfigParses(input.integration.config, input.provider);

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
      retiredAt: integrations.retiredAt,
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
    if (found.retiredAt !== null) {
      // WP-114: the name still belongs to the retired row — `(org_id, type, name)` is unique and the
      // row is kept for the audit — and answering a create with a retired integration would hand
      // the caller something that refuses every write. Named, so the operator picks another name.
      throw new HttpError(
        409,
        'integration_name_retired',
        `the ${found.type} integration named "${found.name}" (${found.id}) was retired; a retired integration keeps its name for the audit, so give the new one another name`,
      );
    }
    // Idempotent on `(org_id, type, name)`. Nothing is re-sealed and no secret row is orphaned:
    // re-reading the environment here would write a second `secrets` row nothing points at.
    const { retiredAt: _live, ...row } = found;
    return { status: 'exists', integration: row as IntegrationRow };
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
  const createdValues: Record<string, string> = {};
  for (const [field, ref] of Object.entries(input.integration.secretRefs)) {
    createdValues[field] = await input.secretSource.read(ref);
  }
  // WP-137 (TD-028 decision 13 item 1): a static run credential's run token is compared with the
  // API token as the two values just read, before anything is sealed or any row exists.
  assertStaticRunCredentialWrite(
    input.provider,
    input.integration.config,
    createdValues,
    input.now ?? new Date(),
  );
  for (const [field, value] of Object.entries(createdValues)) {
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
    // WP-100 review round 1 (backlog 330): the provider's declared credential fields removed, and
    // nothing at all for a provider this build does not ship — `GET /api/integrations`'s rule, one
    // function. It covers a binding row stored before the write refused a credential key.
    config: publishableConfig(row.config, findShippedProvider(row.provider)),
  }));
};

/**
 * WP-73b, PROGRESS backlog 201: a binding may not set a key only the **account** decides — Slack's
 * `socket_mode`, which selects the held connection off `integrations.config` alone. The strict
 * provider schema accepted it on a binding, where it half-applied: the transport stayed the
 * account's while the binding's merged value flipped that project's buttons. Refused by name, so
 * the operator is told where the setting lives. The provider's own declaration is the list
 * (`accountOnlyFields`), so a provider this build does not ship refuses nothing here.
 */
export const assertNoAccountOnlyFields = (
  items: readonly { readonly integrationId: string; readonly config?: JsonObject }[],
  known: readonly { readonly id: string; readonly provider: string }[],
): void => {
  for (const item of items) {
    const provider = known.find((row) => row.id === item.integrationId)?.provider;
    const accountOnly =
      provider === undefined ? [] : (findShippedProvider(provider)?.accountOnlyFields ?? []);
    const named = accountOnly.filter((field) => item.config !== undefined && field in item.config);
    if (named.length > 0) {
      throw new HttpError(
        400,
        'invalid_request',
        `${named.join(', ')} is set on the ${provider} integration ${item.integrationId}, never on a project's binding: the account's value is the one every project uses`,
      );
    }
  }
};

/**
 * Refuses a binding overlay that carries one of the provider's **credential** fields (backlog 330,
 * {@link assertNoCredentialInConfig}), and a binding whose **effective** configuration — the account's document with the binding's
 * overlay on top, which is exactly what the binding repository hands the loader
 * (`overlayBindingConfig`) — the provider's schema refuses, and a binding URL on an undeclared host
 * (WP-100: "every config write"). A binding of a provider this build does not ship is not judged:
 * there is no schema here to judge it by, which is `assertNoAccountOnlyFields`'s answer too.
 *
 * The account is judged first and on its own, so a binding that is refused because its **account**
 * no longer parses says so and names the `PATCH` that repairs the account, rather than telling the
 * operator to change a binding that carries nothing wrong.
 */
export const assertBindingConfigsParse = (
  items: readonly { readonly integrationId: string; readonly config?: JsonObject }[],
  known: readonly { readonly id: string; readonly provider: string; readonly config: JsonObject }[],
  egress: IntegrationEgressPolicy,
): void => {
  for (const item of items) {
    const account = known.find((row) => row.id === item.integrationId);
    const provider = account === undefined ? undefined : findShippedProvider(account.provider);
    if (account === undefined || provider === undefined) {
      continue;
    }
    const refusal = storedConfigRefusal(account.id, account.config, provider);
    if (refusal !== null) {
      throw new HttpError(409, refusal.code, refusal.message);
    }
    const overlay = item.config ?? {};
    // Before the parse, because the parse takes credential keys out (`configIssuesOf`, for rows
    // stored before the create refused them) and would otherwise admit a token into
    // `bindings.config` in plaintext (backlog 330).
    assertNoCredentialInConfig(overlay, provider);
    assertHostIsDeclared(overlay, egress);
    const issues = configIssuesOf(provider, { ...account.config, ...overlay });
    if (issues.length > 0) {
      throw new HttpError(
        400,
        'invalid_binding_config',
        `the binding of integration ${account.id} gives it configuration that provider "${provider.id}"'s schema refuses at: ${describeConfigIssues(issues)}`,
        issues.map((issue) => ({ path: issue.path, message: issue.message })),
      );
    }
  }
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
  /** `APP_INTEGRATION_HOSTS` — required, for the reason `createIntegration` gives (WP-100). */
  options: { readonly egress: IntegrationEgressPolicy },
): Promise<void> => {
  const ids = items.map((item) => item.integrationId);
  await database.transaction(async (tx) => {
    if (ids.length > 0) {
      /**
       * **`for share`, in id order — the lock a retire also takes** (WP-114, standing rule 9). A
       * retire holds the row `for update` while it checks that no binding names it; this share lock
       * conflicts with that, so a bind and a retire of one integration serialise: a bind that waits
       * behind a retire reads the committed `retired_at` and is refused below, and a retire that
       * waits behind a bind sees the binding it committed and is refused. Id order, so two binds
       * naming the same integrations cannot deadlock each other.
       */
      const known = await tx
        .select({
          id: integrations.id,
          provider: integrations.provider,
          config: integrations.config,
          retiredAt: integrations.retiredAt,
        })
        .from(integrations)
        .where(inArray(integrations.id, ids))
        .orderBy(integrations.id)
        .for('share');
      const missing = ids.filter((id) => !known.some((row) => row.id === id));
      if (missing.length > 0) {
        throw new HttpError(
          400,
          'invalid_request',
          `no integration with id ${missing.join(', ')}; create the integration before binding it`,
        );
      }
      for (const row of known) {
        assertNotRetired(row.id, row.retiredAt);
      }
      assertNoAccountOnlyFields(items, known);
      assertBindingConfigsParse(items, known, options.egress);
      // WP-137 (TD-028 decision 13 item 1): a static integration is bound by this project alone.
      for (const row of known) {
        const provider = findShippedProvider(row.provider);
        if (declaresStaticRunCredential(provider?.staticRunCredential ?? undefined, row.config)) {
          await assertStaticIntegrationBindable(tx, row.id, projectId, 1);
        }
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
  /** Who chose the level, for the materialised record; ignored when no level is sent. */
  readonly appliedBy?: string | null;
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
      // The word and the policies it stands for move together or not at all (BD-027:14). Writing
      // one without the other is the state the platform was in before WP-30: a column saying
      // "autonomous" beside policies nobody had materialised.
      ...(input.autonomyLevel === undefined
        ? {}
        : {
            autonomyLevel: input.autonomyLevel,
            autonomyPolicies: materialiseAutonomy({
              level: input.autonomyLevel,
              at: new Date().toISOString() as IsoDateTime,
              appliedBy: input.appliedBy ?? null,
            }),
          }),
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
 * Re-materialises the dial — BD-027's *"the UI offers 're-apply preset'"*, and the one writer of
 * `projects.autonomy_policies` that does not also write the configuration document.
 *
 * Two columns, and nothing else. `autonomy_level` and `autonomy_policies` are one fact written in
 * two places, so they are always set together; `config` is deliberately **not** named, because a
 * maintainer moving the dial must not overwrite a document an administrator is editing at the same
 * moment (standing rule 79 — a whole-row write is correct only while nothing else writes the row).
 *
 * It is the same statement whether the level is changing or not: selecting a position and
 * re-applying one are the same operation, which is why there is no `re_apply` flag anywhere. The
 * caller sends the level it wants in force and gets **this release's** preset for it.
 */
export const writeProjectAutonomy = async (
  database: Database,
  projectId: string,
  input: { readonly level: AutonomyLevel; readonly appliedBy: string | null },
): Promise<
  | { readonly status: 'written'; readonly autonomy: MaterialisedAutonomy }
  | { readonly status: 'not_found' }
> => {
  const autonomy = materialiseAutonomy({
    level: input.level,
    at: new Date().toISOString() as IsoDateTime,
    appliedBy: input.appliedBy as Id | null,
  });
  const updated = await database
    .update(projects)
    .set({ autonomyLevel: input.level, autonomyPolicies: autonomy, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning({ id: projects.id });
  return updated.length === 0 ? { status: 'not_found' } : { status: 'written', autonomy };
};

/** The task states that are finished; every other state is a live task (`task-state-machine.ts`). */
const FINISHED_TASK_STATES = ['done', 'cancelled'] as const;

/** The stored default branch and the count of the project's unfinished tasks (WP-139's read). */
export const findProjectRepository = async (
  database: Database,
  projectId: string,
): Promise<{ readonly defaultBranch: string; readonly liveTasks: number } | null> => {
  const rows = await database
    .select({ defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return { defaultBranch: row.defaultBranch, liveTasks: await countLiveTasks(database, projectId) };
};

const countLiveTasks = async (
  executor: Pick<Database, 'select'>,
  projectId: string,
): Promise<number> => {
  const counted = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), notInArray(tasks.state, [...FINISHED_TASK_STATES])));
  return counted[0]?.n ?? 0;
};

/**
 * Changes `projects.default_branch` — WP-139's command, and the column's only writer after the
 * create (`projects-column-ownership.test.ts` names it).
 *
 * **One column** (standing rule 79) plus the shared `updated_at`. The project row is locked first,
 * so the `before` the audit records is the value this write replaced, and the live-task count is
 * read under that lock: a task that is not `done` or `cancelled` refuses the write, because its
 * branch, merge request and gates were made against the old default branch.
 *
 * **Task creation waits for this lock** (WP-142, backlog 442): the Postgres `tasks.insert` takes
 * the project row `for share` before its insert, so a task is either committed before this
 * statement's lock is granted — and counted — or created after this write commits, on the new
 * branch. It was the residual of WP-139.
 *
 * **And it resets the poll's baseline** (WP-142): every git binding of the project has its
 * `mr_poll_default_head` cleared in this transaction, so the next poll-only poll records the new
 * branch's head as its first read rather than a move from the old branch's.
 */
export const writeProjectDefaultBranch = async (
  database: Database,
  projectId: string,
  branch: string,
): Promise<
  | { readonly status: 'written'; readonly before: string; readonly project: ProjectRecord }
  | { readonly status: 'not_found' }
  | { readonly status: 'live_tasks'; readonly count: number }
> =>
  database.transaction(async (tx) => {
    const locked = await tx
      .select({ defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    const before = locked[0]?.defaultBranch;
    if (before === undefined) {
      return { status: 'not_found' } as const;
    }
    const live = await countLiveTasks(tx, projectId);
    if (live > 0) {
      return { status: 'live_tasks', count: live } as const;
    }
    const updated = await tx
      .update(projects)
      .set({ defaultBranch: branch, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning(PROJECT_COLUMNS);
    const row = updated[0];
    if (row === undefined) {
      return { status: 'not_found' } as const;
    }
    if (before !== branch) {
      // WP-142: a head of the old branch is not a baseline for the new one.
      await tx
        .update(bindings)
        .set({ mrPollDefaultHead: null })
        .where(eq(bindings.projectId, projectId));
    }
    return { status: 'written', before, project: toProjectRecord(row) } as const;
  });

/**
 * Writes `integrations.health` — the column `GET /api/integrations` publishes and that nothing
 * wrote before WP-21. The read's own description carried the sentence *"nothing does in this
 * build, and `POST /api/integrations/:id/test` is the endpoint that would"*; this is that
 * endpoint, and that sentence is corrected there rather than left true-sounding.
 *
 * **One column** (standing rule 79): the statement never names `config` or `secret_ids`, which
 * belong to the create (and `config` to `PATCH /api/integrations/:id` since WP-100) and which a
 * wizard may be writing at the same moment.
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
    // A probe that raced a retire must not put a verdict back on a row whose credential is gone.
    .where(and(eq(integrations.id, integrationId), isNull(integrations.retiredAt)));
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

/**
 * The insert itself, so a caller inside a transaction and one outside share one statement.
 *
 * A row that carries an `Idempotency-Key` also **completes** the key's record in
 * `command_idempotency` on the same executor (WP-67, {@link completeCommandAttempt}): inside a
 * command's transaction the two commit together, and {@link recordHumanAction} gives them a
 * transaction of their own when it is called on the pool.
 */
const insertHumanAction = async (
  executor: Pick<Database, 'insert'>,
  input: HumanActionInput,
): Promise<void> => {
  const inserted = await executor
    .insert(humanActions)
    .values({
      taskId: input.taskId ?? null,
      userId: input.userId,
      action: input.action,
      params: input.params,
    })
    .returning({ id: humanActions.id });
  const key = input.params.idempotency_key;
  const row = inserted[0];
  if (typeof key !== 'string' || row === undefined) {
    return;
  }
  const digest = input.params.body_digest;
  await completeCommandAttempt(executor, {
    userId: input.userId,
    action: input.action,
    key,
    digest: typeof digest === 'string' ? digest : null,
    humanActionId: row.id,
  });
};

/**
 * On the pool, the audit row and the key's completion are **one transaction** (WP-67 review round
 * 1): as two statements, a failure between them left an audit row whose key still read as a claim.
 */
export const recordHumanAction = async (
  database: Database,
  input: HumanActionInput,
): Promise<void> => {
  await database.transaction(async (tx) => insertHumanAction(tx, input));
};

/**
 * Records a command's `human_actions` row **inside a transaction the command already holds**, and
 * refuses when this caller's key already performed the action (WP-64 review round 1).
 *
 * For a command with no natural key — the interview queues eight proposals and nothing unique
 * stops a second eight — a read before the command is not enough: two submits that race both read
 * "no attempt". So the claim is the **insert** of the key's `command_idempotency` row (migration
 * 0053, WP-67) in the **same** transaction as the command's writes: the second of two racing
 * submits blocks on the first one's uncommitted primary key, meets it once the first commits,
 * answers `false`, and its caller rolls back. A crash between the writes and the audit row is
 * impossible for the same reason: they commit together. This is the ordering
 * `routes/idempotency.ts` calls **claim with the effect**, available only where the route holds the
 * effect's transaction; until WP-67 it was an advisory lock plus a JSON read of `human_actions`.
 *
 * Raw SQL on the transaction's own client, because the command's unit of work owns the connection.
 */
export const claimIdempotentAttemptInTransaction = async (
  client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  input: {
    readonly userId: string;
    readonly action: string;
    readonly key: string;
    readonly params: JsonObject;
    readonly taskId?: string | null;
  },
): Promise<boolean> => {
  const digest = (input.params as Record<string, unknown>).body_digest;
  const claimed = await client.query(
    `insert into command_idempotency (user_id, action, idempotency_key, body_digest)
     values ($1, $2, $3, $4)
     on conflict do nothing
     returning 1`,
    [input.userId, input.action, input.key, typeof digest === 'string' ? digest : null],
  );
  if (claimed.rows.length === 0) {
    return false;
  }
  const inserted = await client.query(
    'insert into human_actions (task_id, user_id, action, params) values ($1, $2, $3, $4::jsonb) returning id',
    [input.taskId ?? null, input.userId, input.action, JSON.stringify(input.params)],
  );
  const humanActionId = (inserted.rows[0] as { id: string }).id;
  await client.query(
    `update command_idempotency
        set completed_at = greatest(now(), claimed_at), human_action_id = $4
      where user_id = $1 and action = $2 and idempotency_key = $3`,
    [input.userId, input.action, input.key, humanActionId],
  );
  return true;
};

/**
 * Writes a command's `human_actions` row **inside a transaction the command holds**, and completes
 * the key's claim beside it — for a command that claimed its key **before** it performed
 * (`claimIdempotentAttempt`, WP-67's claim-before-effect) and whose effect is one transaction the
 * route does not own (WP-122's manual start: the `ticket.matched` and its audit row commit
 * together, the ruling's *"one transaction"*).
 *
 * {@link claimIdempotentAttemptInTransaction} cannot serve it: its claim is an `insert … on
 * conflict do nothing` that answers `false` for the row the earlier claim already wrote. This is
 * `insertHumanAction` + `completeCommandAttempt` in raw SQL on the transaction's own client: the
 * completion upserts, and leaves a row that is already completed exactly as it is.
 */
export const recordHumanActionInTransaction = async (
  client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  input: HumanActionInput,
): Promise<void> => {
  const inserted = await client.query(
    'insert into human_actions (task_id, user_id, action, params) values ($1, $2, $3, $4::jsonb) returning id',
    [input.taskId ?? null, input.userId, input.action, JSON.stringify(input.params)],
  );
  const key = input.params.idempotency_key;
  if (typeof key !== 'string') {
    return;
  }
  const digest = input.params.body_digest;
  await client.query(
    `insert into command_idempotency
       (user_id, action, idempotency_key, body_digest, completed_at, human_action_id)
     values ($1, $2, $3, $4, now(), $5)
     on conflict (user_id, action, idempotency_key) do update
        set completed_at = greatest(now(), command_idempotency.claimed_at),
            human_action_id = excluded.human_action_id
      where command_idempotency.completed_at is null`,
    [
      input.userId,
      input.action,
      key,
      typeof digest === 'string' ? digest : null,
      (inserted.rows[0] as { id: string }).id,
    ],
  );
};

/**
 * What a previous attempt under this `Idempotency-Key` asked for, or `null` when there was none.
 *
 * **Read out of `command_idempotency` since WP-67** (migration 0053), where it used to be a JSON
 * predicate over `human_actions`. A key counts as used only once its command **completed** — an
 * in-flight claim is not an attempt a lookup can answer from, and the routes that must see one
 * claim instead of looking (`claimIdempotentAttempt` in `routes/idempotency.ts`). The callers left
 * on this read are the wizard's two creates, whose natural key is what stops a second row, and the
 * interview's early answer, whose real guard is {@link claimIdempotentAttemptInTransaction}.
 *
 * What it is **not**: a stored *response*. A repeat with the same key and the same body is answered
 * by re-reading the resource through its natural key, or from the `params` the first attempt's
 * audit row recorded — never by replaying bytes.
 *
 * ## The scope of a key is `(user, action)`, and the user half is the security-relevant one
 *
 * Scoped by `action` as well as by the key, deliberately: two different commands are allowed to
 * share a key (a client that uses one key per wizard step would otherwise collide with itself), and
 * what must not happen is one command being replayed with different arguments.
 *
 * Scoped by **`user_id`** because technical/08 is silent about who owns an `Idempotency-Key` and
 * the caller is the only honest answer: the header is generated by a client, per attempt, and
 * nothing makes one client's string distinct from another's. Without the user in the predicate the
 * lookup is installation-wide, and a key that another organisation's operator happened to use for
 * the same command answers this caller `409 idempotency_key_reused` — a refusal of a request that
 * is legitimate, and an oracle that says a stranger's key exists. It is the same argument
 * `idempotencyScopeFor` makes one layer out for a provider's key, with the same conclusion: a key
 * is an identity, and an identity is only unique inside the scope that issued it.
 *
 * What the narrower scope gives up, stated rather than implied: a command issued by **two**
 * accounts under one key is performed twice. That is not the header's job — the aggregate refuses
 * the second (`task.pause` twice is `paused → paused`), the wizard's unique keys refuse a second
 * row, and a shared key across accounts is not a retry of the same request in any case. A deleted
 * user's keys are deleted with them (`on delete cascade`), which frees the key rather than
 * refusing it — the direction that loses a 409, never one that performs something twice.
 *
 * ## The residual on the wizard's creates, which WP-67 states rather than closes
 *
 * Two **concurrent** creates under one key both read "no attempt" here; the unique key underneath
 * (`projects.key`, `(integrations.org_id, type, name)`) still stops a second row, so what is lost
 * is only the `409` for a concurrent *different* body, which is answered with the first resource
 * instead. The divergence is deliberate: those two write their audit row inside the create's own
 * transaction, which already leaves no crash window, and the natural key already decides.
 */
export const findIdempotentAttempt = async (
  database: Database,
  input: { readonly userId: string; readonly action: string; readonly key: string },
): Promise<{ readonly bodyDigest: string | null; readonly params: JsonObject } | null> => {
  const found = await findCommandAttempt(database, input);
  if (found === null || found.status !== 'performed') {
    return null;
  }
  // The whole `params` object, not only the digest: for a command with no natural key to re-read,
  // the recorded attempt **is** the answer to a retry (WP-15i).
  return { bodyDigest: found.bodyDigest, params: found.params };
};
