/**
 * *I wrote it on …* — the person names the ticket or merge request where they wrote their link code,
 * and the core reads that thread **through the binding** (S-26.6, TD-031's 2026-11-06 amendment item
 * 9 (d)).
 *
 * It exists because a poll carries no comments (`ticket-poll.ts`): on a binding with no webhook a
 * code would otherwise never be seen. The author still comes from the provider's API, never from
 * the person.
 *
 * What it trusts and what it does not:
 *
 *  - **Who may ask** is the route's: the person's effective role in the project must be `member`
 *    or above (`403` otherwise), and the thread must be one the platform already knows in that
 *    project — a task's ticket or a task's merge request — so the platform's credential reads no
 *    thread outside a binding's scope on a person's say-so.
 *  - **Every read goes through `IntegrationActionExecutor`** (`ticketReads(...).comments`,
 *    `gitReads(...).discussions`, and the binding's own account, asked only when a comment carries a
 *    code), outside every transaction, like every read the platform makes for a person.
 *  - **The same rules as a webhook** apply to each comment (`linkCodeClaimOf`), and the claims go
 *    to the same recorder in a transaction of their own. A thread read twice records nothing
 *    twice: a match is one per author per code and a miss one per author per comment.
 *
 * The display name is redacted with the binding's redactor before it is stored, because a read's
 * result is unredacted (`action-executor.ts` redacts the audit row, not the value it hands back).
 */
import type { Id } from '@platform/contracts';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrationsPort,
  ticketReads,
} from '../pipeline/integrations.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { LinkCodeClaim } from '../ports/integrations/common.js';
import type { MergeRequestRefInput } from '../ports/integrations/git-provider.js';
import {
  MAX_LIST_COMMENTS_LIMIT,
  type TicketRefInput,
} from '../ports/integrations/task-management.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  EMPTY_LINK_RECORD,
  type IdentityLinkRecorder,
  type LinkRecordSummary,
} from './identity-links.js';
import { linkCodeClaimOf, onceBindingAccount } from './link-codes.js';

export type LinkThreadTarget =
  | { readonly kind: 'ticket'; readonly ticket: TicketRefInput }
  | { readonly kind: 'merge_request'; readonly mergeRequest: MergeRequestRefInput };

export type LinkThreadOutcome =
  | {
      readonly kind: 'read';
      /** How many comments the thread read answered. */
      readonly comments: number;
      /** How many of them carried a code. */
      readonly claims: number;
      readonly recorded: LinkRecordSummary;
    }
  /** The project has no binding of the thread's kind, or its provider cannot list comments. */
  | { readonly kind: 'no_binding' };

export interface LinkThreadOptions {
  readonly integrations: PipelineIntegrationsPort;
  readonly recorder: IdentityLinkRecorder;
  readonly unitOfWork: UnitOfWork;
}

const redactedName = (redactor: SecretRedactor, name: string | null | undefined): string | null =>
  name === null || name === undefined ? null : redactor.redactText(name).value;

/**
 * Reads the thread and records what its comments proved.
 *
 * @throws {IntegrationError} when the provider refuses the read; the caller answers it by name.
 */
export const readLinkThread = async (
  options: LinkThreadOptions,
  input: { readonly projectId: Id; readonly target: LinkThreadTarget },
): Promise<LinkThreadOutcome> => {
  const integrations = await integrationsForProject(
    options.integrations,
    input.projectId,
    noRunScopedSecrets(),
  );
  const context = { projectId: input.projectId, taskId: null };
  const claims: LinkCodeClaim[] = [];
  let comments: number;
  let integrationId: Id;

  if (input.target.kind === 'ticket') {
    const binding = integrations.taskManagement;
    if (binding === null) {
      return { kind: 'no_binding' };
    }
    const page = await ticketReads(integrations).comments(
      input.target.ticket,
      { limit: MAX_LIST_COMMENTS_LIMIT },
      context,
    );
    if (page === null) {
      return { kind: 'no_binding' };
    }
    integrationId = binding.ref.integrationId;
    comments = page.comments.length;
    const account = onceBindingAccount(
      async () => (await ticketReads(integrations).selfIdentity(context))?.external_id ?? null,
    );
    for (const comment of page.comments) {
      const claim = await linkCodeClaimOf(
        {
          provider: binding.ref.provider,
          commentId: comment.id,
          author: {
            externalId: comment.author.external_id,
            displayName: redactedName(binding.redactor, comment.author.display_name),
          },
          updateAuthorId: comment.update_author?.external_id ?? null,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at ?? null,
          text: comment.body,
        },
        account,
      );
      if (claim !== null) {
        claims.push(claim);
      }
    }
  } else {
    const git = integrations.git;
    if (git === null) {
      return { kind: 'no_binding' };
    }
    integrationId = git.ref.integrationId;
    const discussions = await gitReads(integrations).discussions(
      input.target.mergeRequest,
      context,
    );
    const account = onceBindingAccount(
      async () => (await gitReads(integrations).self(context))?.external_id ?? null,
    );
    comments = 0;
    for (const discussion of discussions) {
      for (const note of discussion.notes) {
        comments += 1;
        if (note.system) {
          continue;
        }
        const claim = await linkCodeClaimOf(
          {
            provider: git.ref.provider,
            commentId: note.id,
            author: {
              externalId: note.author.external_id,
              displayName: redactedName(git.redactor, note.author.display_name),
            },
            createdAt: note.created_at,
            updatedAt: note.updated_at ?? null,
            text: note.body,
          },
          account,
        );
        if (claim !== null) {
          claims.push(claim);
        }
      }
    }
  }

  if (claims.length === 0) {
    return { kind: 'read', comments, claims: 0, recorded: EMPTY_LINK_RECORD };
  }
  const recorded = await options.unitOfWork.transaction(async ({ tx }) =>
    options.recorder.record(tx, { integrationId, claims }),
  );
  return { kind: 'read', comments, claims: claims.length, recorded };
};
