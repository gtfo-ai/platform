/**
 * A project's integration bindings and its tracker's statuses — the wizard's step 1 and the
 * project settings (WP-21; moved here at WP-181, which added the third route and the check).
 *
 *   GET  /api/projects/:project_id/bindings         the bindings, credential fields stripped
 *   PUT  /api/projects/:project_id/bindings         replace them; a lifecycle block is checked first
 *   GET  /api/projects/:project_id/ticket-statuses  the tracker's statuses, what a slot may name
 *
 * The three are one surface (WP-181 ruling (e)'s word for the server half): the pick lists WP-182
 * draws are the third route's answer, and the second route refuses a slot that names anything
 * else. They live in their own module, with every database function and the provider read
 * **injected**, so what the routes decide — the capability each asks, the refusal each earns, that
 * a refused write writes nothing — is driven through Fastify against plain functions
 * (`project-bindings.test.ts`), the shape `project-repository.ts` set; the statements themselves are
 * `queries/onboarding-queries.ts`'s and the integration tier's.
 *
 * ## The statuses read
 *
 * A **maintainer's** (`project.pipeline.write`): the slots are pipeline settings a maintainer picks,
 * and the read spends a provider call, so a viewer does not get to spend it. It goes through
 * `IntegrationActionExecutor` as a read (`ticket-statuses.ts`), outside every transaction. A project
 * with no task-management binding is `409 no_task_management_binding` — there is no tracker to ask,
 * which is not the same as a tracker with no statuses — and a tracker that cannot be read is
 * `503 lifecycle_statuses_unavailable`, the code the write's refusal uses for the same fact. The
 * answer is untrusted provider text (BD-022) and at most `MAX_TICKET_STATUSES` entries.
 *
 * ## The write
 *
 * Unchanged from WP-21/WP-100/WP-148 except for one step before it: `checkProposedLifecycles`
 * (`../lifecycle-check.ts`), which refuses `422 lifecycle_status_unknown` and
 * `503 lifecycle_statuses_unavailable` **before** the replace, so either refusal leaves the stored
 * bindings as they were and records no `human_actions` row.
 */
import {
  apiErrorSchema,
  type Id,
  type JsonObject,
  type ProjectBindingSummary,
  projectBindingsResponseSchema,
  putProjectBindingsRequestSchema,
  ticketStatusesResponseSchema,
  type UserRole,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { ProposedBindingItem } from '../lifecycle-check.js';
import type { BindingAccountIdentity, HumanActionInput } from '../queries/onboarding-queries.js';
import type { TicketStatusesAnswer } from '../ticket-statuses.js';

export interface ProjectBindingQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  readonly projectExists: (projectId: string) => Promise<boolean>;
  readonly listBindings: (projectId: string) => Promise<readonly ProjectBindingSummary[]>;
  /**
   * `replaceProjectBindings` with this process's `APP_INTEGRATION_HOSTS`; each item carries what
   * the save read of its account (`bindings.account_identity`, `null` when unknown).
   */
  readonly replaceBindings: (
    projectId: string,
    items: readonly (ProposedBindingItem & {
      readonly accountIdentity: BindingAccountIdentity | null;
    })[],
  ) => Promise<void>;
  readonly recordAction: (input: HumanActionInput) => Promise<void>;
}

export interface ProjectBindingRoutesOptions {
  readonly queries: ProjectBindingQueries;
  /**
   * The lifecycle check (`checkProposedLifecycles` over this process's accounts and statuses
   * reader). Required: a write that skipped it would save a mapping nobody checked.
   */
  readonly checkLifecycles: (projectId: Id, items: readonly ProposedBindingItem[]) => Promise<void>;
  /**
   * What each task-management binding acts as (`readProposedAccountIdentities`, WP-181 review round
   * 2, Q118 (a)) — read at the save so `GET …/readiness` makes no provider call. It never refuses:
   * an account it cannot read is `null` (unknown), and the save goes on.
   */
  readonly readAccountIdentities: (
    projectId: Id,
    items: readonly ProposedBindingItem[],
  ) => Promise<ReadonlyMap<string, BindingAccountIdentity | null>>;
  /** The saved binding's statuses, or `null` on a process that composed no integration stack. */
  readonly ticketStatuses: ((projectId: Id) => Promise<TicketStatusesAnswer>) | null;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

export const registerProjectBindingRoutes = async (
  app: FastifyInstance,
  options: ProjectBindingRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };
  /** A uuid project id or `undefined`: the guards run before validation (`onboarding.ts` says why). */
  const projectOf = (request: FastifyRequest): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };

  typed.get(
    '/api/projects/:project_id/bindings',
    {
      preValidation: requirePermission(guard, 'project.read', { project: projectOf }),
      schema: {
        summary: 'The integrations this project is bound to',
        description:
          'Non-secret binding configuration only — a credential belongs to the integration, never to the binding. The provider’s declared credential fields are removed here (a row stored before the write refused them), and a binding of a provider this build does not ship publishes an empty `config`.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: projectBindingsResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      if (!(await options.queries.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }
      return { items: [...(await options.queries.listBindings(projectId))] };
    },
  );

  typed.put(
    '/api/projects/:project_id/bindings',
    {
      preValidation: requirePermission(guard, 'project.settings.write', { project: projectOf }),
      schema: {
        summary: 'Replace this project’s integration bindings',
        description:
          'The **whole** set: a binding missing from the request is removed. That is what makes the wizard’s step 1 re-submittable and what lets a mistake be corrected without a second endpoint. One transaction, so a project is never left with no bindings at all. Each binding of a shipped provider is checked like an integration’s own configuration (WP-100): a credential field is `400 credential_in_config`, a URL outside `APP_INTEGRATION_HOSTS` is `403 integration_host_not_permitted`, an account whose own configuration no longer parses is `409 invalid_integration_config`, and an account-plus-overlay document the provider’s schema refuses is `400 invalid_binding_config`. A retired integration is `409 integration_retired` (WP-114). **WP-181:** a task-management binding whose `lifecycle` block names a status is checked against the tracker’s statuses first, through the executor: a name the tracker does not list is `422 lifecycle_status_unknown` naming the slot and the name, and a tracker that cannot be read is `503 lifecycle_statuses_unavailable` — both before anything is written. The answer publishes no credential field.',
        tags: ['projects'],
        params: projectParamsSchema,
        body: putProjectBindingsRequestSchema,
        response: {
          200: projectBindingsResponseSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          422: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const actor = request.actor;
      if (actor === undefined) {
        // Unreachable through `requirePermission`; the audit row's user id is not optional.
        throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
      }
      if (!(await options.queries.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }
      const items: ProposedBindingItem[] = request.body.items.map((item) => ({
        integrationId: item.integration_id,
        ...(item.config === undefined ? {} : { config: item.config as JsonObject }),
      }));
      // WP-181: before the write, so a refusal leaves the stored bindings as they were.
      await options.checkLifecycles(projectId as Id, items);
      // Q118 (a): the account each task-management binding acts as, stored for the readiness read.
      const identities = await options.readAccountIdentities(projectId as Id, items);
      await options.queries.replaceBindings(
        projectId,
        items.map((item) => ({
          ...item,
          accountIdentity: identities.get(item.integrationId) ?? null,
        })),
      );
      await options.queries.recordAction({
        userId: actor.userId,
        action: 'project.bindings.write',
        params: {
          project_id: projectId,
          integration_ids: request.body.items.map((item) => item.integration_id),
        },
      });
      return { items: [...(await options.queries.listBindings(projectId))] };
    },
  );

  typed.get(
    '/api/projects/:project_id/ticket-statuses',
    {
      preValidation: requirePermission(guard, 'project.pipeline.write', { project: projectOf }),
      schema: {
        summary: 'The statuses of this project’s tracker — what a lifecycle slot may name',
        description:
          'Read from the project’s task-management binding (`listStatuses`) through `IntegrationActionExecutor`, each with the platform’s category and the provider’s own key. Untrusted provider text (BD-022), at most `MAX_TICKET_STATUSES`. `409 no_task_management_binding` when the project has none; `503 lifecycle_statuses_unavailable` when the tracker cannot be read, never an empty list. A maintainer’s (`project.pipeline.write`).',
        tags: ['projects'],
        params: projectParamsSchema,
        response: {
          200: ticketStatusesResponseSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      if (!(await options.queries.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }
      if (options.ticketStatuses === null) {
        throw new HttpError(
          503,
          'lifecycle_statuses_unavailable',
          'this process composed no integrations, so it cannot read the tracker’s statuses. Ask an instance that runs the workers',
        );
      }
      const answer = await options.ticketStatuses(projectId as Id);
      if (answer.status === 'no_binding') {
        throw new HttpError(
          409,
          'no_task_management_binding',
          'this project has no task-management binding, so there is no tracker to read statuses from; bind one first',
        );
      }
      if (answer.status === 'unavailable') {
        throw new HttpError(503, 'lifecycle_statuses_unavailable', answer.reason);
      }
      return { items: [...answer.items] };
    },
  );
};
