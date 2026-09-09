/**
 * `GET /api/projects/:project_id/config` — the effective configuration with per-key provenance
 * (technical/08, technical/12 § "Effective configuration").
 *
 * One project-scoped route, for the same reason `routes/org.ts` has two organisation-scoped ones:
 * project scoping is a property of the RBAC middleware that only a real project-scoped request can
 * demonstrate. This one reads the columns migration 0003 already created (`projects.config`,
 * `config_source`, `config_hash`), so it needs nothing that does not exist yet.
 *
 * Writing the configuration, exporting it to the repository and recomputing the merge from the
 * repository's `.agentic/config.yml` are WP-15's; `packages/domain`'s `mergeEffectiveConfig` is
 * already there for it.
 */
import { agenticConfigSchema, effectiveConfigResponseSchema } from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { Database } from '../queries/identity-queries.js';
import { findProjectConfig, findProjectRole } from '../queries/identity-queries.js';

export interface ProjectRoutesOptions {
  readonly database: Database;
}

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

export const registerProjectRoutes = async (
  app: FastifyInstance,
  options: ProjectRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      findProjectRole(options.database, projectId, userId),
  };

  typed.get(
    '/api/projects/:project_id/config',
    {
      preHandler: requirePermission(guard, 'project.read', {
        // Project scoping: the caller's role for *this* project, which may be higher than their
        // organisation role (see auth/rbac.ts).
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'Effective project configuration, with the source of every key',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: effectiveConfigResponseSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const row = await findProjectConfig(options.database, projectId);
      if (row === null) {
        throw new NotFoundError(`project ${projectId}`);
      }

      // A project that has never been configured stores `{}`. The effective configuration of "no
      // configuration" is the schema's own minimum — version 1 and platform defaults for the rest
      // — not an empty object, which would not validate.
      const raw = Object.keys(row.config).length === 0 ? { version: 1 } : row.config;
      const parsed = agenticConfigSchema.safeParse(raw);
      if (!parsed.success) {
        throw new HttpError(
          500,
          'invalid_stored_config',
          `the stored configuration of project ${projectId} does not match the current schema; re-import it from the repository`,
        );
      }

      return {
        config: parsed.data,
        sources: row.configSource as Record<string, 'default' | 'org' | 'project' | 'repo'>,
        hash: row.configHash ?? 'unconfigured',
        computed_at: row.updatedAt.toISOString(),
      };
    },
  );
};
