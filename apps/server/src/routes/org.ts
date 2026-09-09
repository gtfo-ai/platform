/**
 * Two organisation reads from technical/08's endpoint table, at two different role levels.
 *
 * They are here because the RBAC middleware has to be exercised by something real: a guard that
 * only appears in its own unit test is a guard nobody has watched refuse a live request. `GET
 * /api/org/users` needs `org.read` (viewer and above) and `GET /api/org/audit` needs
 * `org.audit.read` (maintainer and above, Q36), so one signed-in `member` is enough to see both
 * sides of the decision.
 *
 * The rest of technical/08's surface belongs to the work packages that build what it reads — org
 * settings and budgets, projects, tasks, runs, knowledge. Adding stubs for them here would publish
 * an OpenAPI document describing endpoints that answer nothing.
 */
import {
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
};
