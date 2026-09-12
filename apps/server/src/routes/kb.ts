/**
 * The knowledge-base surface of technical/08 § "Knowledge" (WP-18b).
 *
 * Four paths, and they close the three `kb/*` reads and the proposal command that
 * `routes/client-census.test.ts` has carried as admitted gaps since WP-15h:
 *
 *   GET  /api/projects/:project_id/kb/tree
 *   GET  /api/projects/:project_id/kb/doc?path=…
 *   GET  /api/projects/:project_id/kb/proposals
 *   POST /api/projects/:project_id/kb/proposals/:proposal_id/:decision
 *
 * ## Everything served here is untrusted text, and none of it is interpreted
 *
 * A proposal's `delta` is model output and a document's `content` is whatever somebody committed to
 * the project's repository (BD-022). The server neither renders nor parses either: it validates the
 * shape and passes the bytes, and the SPA puts them in React text nodes through
 * `apps/web/src/ui/untrusted.tsx`. The one transformation that *has* happened — TD-012's redaction —
 * happened at the **write**, which is why a reader here needs no redactor of its own.
 *
 * ## Two permissions, not one
 *
 * `kb.read` is `viewer` and `kb.proposal.decide` is `maintainer` (`packages/domain/src/permissions.ts`,
 * technical/08 § "Auth and RBAC"). Reading what the vault says is not the same act as accepting a
 * change to it, and the census asserts the 401 on every one of these paths per route rather than
 * once (standing rule 68).
 *
 * ## The guard runs at `preValidation`, and that is forced rather than stylistic
 *
 * Fastify validates params, query and body **before** `preHandler`, so a route with a required
 * query parameter (`/kb/doc?path=`) or a non-uuid path segment (`/{approve,reject,edit}`) answers
 * an anonymous caller `400` describing its own shape instead of `401`. Every other guarded route in
 * this server happens to take only uuids and therefore never noticed. Two reasons this moved rather
 * than the schemas being loosened: an unauthenticated caller must not learn a route's shape, and
 * `client-census.test.ts` asserts the 401 **per route** (standing rule 68) — so the census is what
 * found it.
 *
 * The cost is that the guard sees *unvalidated* params. {@link projectOf} therefore hands the
 * permission check a project id only when it is a uuid; anything else is treated as
 * organisation-scoped, the caller is still refused if they may not read, and the `400` arrives from
 * the validator a moment later. A malformed id never reaches a query.
 *
 * ## The decide path is three URLs and one body
 *
 * technical/08 spells the command as `.../proposals/:id/{approve,reject,edit}` while
 * `@platform/contracts` publishes one body carrying `decision`. The client sends both (its own
 * comment says why); this route takes the decision from the **path** and requires the body to agree,
 * so a mismatch is `invalid_request` rather than a silent choice between two sources of truth.
 */

import type { ProposalCursor, StoredKnowledgeProposal } from '@platform/application';
import {
  decideKbProposalRequestSchema,
  type Id,
  type IsoDateTime,
  kbDocResponseSchema,
  kbProposalsResponseSchema,
  kbTreeResponseSchema,
  knowledgeProposalRecordSchema,
  paginationQuerySchema,
} from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { KnowledgeCommands } from '../knowledge.js';
import type { Database } from '../queries/identity-queries.js';
import { findProjectRole } from '../queries/identity-queries.js';
import { findKbDoc, findKbTree } from '../queries/knowledge-queries.js';

export interface KbRoutesOptions {
  readonly database: Database;
  /**
   * The Librarian's commands, or `null` on a process that composed no pipeline.
   *
   * `null` is answered with `503` rather than `404`: the path exists and this process cannot serve
   * it, which is a different thing from a URL that is not part of the API (the shape
   * `platform-tools.ts` uses for a refusal that names itself).
   */
  readonly knowledge: KnowledgeCommands | null;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

const decideParamsSchema = z.strictObject({
  project_id: z.uuid(),
  proposal_id: z.uuid(),
  decision: z.enum(['approve', 'reject', 'edit']),
});

/** Default page size for the proposal queue; the client asks for the default. */
const DEFAULT_PROPOSAL_LIMIT = 50;

/**
 * The opaque cursor of technical/08's `next_cursor`, which is a **pair**.
 *
 * One curation writes every proposal of a batch with the same `created_at`, so a cursor of the
 * timestamp alone skips the rest of a batch whenever a page boundary falls inside one — and it does
 * it silently, because a short page is indistinguishable from the last page. The pair
 * `(created_at, id)` is the keyset the store orders by.
 *
 * It is **opaque by contract and parsed as untrusted input**: the client sends back whatever it was
 * given, so a malformed value is a `400` rather than a query with half a cursor in it.
 */
const encodeCursor = (proposal: StoredKnowledgeProposal): string =>
  `${proposal.createdAt}|${proposal.id}`;

const cursorSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});

const decodeCursor = (raw: string): ProposalCursor => {
  const separator = raw.lastIndexOf('|');
  const parsed = cursorSchema.safeParse({
    createdAt: separator < 0 ? '' : raw.slice(0, separator),
    id: separator < 0 ? '' : raw.slice(separator + 1),
  });
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_request',
      'the cursor is not one this endpoint issued; ask for the first page and follow next_cursor',
    );
  }
  return { createdAt: parsed.data.createdAt as IsoDateTime, id: parsed.data.id as Id };
};

/** `StoredKnowledgeProposal` → the published record. One mapping, two routes. */
const toRecord = (proposal: StoredKnowledgeProposal) =>
  knowledgeProposalRecordSchema.parse({
    id: proposal.id,
    project_id: proposal.projectId,
    task_id: proposal.taskId,
    run_id: proposal.runId,
    source: proposal.source,
    kind: proposal.kind,
    type: proposal.type,
    target_path: proposal.targetPath,
    delta: proposal.delta,
    evidence: [...proposal.evidence],
    significance: proposal.significance,
    status: proposal.status,
    decided_by_user_id: proposal.decidedByUserId,
    decided_at: proposal.decidedAt,
    applied_commit_sha: proposal.appliedCommitSha,
    created_at: proposal.createdAt,
  });

export const registerKbRoutes = async (
  app: FastifyInstance,
  options: KbRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      findProjectRole(options.database, projectId, userId),
  };
  /**
   * The project id, or `undefined` when the path segment is not one.
   *
   * `undefined` means "organisation-scoped" to `requirePermission`, which is the right reading here:
   * the guard runs before validation (see the module docblock), so this is the one place that has to
   * cope with a segment the schema has not checked yet, and handing a non-uuid to a `uuid` column
   * would turn a `400` into a `500`.
   */
  const projectOf = (request: { params: unknown }): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };

  const commands = (): KnowledgeCommands => {
    if (options.knowledge === null) {
      throw new HttpError(
        503,
        'knowledge_unavailable',
        'this process composed no librarian: it serves the API without a pipeline, so it cannot read or decide knowledge proposals. Ask an instance that runs the workers.',
      );
    }
    return options.knowledge;
  };

  typed.get(
    '/api/projects/:project_id/kb/tree',
    {
      preValidation: requirePermission(guard, 'kb.read', { project: projectOf }),
      schema: {
        summary: 'The indexed knowledge base of a project, as a tree',
        description:
          'The pages the platform has **indexed** at `commit_sha` (BD-012: the index is derived and rebuildable), not a listing of the repository. Directories are synthesised from the paths. Every path and every token count is data, never markup.',
        tags: ['knowledge'],
        params: projectParamsSchema,
        response: { 200: kbTreeResponseSchema },
      },
    },
    async (request) => findKbTree(options.database, request.params.project_id),
  );

  typed.get(
    '/api/projects/:project_id/kb/doc',
    {
      preValidation: requirePermission(guard, 'kb.read', { project: projectOf }),
      schema: {
        summary: 'One indexed knowledge document',
        description:
          'The document as the **index** holds it: its chunks re-joined in order, sanitised at parse (technical/07) and prefixed on the first chunk with `project / path / heading`. It is not byte-identical to the file in git. Untrusted content (BD-022): render it, never execute it.',
        tags: ['knowledge'],
        params: projectParamsSchema,
        querystring: z.strictObject({ path: z.string().min(1).max(512) }),
        response: { 200: kbDocResponseSchema },
      },
    },
    async (request) => {
      const document = await findKbDoc(
        options.database,
        request.params.project_id,
        request.query.path,
      );
      if (document === null) {
        throw new NotFoundError(`knowledge document ${request.query.path}`);
      }
      return document;
    },
  );

  typed.get(
    '/api/projects/:project_id/kb/proposals',
    {
      preValidation: requirePermission(guard, 'kb.read', { project: projectOf }),
      schema: {
        summary: 'The project’s knowledge proposals, newest first',
        description:
          'BD-018’s queue: every proposal the Librarian recorded, whatever the policy decided about it — `queued` waits for a maintainer, `auto_applied` waits for a commit, `discarded` is the audit trail of what was dropped. `next_cursor` is an **opaque** keyset over `(created_at, id)`: send it back unchanged, never parse it. Proposal text is model output (BD-022).',
        tags: ['knowledge'],
        params: projectParamsSchema,
        querystring: paginationQuerySchema,
        response: { 200: kbProposalsResponseSchema },
      },
    },
    async (request) => {
      const limit = request.query.limit ?? DEFAULT_PROPOSAL_LIMIT;
      const proposals = await commands().list(request.params.project_id as never, {
        limit,
        ...(request.query.cursor === undefined
          ? {}
          : { before: decodeCursor(request.query.cursor) }),
      });
      const last = proposals.at(-1);
      return {
        items: proposals.map(toRecord),
        // The cursor is the page's **last row**, which is what `list` compares against. A short page
        // is the last one, so it carries no cursor rather than one that answers nothing.
        next_cursor: proposals.length < limit || last === undefined ? null : encodeCursor(last),
      };
    },
  );

  typed.post(
    '/api/projects/:project_id/kb/proposals/:proposal_id/:decision',
    {
      preValidation: requirePermission(guard, 'kb.proposal.decide', { project: projectOf }),
      schema: {
        summary: 'Approve, reject or edit a knowledge proposal',
        description:
          'BD-018: an approval makes the proposal appliable and the platform commits it on an `agentic/knowledge/*` branch with a merge request — never onto the default branch. A rejection is terminal and writes nothing to git. An `edit` is an approval carrying the maintainer’s own replacement text.',
        tags: ['knowledge'],
        params: decideParamsSchema,
        body: decideKbProposalRequestSchema,
        response: { 200: knowledgeProposalRecordSchema },
      },
    },
    async (request) => {
      const { decision } = request.params;
      if (request.body.decision !== decision) {
        throw new HttpError(
          400,
          'invalid_request',
          `the path says "${decision}" and the body says "${request.body.decision}"; they have to agree`,
        );
      }
      const actor = request.actor;
      if (actor === undefined) {
        // Unreachable through `requirePermission`, which refuses an anonymous caller first; kept
        // because the user id below is not optional and a 500 here would be the wrong answer.
        throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
      }
      const result = await commands().decide({
        projectId: request.params.project_id as never,
        proposalId: request.params.proposal_id as never,
        decision,
        userId: actor.userId as never,
        ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
        ...(request.body.delta === undefined ? {} : { delta: request.body.delta }),
      });
      switch (result.status) {
        case 'decided':
          return toRecord(result.proposal);
        case 'not_found':
          throw new NotFoundError(`knowledge proposal ${request.params.proposal_id}`);
        case 'invalid':
          throw new HttpError(400, 'invalid_request', result.reason);
        default:
          throw new HttpError(
            409,
            'conflict',
            `this proposal is "${result.proposal.status}" and can no longer be decided`,
          );
      }
    },
  );
};
