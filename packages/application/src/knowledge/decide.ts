/**
 * A maintainer's decision on one knowledge proposal — technical/08
 * `POST /api/projects/:id/kb/proposals/:proposal_id/{approve,reject,edit}` (WP-18b).
 *
 * ## The three decisions, and what each one is
 *
 *  - **approve** — the proposal is right as written. The row keeps `queued` and gains
 *    `decided_by`/`decided_at`; the commit is what makes it `applied`.
 *  - **edit** — the maintainer accepted it *after changing the text* (product/07: "can edit the
 *    proposal diff"). It is an approval with a replacement `delta`, which is why it is not a
 *    separate state: what a human wrote is what gets committed.
 *  - **reject** — `rejected`, terminal, and **nothing is written to git**. BD-018's whole claim is
 *    that a proposal is a governance object, so a rejection has to be a recorded decision rather
 *    than a deletion.
 *
 * ## "Approved" is `queued` with a decision on it, not a state of its own
 *
 * technical/02's machine is `scored → (discarded | queued | auto_applied) → (applied | rejected)`:
 * there is no state between "a human said yes" and "a commit carries it". So the pair
 * `status = 'queued' AND decided_at IS NOT NULL` **is** the approved state, `auto_applied` is the
 * same thing decided by policy instead of by a person, and `listAwaitingApply` answers to both.
 * Inventing a sixth status would have meant a migration, a new label in three enums and a state the
 * UI would have to learn — for a fact two existing columns already carry.
 *
 * ## The enqueue is optional, and the residual is stated
 *
 * A process that serves the API may hold no job runtime (`ROLE=api` runs no pg-boss), so this
 * command takes `jobs` as **nullable** and says what that costs rather than pretending otherwise:
 * with a job runtime the commit happens in seconds; without one the decision waits for the nightly
 * hygiene pass, which re-asks for an apply for every project with a decided-but-unapplied proposal.
 * Nothing is lost either way, which is the property that made this acceptable — the *decision* is
 * committed to the row before anything is enqueued.
 */
import type { Id } from '@platform/contracts';
import { knowledgeProposalRejectedEvent, MAX_PROPOSAL_DELTA_BYTES } from '@platform/contracts';
import type { Clock, IdSource } from '@platform/domain';
import { utf8ByteLength } from '@platform/domain';
import type { EventStore } from '../ports/event-store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { enqueueKnowledgeApply } from './apply.js';
import type { KnowledgeProposalStore, StoredKnowledgeProposal } from './ports.js';

export type ProposalDecisionKind = 'approve' | 'reject' | 'edit';

export interface DecideProposalInput {
  readonly projectId: Id;
  readonly proposalId: Id;
  readonly decision: ProposalDecisionKind;
  readonly userId: Id;
  /** Free text from a human, stored on the rejection event. */
  readonly reason?: string;
  /** `edit` only: the replacement the maintainer accepted. */
  readonly delta?: string;
}

export type DecideProposalResult =
  | { readonly status: 'decided'; readonly proposal: StoredKnowledgeProposal }
  | { readonly status: 'not_found' }
  /** The row exists and is past deciding — applied, rejected or discarded. */
  | { readonly status: 'not_decidable'; readonly proposal: StoredKnowledgeProposal }
  /** `edit` with no replacement text. */
  | { readonly status: 'invalid'; readonly reason: string };

export interface DecideProposalOptions {
  readonly unitOfWork: UnitOfWork;
  readonly eventStore: EventStore;
  readonly proposals: KnowledgeProposalStore;
  readonly clock: Clock;
  readonly ids: IdSource;
  /**
   * TD-012 over the replacement text of an `edit`.
   *
   * A maintainer pasting a page that contains a credential is the same write as a model doing it,
   * and it reaches the same two sinks. It covers the rejection **reason** as well, which goes to
   * `events.payload` — TD-012 names that column. Required, for the reason
   * `LibrarianJobOptions.redactor` is.
   */
  readonly redactor: SecretRedactor;
  /** Absent on a process with no job runtime; see the module docblock. */
  readonly jobs: Jobs | null;
  readonly logger?: Logger;
}

/** The statuses a human may still decide on. `auto_applied` is a decision the policy already made. */
const DECIDABLE = new Set(['scored', 'queued']);

export const decideKnowledgeProposal = async (
  options: DecideProposalOptions,
  input: DecideProposalInput,
): Promise<DecideProposalResult> => {
  if (input.decision === 'edit' && (input.delta === undefined || input.delta.length === 0)) {
    return { status: 'invalid', reason: 'an edit has to carry the replacement text' };
  }
  // The **same** budget the curator applies to a model's page, in the same unit. The wire schema
  // caps code units (`decideKbProposalRequestSchema`); this caps bytes, which is what the row, the
  // commit and the context pack actually carry, so an edit cannot be the one producer that is not
  // bounded. For ASCII the two are the same number; for anything else this is the tighter.
  if (input.delta !== undefined && utf8ByteLength(input.delta) > MAX_PROPOSAL_DELTA_BYTES) {
    return {
      status: 'invalid',
      reason: `the replacement page is over the ${MAX_PROPOSAL_DELTA_BYTES}-byte budget a knowledge page has`,
    };
  }
  const existing = await options.proposals.load(input.projectId, input.proposalId);
  if (existing === null) {
    return { status: 'not_found' };
  }
  if (!DECIDABLE.has(existing.status)) {
    return { status: 'not_decidable', proposal: existing };
  }

  const decidedAt = options.clock.now();
  const status = input.decision === 'reject' ? 'rejected' : 'queued';
  const redactedDelta =
    input.delta === undefined ? undefined : options.redactor.redactText(input.delta).value;
  /**
   * The rejection reason is redacted for the same argument the delta is, and it was not until
   * review round 2 found it.
   *
   * It is a human's free text on its way to `events.payload` — which is on TD-012's write list by
   * name — and a maintainer explaining *why* a page was rejected is exactly the person likely to
   * paste the credential the page contained. The sibling eight lines above had the argument and
   * this line did not have the call.
   */
  const redactedReason =
    input.reason === undefined ? undefined : options.redactor.redactText(input.reason).value;

  const decided = await options.unitOfWork.transaction(async (scope) => {
    const applied = await options.proposals.decide(scope.tx, {
      id: input.proposalId,
      status,
      decidedByUserId: input.userId,
      decidedAt,
      ...(redactedDelta === undefined ? {} : { delta: redactedDelta }),
    });
    if (!applied) {
      return false;
    }
    if (input.decision === 'reject') {
      const streamSeq = await options.eventStore.nextStreamSequence('project', input.projectId);
      await scope.events.append([
        knowledgeProposalRejectedEvent.parse({
          id: options.ids.next(),
          stream_type: 'project',
          stream_id: input.projectId,
          stream_seq: streamSeq,
          actor: { kind: 'user', user_id: input.userId },
          occurred_at: decidedAt,
          type: 'knowledge.proposal.rejected',
          payload: {
            project_id: input.projectId,
            proposal_id: input.proposalId,
            reason: redactedReason ?? null,
            decided_by_user_id: input.userId,
          },
        }),
      ]);
    }
    return true;
  });

  if (!decided) {
    // Another writer moved the row between the read and the write. Re-read rather than guess.
    const now = await options.proposals.load(input.projectId, input.proposalId);
    return now === null ? { status: 'not_found' } : { status: 'not_decidable', proposal: now };
  }

  if (input.decision !== 'reject') {
    if (options.jobs === null) {
      (options.logger ?? silentLogger).warn(
        { project_id: input.projectId, proposal_id: input.proposalId },
        'this process has no job runtime, so the approved knowledge proposal will be committed by the next nightly hygiene pass rather than now',
      );
    } else {
      await enqueueKnowledgeApply(options.jobs, {
        projectId: input.projectId,
        reason: 'decision',
      });
    }
  }

  const updated = await options.proposals.load(input.projectId, input.proposalId);
  return updated === null ? { status: 'not_found' } : { status: 'decided', proposal: updated };
};
