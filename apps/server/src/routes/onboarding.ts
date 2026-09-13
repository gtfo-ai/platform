/**
 * The onboarding wizard's command surface — product/06 steps 1, 2 and 4 (WP-21).
 *
 *   POST /api/projects                          step 1, "connect"
 *   POST /api/integrations                      step 1
 *   POST /api/integrations/:integration_id/test step 1, "the platform validates access"
 *   GET  /api/projects/:project_id/bindings     step 1
 *   PUT  /api/projects/:project_id/bindings     step 1
 *   POST /api/projects/:project_id/discovery    step 2, "technical discovery"
 *   PUT  /api/projects/:project_id/config       step 4, "operating mode and features"
 *
 * These are the first **commands** this server has served beyond the knowledge queue's decide, and
 * three properties are shared by all of them rather than being decided per route.
 *
 * ## Every one is audited
 *
 * technical/08 § "Rate limits and safety": *"all human actions recorded in `human_actions`"*. The
 * row is written when the command succeeds — a command that failed is not an action a human
 * performed — and carries the `Idempotency-Key` the client sent, so an operator reading the audit
 * can tell one double-clicked create from two deliberate ones. For the two creates whose effect is
 * a write in `queries/onboarding-queries.ts` it is written **inside that write's transaction**,
 * because the row is also the idempotency record; `findIdempotentAttempt` states what that does not
 * cover.
 *
 * ## `Idempotency-Key` is required where a POST creates, and what it buys is enforced
 *
 * technical/08 § "Principles": *"idempotent where a client may retry (`Idempotency-Key` header on
 * POSTs that create)"*. The header is **required** on the three creating POSTs and refused when
 * absent, because a header that is optional is a header production omits (standing rule 31's
 * shape). Two mechanisms, and the second exists because the first cannot see the difference that
 * matters:
 *
 * - **A retry is cheap because of the unique key** — `projects.key`,
 *   `(integrations.org_id, type, name)`, `(tasks.project_id, ticket_key, mode)`. The command finds
 *   the row and answers with it, so there is no stored *response* to keep consistent.
 * - **A repeat with a different body is refused**, by `idempotencyGuard` (`./idempotency.ts`, which
 *   is where the whole mechanism moved when WP-15i gave it eleven more callers): every performed
 *   command records a digest of its canonical request in the `human_actions` row beside the key,
 *   and a later request **from that caller** under that key whose digest differs is
 *   `409 idempotency_key_reused` — the lookup is scoped `(user_id, action, key)`, so another
 *   account's identical string is not this caller's attempt (`findIdempotentAttempt`). A
 *   unique key alone cannot do this — a changed `name` on an existing project key is a silent
 *   replay, and `createIntegration` has no comparable key at all — and four places in this
 *   repository claim it can, so it is implemented rather than the sentences being narrowed.
 *
 * ## The guards run at `preValidation`, not `preHandler`, and that is forced rather than stylistic
 *
 * Fastify validates params and **body** before `preHandler`, so every command here — each of which
 * takes a body — would answer an anonymous caller `400` describing its own shape instead of `401`.
 * `routes/kb.ts` hit the same thing for a query parameter and a non-uuid path segment and moved its
 * guards for the same reason: an unauthenticated caller must not learn a route's shape. The census
 * is what found it, twice, and it now asks each command **by its own method** so a route that slips
 * back to `preHandler` fails there (`client-census.test.ts`).
 *
 * The cost is that the guard sees *unvalidated* params. {@link projectOf} therefore hands the
 * permission check a project id only when it is a uuid; anything else is treated as
 * organisation-scoped, the caller is still refused if they may not act, and the `400` arrives from
 * the validator a moment later. A malformed id never reaches a query.
 *
 * ## Nothing here accepts a credential
 *
 * `POST /api/integrations` takes `secret_refs` — the **names** of environment variables — and the
 * server reads the value from its own environment (or the `_FILE` companion, TD-020) and seals it.
 * A token is never typed into a browser, never travels through this API, and never appears in a
 * `human_actions` row: the audited params carry the provider, the name and the *field names*, which
 * is what an operator needs to reconstruct what was configured (BD-002, BD-003).
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  apiErrorSchema,
  createIntegrationRequestSchema,
  createProjectRequestSchema,
  type JsonObject,
  projectBindingsResponseSchema,
  projectRecordSchema,
  putProjectBindingsRequestSchema,
  startDiscoveryResponseSchema,
  testIntegrationResponseSchema,
  updateProjectConfigRequestSchema,
} from '@platform/contracts';
import { AUTONOMY_PRESET_VERSION, applyAutonomyPreset } from '@platform/domain';
import { secrets as secretAdapters } from '@platform/infrastructure';
import { findShippedProvider } from '@platform/integrations';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { OnboardingCommands } from '../onboarding.js';
import { OnboardingUnavailableError } from '../onboarding.js';
import type { Database } from '../queries/identity-queries.js';
import { findProjectRole } from '../queries/identity-queries.js';
import {
  createIntegration,
  createProject,
  ensureOrganisation,
  environmentSecretSource,
  ForbiddenSecretNameError,
  findProjectById,
  listProjectBindings,
  MissingSecretError,
  recordHumanAction,
  replaceProjectBindings,
  writeIntegrationHealth,
  writeProjectConfig,
} from '../queries/onboarding-queries.js';
import { configHashOf, idempotencyGuard, requireIdempotencyKey } from './idempotency.js';

export interface OnboardingRoutesOptions {
  readonly database: Database;
  /** `APP_SECRET_KEY`; the envelope an integration's credential is sealed under. */
  readonly secretKey: string;
  /**
   * The wizard's commands, or `null` on a process that composed none.
   *
   * `null` is answered with `503` rather than `404`, the shape `routes/kb.ts` uses: the path exists
   * and this process cannot serve it, which is a different thing from a URL that is not part of the
   * API.
   */
  readonly onboarding: OnboardingCommands | null;
  /** The process environment a `secret_refs` name is read from (TD-020). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * `APP_INTEGRATION_SECRET_ENV` — the names a caller may read a credential out of.
   *
   * Empty (the default) means the command refuses every `secret_refs` entry by name, which is the
   * fail-closed direction: the name is chosen by an `integration.write` caller, and without a
   * declared list that caller could name the platform's own `APP_SECRET_KEY`.
   * `queries/onboarding-queries.ts` carries the full argument and the residual.
   */
  readonly integrationSecretEnv?: readonly string[];
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });
const integrationParamsSchema = z.strictObject({ integration_id: z.uuid() });

/**
 * How long `POST /api/integrations/:id/test` waits for the account's rate-limit budget.
 *
 * Ten seconds: long enough that a probe behind one or two pipeline calls still answers, short
 * enough that a browser gets a message rather than a hung connection. It bounds the **wait**, not
 * the provider call — the provider's own timeout is the adapter's.
 */
export const PROBE_TIMEOUT_MS = 10_000;

export const registerOnboardingRoutes = async (
  app: FastifyInstance,
  options: OnboardingRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      findProjectRole(options.database, projectId, userId),
  };
  /**
   * The project id, or `undefined` when the path segment is not one.
   *
   * `undefined` means "organisation-scoped" to `requirePermission`, which is the right reading: the
   * guards run **before** validation (see the module docblock), so this is the one place that has
   * to cope with a segment the schema has not checked yet, and handing a non-uuid to a `uuid`
   * column would turn a `400` into a `500`. The same shape `routes/kb.ts` uses.
   */
  const projectOf = (request: FastifyRequest): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };

  const commands = (): OnboardingCommands => {
    if (options.onboarding === null) {
      throw new HttpError(
        503,
        'onboarding_unavailable',
        'this process composed no onboarding commands: it serves the API without a pipeline, so it cannot start a discovery run or test an integration. Ask an instance that runs the workers',
      );
    }
    return options.onboarding;
  };

  const actorOf = (request: FastifyRequest): { userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      // Unreachable through `requirePermission`, which refuses an anonymous caller first; kept
      // because the audit row's user id is not optional and a 500 would be the wrong answer.
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
  };

  const secretSource = environmentSecretSource(
    options.env ?? process.env,
    (path) => readFile(path, 'utf8'),
    options.integrationSecretEnv ?? [],
  );

  typed.post(
    '/api/projects',
    {
      preValidation: requirePermission(guard, 'project.create'),
      schema: {
        summary: 'Create a project (the wizard’s step 1)',
        description:
          'Idempotent on `key`: a repeated create answers with the project that already has it, and a **different** body under the same key is a 409 naming the conflict. The autonomy dial is step 4 (`PUT …/config`), not this command, so the project starts at the platform default.',
        tags: ['projects'],
        body: createProjectRequestSchema,
        response: { 200: projectRecordSchema, 201: projectRecordSchema, 409: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const key = requireIdempotencyKey(request);
      // The actor first: a key is scoped to the caller who used it (`./idempotency.ts`).
      const actor = actorOf(request);
      const digest = await idempotencyGuard(options.database, {
        userId: actor.userId,
        action: 'project.create',
        key,
        request: request.body,
      });
      // Created on demand: `bootstrapAdministrator` makes the first user and no organisation, so
      // a fresh instance had an administrator who could not create a project (`ensureOrganisation`
      // has the reasoning and the lock).
      const orgId = await ensureOrganisation(options.database);
      const result = await createProject(
        options.database,
        orgId,
        {
          key: request.body.key,
          name: request.body.name,
          repoUrl: request.body.repo_url,
          ...(request.body.default_branch === undefined
            ? {}
            : { defaultBranch: request.body.default_branch }),
          ...(request.body.knowledge_dir === undefined
            ? {}
            : { knowledgeDir: request.body.knowledge_dir }),
        },
        // The audit row **inside** the insert's transaction: it is also the idempotency record, so
        // a crash between the two would leave a key with no digest (`findIdempotentAttempt`).
        {
          userId: actor.userId,
          action: 'project.create',
          params: { key: request.body.key, idempotency_key: key, body_digest: digest },
        },
      );
      if (result.status === 'exists' && result.project.repo_url !== request.body.repo_url) {
        // A different body under a taken key. The stored-response table technical/08's header
        // implies would replay the first answer; without one, saying so is the honest ending.
        throw new HttpError(
          409,
          'conflict',
          `project key "${request.body.key}" already names a different repository (${result.project.repo_url}); pick another key`,
        );
      }
      if (result.status === 'created') {
        reply.code(201);
      }
      return result.project;
    },
  );

  typed.post(
    '/api/integrations',
    {
      preValidation: requirePermission(guard, 'integration.write'),
      schema: {
        summary: 'Create an integration from credentials already in the process environment',
        description:
          '`secret_refs` maps a provider credential **field** to the name of an environment variable (or its `_FILE` companion, TD-020); the value is read by the server and sealed into `secrets`. No credential crosses this API and none is written to the audit. The name must be one the operator declared in `APP_INTEGRATION_SECRET_ENV` — otherwise 403 `secret_name_not_permitted`, because the name is caller-chosen and the platform’s own variables must never be readable this way. Idempotent on `(type, name)`.',
        tags: ['org'],
        body: createIntegrationRequestSchema,
        response: {
          200: z.strictObject({ id: z.uuid(), provider: z.string(), name: z.string() }),
          201: z.strictObject({ id: z.uuid(), provider: z.string(), name: z.string() }),
          400: apiErrorSchema,
          403: apiErrorSchema,
          409: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const key = requireIdempotencyKey(request);
      const actor = actorOf(request);
      const digest = await idempotencyGuard(options.database, {
        userId: actor.userId,
        action: 'integration.create',
        key,
        request: request.body,
      });
      const orgId = await ensureOrganisation(options.database);
      const provider = findShippedProvider(request.body.provider);
      if (provider === undefined) {
        throw new HttpError(
          400,
          'provider_not_shipped',
          `this build does not ship provider "${request.body.provider}"; the shipped ones are the directories under packages/integrations/src/providers`,
        );
      }
      if (provider.type !== request.body.type) {
        throw new HttpError(
          400,
          'invalid_request',
          `provider "${provider.id}" is a ${provider.type} integration, not a ${request.body.type} one`,
        );
      }

      let result: Awaited<ReturnType<typeof createIntegration>>;
      try {
        result = await createIntegration(options.database, {
          orgId,
          integration: {
            type: request.body.type,
            provider: request.body.provider,
            name: request.body.name,
            config: request.body.config as JsonObject,
            secretRefs: (request.body.secret_refs ?? {}) as Readonly<Record<string, string>>,
          },
          provider,
          secretSource,
          secretKey: secretAdapters.deriveSecretKey(options.secretKey),
          newId: () => randomUUID(),
          // In the same transaction as the `secrets` and `integrations` inserts — see above.
          audit: {
            userId: actor.userId,
            action: 'integration.create',
            params: {
              provider: request.body.provider,
              name: request.body.name,
              // Field names, not values: what was configured, never what it was configured with.
              secret_fields: Object.keys(request.body.secret_refs ?? {}),
              idempotency_key: key,
              body_digest: digest,
            },
          },
        });
      } catch (error) {
        if (error instanceof ForbiddenSecretNameError) {
          // A name this deployment does not permit. 403 rather than 400: the request is
          // well-formed and the caller is not allowed to ask for it, and the message names the
          // setting an operator changes rather than saying whether the variable exists.
          throw new HttpError(403, 'secret_name_not_permitted', error.message);
        }
        if (error instanceof MissingSecretError) {
          // The variable's **name**, never its value — the name is the operator's own
          // configuration and is exactly what they have to fix.
          throw new HttpError(400, 'missing_secret', error.message);
        }
        throw error;
      }

      if (result.status === 'created') {
        reply.code(201);
      }
      return {
        id: result.integration.id,
        provider: result.integration.provider,
        name: result.integration.name,
      };
    },
  );

  typed.post(
    '/api/integrations/:integration_id/test',
    {
      // `integration.write` (admin) rather than `integration.read` (maintainer): the probe spends a
      // request against a third party with the organisation's credential, and product/11 gives
      // integrations to the admin. It mutates nothing — that is every `testConnection`'s promise —
      // but "read-only" is not the same as "free".
      preValidation: requirePermission(guard, 'integration.write'),
      schema: {
        summary: 'Ask the provider whether this integration’s credential works',
        description:
          'The provider’s own read-only probe (`testConnection`), through `IntegrationActionExecutor` like every other outbound call — so it is audited (BD-003) and takes the account’s rate limit. `ok: false` is a **successful test** reporting a failed connection, not a server error. `detail` is provider text through the integration’s own redactor (TD-012): render it, never execute it. The verdict is stored in `integrations.health`, which is what `GET /api/integrations` publishes. A probe still queued behind the account’s budget after ten seconds answers `429 probe_busy` with `Retry-After`; the call is not cancelled, so its verdict lands in `integrations.health` regardless.',
        tags: ['org'],
        params: integrationParamsSchema,
        response: {
          200: testIntegrationResponseSchema,
          404: apiErrorSchema,
          429: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const integrationId = request.params.integration_id;
      /**
       * **The wait is bounded here, because the caller is an HTTP request.**
       *
       * The executor's rate limiter *delays* rather than refusing (`RateLimiter.acquire` "resolves
       * when a concurrency slot **and** a token are available"), and the budget is the account's —
       * shared with the pipeline's own calls, which technical/06 permits and which is the point of
       * one executor per process. For a job that is right: a job that waits is a job that eventually
       * runs. For a *request* it is not: a browser holding a connection open behind an unbounded
       * queue is an outage with no message, so this races the probe against a deadline and answers
       * `429` with `Retry-After` instead. The call the limiter is still holding is not cancelled —
       * it completes, is audited and writes `integrations.health` — so a retry finds the verdict.
       */
      const probe = await Promise.race([
        commands().testIntegration(integrationId as never),
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => {
            resolve('timeout');
          }, PROBE_TIMEOUT_MS).unref();
        }),
      ]);
      if (probe === 'timeout') {
        reply.header('retry-after', String(Math.ceil(PROBE_TIMEOUT_MS / 1000)));
        throw new HttpError(
          429,
          'probe_busy',
          `this integration's outbound budget is saturated, so the connection test is still queued behind other calls to the same provider. It will finish and record its verdict in integrations.health; read GET /api/integrations in a moment, or try again`,
        );
      }
      if (probe === null) {
        throw new NotFoundError(`integration ${integrationId}`);
      }
      // A narrow write: `health` only (standing rule 79). `config` and `secret_ids` belong to the
      // create, and this statement runs while a wizard may be editing the same row.
      await writeIntegrationHealth(options.database, integrationId, {
        ok: probe.ok,
        checkedAt: probe.checkedAt,
        detail: probe.detail,
      });
      await recordHumanAction(options.database, {
        userId: actor.userId,
        action: 'integration.test',
        params: { integration_id: integrationId, ok: probe.ok },
      });
      return {
        ok: probe.ok,
        checks: [{ name: 'connection', ok: probe.ok, detail: probe.detail }],
      };
    },
  );

  typed.get(
    '/api/projects/:project_id/bindings',
    {
      preValidation: requirePermission(guard, 'project.read', { project: projectOf }),
      schema: {
        summary: 'The integrations this project is bound to',
        description:
          'Non-secret binding configuration only — a credential belongs to the integration, never to the binding.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: projectBindingsResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      if ((await findProjectById(options.database, projectId)) === null) {
        throw new NotFoundError(`project ${projectId}`);
      }
      return { items: [...(await listProjectBindings(options.database, projectId))] };
    },
  );

  typed.put(
    '/api/projects/:project_id/bindings',
    {
      preValidation: requirePermission(guard, 'project.settings.write', { project: projectOf }),
      schema: {
        summary: 'Replace this project’s integration bindings',
        description:
          'The **whole** set: a binding missing from the request is removed. That is what makes the wizard’s step 1 re-submittable and what lets a mistake be corrected without a second endpoint. One transaction, so a project is never left with no bindings at all.',
        tags: ['projects'],
        params: projectParamsSchema,
        body: putProjectBindingsRequestSchema,
        response: { 200: projectBindingsResponseSchema, 400: apiErrorSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const actor = actorOf(request);
      if ((await findProjectById(options.database, projectId)) === null) {
        throw new NotFoundError(`project ${projectId}`);
      }
      await replaceProjectBindings(
        options.database,
        projectId,
        request.body.items.map((item) => ({
          integrationId: item.integration_id,
          ...(item.config === undefined ? {} : { config: item.config as JsonObject }),
        })),
      );
      await recordHumanAction(options.database, {
        userId: actor.userId,
        action: 'project.bindings.write',
        params: {
          project_id: projectId,
          integration_ids: request.body.items.map((item) => item.integration_id),
        },
      });
      return { items: [...(await listProjectBindings(options.database, projectId))] };
    },
  );

  typed.put(
    '/api/projects/:project_id/config',
    {
      // `project.settings.write` is admin and `project.autonomy.write` is maintainer, so the
      // stricter of the two governs the one endpoint that writes both.
      preValidation: requirePermission(guard, 'project.settings.write', { project: projectOf }),
      schema: {
        summary: 'Write this project’s configuration and autonomy dial (the wizard’s step 4)',
        description:
          'The **whole** `.agentic/config.yml` document through the strict schema — an unknown key is refused, never dropped (technical/12). `autonomy_level` is materialised through the domain preset (BD-027), and a document whose `policies.autonomy` disagrees with it is refused rather than silently resolved. `base_hash` is optimistic concurrency: send the `hash` the last read gave you, or omit it to overwrite.',
        tags: ['projects'],
        params: projectParamsSchema,
        body: updateProjectConfigRequestSchema,
        response: {
          200: z.strictObject({ hash: z.string(), autonomy_level: z.string() }),
          409: apiErrorSchema,
          404: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const actor = actorOf(request);
      const { config, autonomy_level: requested, base_hash: baseHash } = request.body;
      const inDocument = config.policies?.autonomy;
      if (requested !== undefined && inDocument !== undefined && inDocument !== requested) {
        throw new HttpError(
          400,
          'invalid_request',
          `the dial says "${requested}" and policies.autonomy says "${inDocument}"; they have to agree`,
        );
      }
      const level = requested ?? inDocument;
      // Materialised at selection time, never at read time (BD-027): the preset's own version is
      // stored beside the level so a release that changes a preset does not silently change a
      // project's effective policies.
      const preset = level === undefined ? null : applyAutonomyPreset(level);
      const stored: JsonObject = {
        ...(config as JsonObject),
        ...(level === undefined
          ? {}
          : {
              policies: {
                ...((config.policies ?? {}) as JsonObject),
                autonomy: level,
              },
            }),
      };
      const hash = configHashOf(stored);
      const result = await writeProjectConfig(options.database, projectId, {
        config: stored,
        hash,
        ...(level === undefined ? {} : { autonomyLevel: level }),
        ...(baseHash === undefined ? {} : { baseHash }),
      });
      if (result.status === 'not_found') {
        throw new NotFoundError(`project ${projectId}`);
      }
      if (result.status === 'conflict') {
        throw new HttpError(
          409,
          'config_conflict',
          `this project's configuration has moved since you read it (its hash is now ${result.currentHash ?? 'unconfigured'}); re-read it and apply your change again`,
        );
      }
      await recordHumanAction(options.database, {
        userId: actor.userId,
        action: 'project.config.write',
        params: {
          project_id: projectId,
          hash,
          ...(level === undefined
            ? {}
            : {
                autonomy_level: level,
                autonomy_preset_version: AUTONOMY_PRESET_VERSION,
                // The materialised policies, so the audit records what the dial *meant* at the time
                // rather than only which word was chosen (BD-027's whole point).
                probation_tasks: preset?.probationTasks ?? null,
                plan_approval: preset?.planApproval ?? null,
              }),
        },
      });
      return { hash, autonomy_level: level ?? 'unchanged' };
    },
  );

  typed.post(
    '/api/projects/:project_id/discovery',
    {
      preValidation: requirePermission(guard, 'discovery.run', { project: projectOf }),
      schema: {
        summary: 'Start the Discovery agent on this project (the wizard’s step 2)',
        description:
          'Creates a one-off task on the `discovery` template and enqueues its single read-only agent stage, so the run is budgeted, transcribed and cost-accounted exactly like every other run. Idempotent on the project: a second call answers `started: false` with the task the first one created, because re-running discovery would spend a second budget for the same question. Follow the task with `GET /api/tasks/:id`.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: {
          200: startDiscoveryResponseSchema,
          202: startDiscoveryResponseSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const key = requireIdempotencyKey(request);
      const projectId = request.params.project_id;
      // The body is empty, so the request *is* the project the path names: a key reused for a
      // different project is the reuse this guard exists to catch.
      const actor = actorOf(request);
      const digest = await idempotencyGuard(options.database, {
        userId: actor.userId,
        action: 'project.discovery.start',
        key,
        request: { project_id: projectId },
      });
      if ((await findProjectById(options.database, projectId)) === null) {
        throw new NotFoundError(`project ${projectId}`);
      }
      let result: Awaited<ReturnType<OnboardingCommands['startDiscovery']>>;
      try {
        result = await commands().startDiscovery({
          projectId: projectId as never,
          userId: actor.userId as never,
        });
      } catch (error) {
        if (error instanceof OnboardingUnavailableError) {
          throw new HttpError(503, 'onboarding_unavailable', error.message);
        }
        throw error;
      }
      if (result.status === 'unavailable') {
        throw new HttpError(409, 'discovery_unavailable', result.detail);
      }
      if (result.status === 'started') {
        await recordHumanAction(options.database, {
          userId: actor.userId,
          action: 'project.discovery.start',
          params: {
            project_id: projectId,
            task_id: result.taskId,
            idempotency_key: key,
            body_digest: digest,
          },
          taskId: result.taskId,
        });
        reply.code(202);
      }
      return {
        task_id: result.taskId,
        started: result.status === 'started',
        detail: result.detail,
      };
    },
  );
};
