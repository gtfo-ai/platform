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
 * which drives them through a real Fastify instance over a **fake** `IdentityQueries`.
 *
 * That last word is why they are also driven against a real PostgreSQL in
 * `test/e2e/server/identity-api.e2e.test.ts`. A fake that returns what the route would like is not
 * evidence about the driver that answers it: the pair shipped answering **500** on every real
 * request, green in every tier, because the fake's `created_at` was a `Date` and the database's was
 * a string (`toWireIdentityMapping` below carries the mechanism). No screen calls these two, so no
 * client-driven tier would ever have found it either.
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

/**
 * One `user_identities` row as the two identity endpoints read and write it.
 *
 * `created_at` is a `Date`. It used to be `Date | string`, and the union was the defect: a fake
 * that answered one branch made an endpoint that only ever took the other look tested (standing
 * rule 1). A shape the real query cannot produce is now a type error rather than a 500.
 */
export interface IdentityMappingRecord {
  readonly provider: string;
  readonly external_id: string;
  /** WP-61, migration 0045: `machine` rows carry no `user_id` (the table's check says so). */
  readonly kind: 'person' | 'machine';
  readonly user_id: string | null;
  readonly display_name: string | null;
  readonly created_at: Date;
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
  /**
   * `userId: null` declares the account a **machine** (WP-61, PROGRESS backlog 88) — one row, so an
   * account is a person's or a machine and never both.
   */
  readonly upsertMapping: (input: {
    readonly provider: string;
    readonly externalId: string;
    readonly userId: string | null;
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
 * A function rather than two object literals because the two endpoints below publish the same row,
 * so a difference between them is impossible rather than unlikely. `email` is a column of the table
 * and is deliberately **not** published: nothing reads it, and the only thing that would is a match
 * the platform performed itself, which is the route `POST /api/org/identities` exists to replace
 * (BD-022, Q10).
 *
 * `created_at` is rendered here **unconditionally**, because the record carries a `Date`. It used
 * to be written `row.created_at instanceof Date ? … : row.created_at` over a `Date | string`, and
 * that branch is how the endpoint answered **500** on every real request while its route test
 * passed: `queries/identity-queries.ts` read the row through drizzle's raw `execute`, which hands a
 * `timestamptz` back unparsed, and the untouched string went out as the ISO instant the schema
 * demands. The query is on the builder path now and the union is gone; what is left here is one
 * conversion with no branch to be wrong about.
 */
export const toWireIdentityMapping = (row: IdentityMappingRecord) => ({
  provider: row.provider,
  external_id: row.external_id,
  kind: row.kind,
  user_id: row.user_id,
  display_name: row.display_name,
  created_at: row.created_at.toISOString() as IsoDateTime,
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
          'Open questions and pending approvals across the organisation, oldest first. technical/08 says "pending for the caller"; nothing records an assignee, so this answers what is pending and the permission check is what scopes it (see the module note). Question text is written by an agent and is untrusted content (BD-022): render it, never execute it — and it is copied out of `artifacts.data`, which has been redacted at the write since migration 0038 (TD-012, WP-52) — a question stored before that migration is served as it was stored, because `questions` is append-only.',
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
        summary: 'Map a provider account to a platform user, or declare it a machine',
        description:
          'A `kind: "machine"` body with no `user_id` declares the account a bot — CI, a dependency updater — which maps to nobody on purpose: none of its merge-request activity is counted as human review time, and nothing it writes is acted on (WP-61, PROGRESS backlog 88). It is an operator\'s statement and is never inferred from a name or a provider flag. Otherwise: PROGRESS backlog 79. Until a mapping exists, an author arriving from Jira, GitLab or Slack is `unmapped_identity` and nothing they write is ever acted on (BD-022, Q10) — a ticket comment cannot ask the task, answer a question or approve a plan. Upsert on `(provider, external_id)`: re-sending it moves the account to another person, which is what happens when somebody leaves. `email` is deliberately not taken: a match the platform performed itself is the route this endpoint exists to replace.',
        tags: ['org'],
        body: createIdentityMappingRequestSchema,
        response: { 200: identityMappingSchema, 400: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const body = request.body;
      // A **machine** names nobody (WP-61): there is no user to check, and the row's `user_id` is
      // `null` on purpose — which the table's own check (`user_identities_kind_has_user`) holds.
      const userId = body.kind === 'machine' ? null : body.user_id;
      // Checked here rather than left to the foreign key, because `user_id` is the whole point of
      // a person's row and `23503` reaches a caller as a 500 (`errors.ts` maps no driver code).
      if (userId !== null) {
        const user = await options.identities.findUser(userId);
        if (user === null) {
          throw new HttpError(409, 'unknown_user', `no platform user has id ${userId}`);
        }
      }
      const row = await options.identities.upsertMapping({
        provider: body.provider,
        externalId: body.external_id,
        userId,
        displayName: body.display_name ?? null,
      });
      // After the effect and only for an accepted one, which is `routes/commands.ts`'s rule: a
      // refused command leaves no row, so the count of rows is the count of things that happened.
      await options.identities.recordAction({
        userId: actor.userId,
        action: 'org.identity.map',
        params: {
          provider: row.provider,
          external_id: row.external_id,
          kind: row.kind,
          user_id: row.user_id,
          display_name_chars: (body.display_name ?? '').length,
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
        summary: 'Every provider account mapped to a platform user or declared a machine',
        description:
          '`display_name` is what the provider calls them and is never used to resolve anything — the mapping is `(provider, external_id) → user_id` and nothing else. A `machine` row has `user_id: null` (WP-61).',
        tags: ['org'],
        response: { 200: identityMappingListSchema },
      },
    },
    async () => ({
      items: (await options.identities.listMappings()).map(toWireIdentityMapping),
    }),
  );
};
