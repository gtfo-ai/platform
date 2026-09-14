/**
 * The `ask_answer` outbound duty — product/10:57's *"and mirrored in the ticket thread"* (WP-31).
 *
 * It is a `pipeline.outbound` duty and not a handler, for the reason every provider call the
 * pipeline makes is one (WP-15d): a handler runs inside the dispatcher's transaction *and* its own,
 * so a call made from there holds a pooled connection and the platform's dispatch slot for as long
 * as somebody else's HTTP request takes. `events/open-transaction.ts` refuses the alternative
 * mechanically on both paths.
 *
 * ## Which asks the setting governs, and why it is not all of them
 *
 * `features.ask.mirror_to_ticket` is off by default (Q72 (d)) and it governs the **`ui`** ask only.
 * A `ticket` ask is answered in the ticket whatever the setting says, and the asymmetry is the
 * point: the setting exists so that the platform does not put its words in front of people who
 * never asked for them, and somebody who typed `@agentic ask` into the ticket thread **did** ask,
 * in that thread. An answer withheld from the place the question was asked is the platform ignoring
 * a person, which is worse than the thing the setting is protecting against.
 *
 * Four other refusals, each a different fact and each logged by name: there is no answer yet, it
 * has already been mirrored, the task is gone, or the project has no task-management binding.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { askCommentMarker } from '@platform/domain';
import type { PipelineIntegrationsPort } from '../pipeline/integrations.js';
import {
  integrationsForProject,
  noRunScopedSecrets,
  ticketWrites,
} from '../pipeline/integrations.js';
import type { PipelineOutboundData } from '../pipeline/jobs.js';
import type { ProjectSettingsPort } from '../pipeline/settings.js';
import type { PipelineStore } from '../pipeline/store.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { askFeature } from './settings.js';
import type { AskStore, StoredAsk } from './store.js';

export interface AskMirrorOptions {
  readonly unitOfWork: UnitOfWork;
  readonly asks: AskStore;
  readonly store: PipelineStore;
  readonly settings: ProjectSettingsPort;
  readonly integrations: PipelineIntegrationsPort;
  readonly clock: { now(): IsoDateTime };
  readonly logger?: Logger;
}

/**
 * What the ticket comment says.
 *
 * The **question** is not repeated: it is already in the thread when the ask came from there, and
 * quoting a `ui` question into somebody else's ticket would publish words the asker typed into a
 * different audience's tool. The citations are rendered as the platform's own list — a row
 * reference each, never a URL the model wrote (`AskAnswer.citations` has no URL field for exactly
 * that reason).
 */
export const renderAskComment = (ask: StoredAsk, baseUrl: string): string => {
  const link = `${baseUrl.replace(/\/+$/, '')}/tasks/${ask.taskId}`;
  const citations = ask.citations.map((citation) => {
    if (citation.kind === 'run') return `- run \`${citation.run_id ?? '(unnamed)'}\``;
    if (citation.kind === 'artifact') {
      return `- ${citation.artifact_type ?? '(unnamed)'} v${citation.version ?? '?'}`;
    }
    if (citation.kind === 'audit') return `- audit entry \`${citation.reference ?? '(unnamed)'}\``;
    return `- knowledge: \`${citation.reference ?? '(unnamed)'}\``;
  });
  return [
    `**Asked and answered** — ${askCommentMarker(ask.id)}`,
    '',
    ask.answer ?? '',
    ...(citations.length === 0 ? [] : ['', 'Based on:', ...citations]),
    '',
    `The full thread, with the runs behind this answer: ${link}`,
  ].join('\n');
};

export const runAskMirror = async (
  options: AskMirrorOptions & { readonly baseUrl: string },
  data: PipelineOutboundData & { readonly ask_id?: string },
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const askId = data.ask_id as Id | undefined;
  if (askId === undefined) {
    logger.warn({ job: data.duty }, 'an ask mirror job carried no ask id');
    return;
  }
  const ask = await options.unitOfWork.transaction(async (scope) =>
    options.asks.load(scope.tx, askId),
  );
  if (ask === null || ask.status !== 'answered' || ask.answer === null) {
    logger.debug({ ask_id: askId }, 'ask mirror: there is no answer to mirror');
    return;
  }
  if (ask.mirroredAt !== null) {
    logger.debug({ ask_id: askId }, 'ask mirror: already mirrored');
    return;
  }
  const settings = await options.settings.forProject(ask.projectId);
  if (ask.source === 'ui' && !askFeature(settings).mirrorToTicket) {
    logger.debug(
      { ask_id: askId, project_id: ask.projectId },
      'ask mirror: this project has not turned the ticket mirror on (Q72 (d))',
    );
    return;
  }
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, ask.taskId),
  );
  if (stored === null) {
    return;
  }
  const integrations = await integrationsForProject(
    options.integrations,
    ask.projectId,
    noRunScopedSecrets(),
  );
  const posted = await ticketWrites(integrations).askComment(
    stored.task.ticket,
    renderAskComment(ask, options.baseUrl),
    {
      projectId: ask.projectId,
      taskId: ask.taskId,
      // The **task's** mode, so a shadow task records `would_have` rather than writing on a real
      // ticket (BD-021). An ask does not have a mode of its own: it is about this task.
      mode: stored.task.mode,
      // The ask's id, so a redelivered wake-up and a second duty replay rather than post twice.
      idempotencyKey: `ask:${ask.id}`,
      markerId: askCommentMarker(ask.id),
    },
  );
  if (posted === null) {
    logger.debug({ ask_id: askId }, 'ask mirror: the project has no task-management binding');
    return;
  }
  await options.unitOfWork.transaction(async (scope) => {
    await options.asks.markMirrored(scope.tx, ask.id, options.clock.now());
  });
};
