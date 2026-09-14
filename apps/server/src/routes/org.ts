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
 * The pair WP-31 added — `POST` and `GET /api/org/identities` (`org.users.manage`, admin) — is the
 * only **command** on this file, and no screen calls either of them. That makes both invisible to
 * `routes/client-census.test.ts`, which compares the *client's* paths against the router, so they
 * are asserted by hand: positively in that census (served, 401, and absent from the client's list —
 * the shape `GET /api/projects/:id/kb/health` already has) and behaviourally in `./org.test.ts`,
 * which drives them through a real Fastify instance.
 *
 * What technical/08 names and this server still does not serve is enumerated, with the row that
 * owns each one, in `routes/client-census.test.ts` — which fails if that list drifts from the
 * router in either direction.
 */
import type { IsoDateTime, JsonObject } from '@platform/contracts';
import {
  agentsResponseSchema,
  apiErrorSchema,
  createIdentityMappingRequestSchema,
  identityMappingListSchema,
  identityMappingSchema,
  inboxResponseSchema,
  orgAuditQuerySchema,
  orgAuditResponseSchema,
  orgUsersResponseSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requirePermission } from '../auth/rbac.js';
import { BadRequestError, HttpError } from '../errors.js';
import type { Database } from '../queries/identity-queries.js';
import { findProjectRole, listAuditEntries, listUsers } from '../queries/identity-queries.js';
import { listInbox, listRunningAgents } from '../queries/pipeline-queries.js';

/** One `user_identities` row as the two identity endpoints read and write it. */
export interface IdentityMappingRecord {
  readonly provider: string;
  readonly external_id: string;
  readonly user_id: string;
  readonly display_name: string | null;
  readonly created_at: Date | string;
}

/**
 * The identity pair's four functions, bound to this process's database by the composition root.
 *
 * The four **reads** above still take `database` directly, and these do not — which is a deliberate
 * asymmetry rather than a half-finished refactor. `POST /api/org/identities` is the only **command**
 * on this file: it writes two rows (the mapping and its `human_actions` record), it decides who may
 * act as whom, and a route-level test of it is the thing WP-31 round 2 found missing. Bound as
 * functions it is drivable through the real router against plain functions, which is the shape
 * `routes/asks.ts`, `routes/commands.ts` and `routes/settings.ts` already use; the reads stay as
 * they are because a seam nothing drives is a seam that only makes the file longer.
 */
export interface IdentityQueries {
  /**
   * The platform user a mapping would point at, or `null`.
   *
   * Checked before the insert rather than left to the foreign key: `23503` reaches a caller as a
   * 500 (`errors.ts` maps no driver code), and "no platform user has id …" is a client error.
   */
  readonly findUser: (userId: string) => Promise<{ readonly id: string } | null>;
  readonly upsertMapping: (input: {
    readonly provider: string;
    readonly externalId: string;
    readonly userId: string;
    readonly displayName: string | null;
  }) => Promise<IdentityMappingRecord>;
  readonly listMappings: () => Promise<readonly IdentityMappingRecord[]>;
  /**
   * The `human_actions` row every command writes — technical/08 § "Rate limits and safety".
   *
   * `taskId` is null: a mapping is organisation-scoped and `human_actions` has no project column,
   * which is the same answer the wizard's seven commands give.
   */
  readonly recordAction: (input: {
    readonly userId: string;
    readonly action: string;
    readonly params: JsonObject;
    readonly taskId?: string | null;
  }) => Promise<void>;
}

export interface OrgRoutesOptions {
  readonly database: Database;
  readonly identities: IdentityQueries;
}

/**
 * One `user_identities` row on the wire (WP-31).
 *
 * A function rather than two object literals because the two endpoints below publish the same row
 * and `created_at` is the one field whose shape depends on the driver: `pg` answers a `timestamptz`
 * as a `Date` and a `sql` template can answer a string, so the conversion happens once and both
 * readers cannot disagree about it. `email` is a column of the table and is deliberately **not**
 * published: nothing reads it, and the only thing that would is a match the platform performed
 * itself, which is the route `POST /api/org/identities` exists to replace (BD-022, Q10).
 */
export const toWireIdentityMapping = (row: {
  readonly provider: string;
  readonly external_id: string;
  readonly user_id: string;
  readonly display_name: string | null;
  readonly created_at: Date | string;
}) => ({
  provider: row.provider,
  external_id: row.external_id,
  user_id: row.user_id,
  display_name: row.display_name,
  created_at: (row.created_at instanceof Date
    ? row.created_at.toISOString()
    : row.created_at) as IsoDateTime,
});

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

  /** Who is writing. Unreachable through `requirePermission`, which refuses an anonymous caller. */
  const actorOf = (request: FastifyRequest): { readonly userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
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

  /**
   * `POST /api/org/identities` — the writer `user_identities` has never had (WP-31, backlog **79**).
   *
   * The table has had a reader since WP-15c (`createPostgresIdentityDirectory`) and no insert
   * anywhere, so on every instance the map is **empty**: every ticket and chat author is unmapped,
   * every answer, approval and ask that arrives from a provider is dropped as
   * `unmapped_identity`, and product/03 UJ-2 step 4's *"PM answers in Jira"* has never worked. The
   * consequence is fail-closed, which is why it was a gap rather than a defect; what it needed was
   * the half nobody owned.
   *
   * It is an **operator** stating the mapping, and the two automatic routes stay refused on
   * purpose: an OAuth sign-in with the provider (TD-022 ships email and password) and an email
   * match the platform performs itself — which would let a *guessed* identity answer questions and
   * approve plans, the one thing BD-022 and Q10 refuse.
   *
   * `org.users.manage` (**admin**), because this decides who may act as whom.
   *
   * ## Two guarantees a command owes, and what each one is here
   *
   * **Every human action is recorded** (technical/08 § "Rate limits and safety"). It was not, until
   * WP-31 round 2: this route wrote the mapping and left nothing behind saying who had decided that
   * an account belongs to a person — on the one write in the product whose whole subject is who may
   * act as whom. It now writes one `human_actions` row per accepted request, after the upsert and
   * never for a refusal, in the shape WP-15i's routes use. `params` carries the **mapping** —
   * provider, external id, user id — because a row that did not name them would record that
   * *something* was mapped; `display_name` is a label the mapping never resolves anything by, so
   * only its length is recorded (`routes/asks.ts`'s "the shape of the request, never the words":
   * this route has no redactor, and a free-text field on its way to an audit row is the one place
   * a pasted credential would land).
   *
   * **No `Idempotency-Key`**, and that is a decision rather than an omission. The header exists to
   * separate a *retry* from a **different request under a used key** (`routes/idempotency.ts`), and
   * neither half applies: this is an upsert on the primary key `(provider, external_id)`, so a
   * retry writes the row it already wrote and creates nothing second, and a different body under a
   * used key is exactly the operation an operator performs when somebody leaves — re-mapping the
   * account to another person — which must be allowed rather than refused `409`. WP-21 requires the
   * header on the three wizard commands that **create**; this one has no resource to create twice.
   * What that costs, stated rather than implied: two identical requests leave **two** audit rows.
   * That is a true record of two requests, not a duplicated effect — and an audit row per request
   * is what `human_actions` is.
   */
  typed.post(
    '/api/org/identities',
    {
      preValidation: requirePermission(guard, 'org.users.manage'),
      schema: {
        summary: 'Map a provider account to a platform user',
        description:
          'PROGRESS backlog 79. Until a mapping exists, an author arriving from Jira, GitLab or Slack is `unmapped_identity` and nothing they write is ever acted on (BD-022, Q10) — a ticket comment cannot ask the task, answer a question or approve a plan. Upsert on `(provider, external_id)`: re-sending it moves the account to another person, which is what happens when somebody leaves. `email` is deliberately not taken: a match the platform performed itself is the route this endpoint exists to replace.',
        tags: ['org'],
        body: createIdentityMappingRequestSchema,
        response: { 200: identityMappingSchema, 400: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      // Checked here rather than left to the foreign key, because `user_id` is the whole point of
      // the row and `23503` reaches a caller as a 500 (`errors.ts` maps no driver code).
      const user = await options.identities.findUser(request.body.user_id);
      if (user === null) {
        throw new HttpError(409, 'unknown_user', `no platform user has id ${request.body.user_id}`);
      }
      const row = await options.identities.upsertMapping({
        provider: request.body.provider,
        externalId: request.body.external_id,
        userId: request.body.user_id,
        displayName: request.body.display_name ?? null,
      });
      // After the effect and only for an accepted one, which is `routes/commands.ts`'s rule: a
      // refused command leaves no row, so the count of rows is the count of things that happened.
      await options.identities.recordAction({
        userId: actor.userId,
        action: 'org.identity.map',
        params: {
          provider: row.provider,
          external_id: row.external_id,
          user_id: row.user_id,
          display_name_chars: (request.body.display_name ?? '').length,
        },
        taskId: null,
      });
      return toWireIdentityMapping(row);
    },
  );

  typed.get(
    '/api/org/identities',
    {
      // `org.read` would be too wide: a mapping says which human is behind a provider account, and
      // reading the list is how you would learn somebody's Slack handle. `org.users.manage`'s own
      // role (admin) reads it, which is the same person who writes it.
      preHandler: requirePermission(guard, 'org.users.manage'),
      schema: {
        summary: 'Every provider account mapped to a platform user',
        description:
          '`display_name` is what the provider calls them and is never used to resolve anything — the mapping is `(provider, external_id) → user_id` and nothing else.',
        tags: ['org'],
        response: { 200: identityMappingListSchema },
      },
    },
    async () => ({
      items: (await options.identities.listMappings()).map(toWireIdentityMapping),
    }),
  );
};
