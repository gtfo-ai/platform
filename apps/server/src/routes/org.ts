/**
 * The organisation-scoped reads of technical/08's endpoint table, at three different role levels.
 *
 * `GET /api/org/users` needs `org.read` (viewer and above), `GET /api/org/audit` needs
 * `org.audit.read` (maintainer and above, Q36), and the two WP-15h part 2 added — `GET
 * /api/org/agents` (`run.read`) and `GET /api/org/inbox` (`task.read`) — are both viewer. So one
 * signed-in `member` still sees both sides of the RBAC decision on this file alone, which is why
 * these live together: a guard that only appears in its own unit test is a guard nobody has watched
 * refuse a live request.
 *
 * **Neither of the two new ones filters by organisation**, and that matches every other
 * organisation-wide read in this server (`listUsers`, `listAuditEntries`): this is a
 * single-organisation self-hosted deployment (product/01) and no route has ever filtered on
 * `org_id`. Written up in `PROGRESS.md` as the assumption it is.
 *
 * What technical/08 names and this server still does not serve is enumerated, with the row that
 * owns each one, in `routes/client-census.test.ts` — which fails if that list drifts from the
 * router in either direction.
 */
import {
  agentsResponseSchema,
  inboxResponseSchema,
  orgAuditQuerySchema,
  orgAuditResponseSchema,
  orgUsersResponseSchema,
} from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requirePermission } from '../auth/rbac.js';
import { BadRequestError } from '../errors.js';
import type { Database } from '../queries/identity-queries.js';
import { findProjectRole, listAuditEntries, listUsers } from '../queries/identity-queries.js';
import { listInbox, listRunningAgents } from '../queries/pipeline-queries.js';

export interface OrgRoutesOptions {
  readonly database: Database;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * The audit cursor is the ISO timestamp this endpoint handed out as `next_cursor`.
 *
 * `paginationQuerySchema` types it as an opaque non-empty string, which is right for the API as a
 * whole — different endpoints page on different things — and wrong to hand straight to a query.
 * An unparseable value used to reach the driver as `new Date(NaN)`; it is a client error, so it is
 * answered as one.
 */
export const parseAuditCursor = (cursor: string): Date => {
  const at = new Date(cursor);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestError(
      'invalid_cursor',
      'cursor must be the `next_cursor` this endpoint returned (an ISO 8601 timestamp)',
    );
  }
  return at;
};

export const registerOrgRoutes = async (
  app: FastifyInstance,
  options: OrgRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      findProjectRole(options.database, projectId, userId),
  };

  typed.get(
    '/api/org/users',
    {
      preHandler: requirePermission(guard, 'org.read'),
      schema: {
        summary: 'List the organisation’s users',
        tags: ['org'],
        response: { 200: orgUsersResponseSchema },
      },
    },
    async () => ({ items: await listUsers(options.database) }),
  );

  typed.get(
    '/api/org/audit',
    {
      preHandler: requirePermission(guard, 'org.audit.read'),
      schema: {
        summary: 'Read the configuration audit log',
        description:
          'Append-only record of human configuration changes (technical/03). Secret values appear in `diff` as the literal "changed".',
        tags: ['org'],
        querystring: orgAuditQuerySchema,
        response: { 200: orgAuditResponseSchema },
      },
    },
    async (request) => {
      const query = request.query;
      const page = await listAuditEntries(options.database, {
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
        ...(query.cursor === undefined ? {} : { cursor: parseAuditCursor(query.cursor) }),
        ...(query.entity_type === undefined ? {} : { entityType: query.entity_type }),
      });
      return { items: page.items, next_cursor: page.nextCursor };
    },
  );

  typed.get(
    '/api/org/agents',
    {
      // `run.read` is `viewer`: the record is metadata — stage, model, tokens, cost — and carries
      // no model output. The transcript behind it is separately gated at `transcript.read`
      // (`routes/runs.ts` says why the two differ).
      preHandler: requirePermission(guard, 'run.read'),
      schema: {
        summary: 'Every agent that is still running',
        description:
          'The runs that have not reached an ending, newest first (technical/08 § "Agents"). Unpaginated: the list is bounded by how many runs a deployment executes at once, not by how long it has been up. `last_output_at` is null until the run has produced something.',
        tags: ['org'],
        response: { 200: agentsResponseSchema },
      },
    },
    async () => listRunningAgents(options.database),
  );

  typed.get(
    '/api/org/inbox',
    {
      preHandler: requirePermission(guard, 'task.read'),
      schema: {
        summary: 'Questions and approvals that are still waiting',
        description:
          'Open questions and pending approvals across the organisation, oldest first. technical/08 says "pending for the caller"; nothing records an assignee, so this answers what is pending and the permission check is what scopes it (see the module note). Question text is written by an agent and is untrusted content (BD-022): render it, never execute it — and it is copied out of `artifacts.data`, which TD-012 does not redact yet (PROGRESS backlog 35).',
        tags: ['org'],
        response: { 200: inboxResponseSchema },
      },
    },
    async () => listInbox(options.database),
  );
};
