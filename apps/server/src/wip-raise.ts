/**
 * **A raised WIP limit starts the queue — the server's half** (S-25.21, BACKLOG 1369).
 *
 * The two writes that can raise a limit in force call {@link recordWipRaise} once their own write
 * has committed: `PUT /api/projects/:id/config` with the limits the settings port answered before
 * and after it (`ProjectSettings.wip`, what admission counts against), `PATCH /api/org` with the
 * per-project comparison `org-caps.ts` computes in the write's own transaction. The event and the
 * argument for appending it after the commit are `packages/application/src/pipeline/wip-raised.ts`.
 *
 * `null` on a composition with no event store (`app.test.ts`, the census): the write is then served
 * and nothing is appended, which is the behaviour before S-25.21.
 *
 * **A failed append does not fail the write.** The configuration is committed by then, so answering
 * the caller 500 would report a write that happened as one that did not, and a retry would then
 * replay a key rather than append anything. The failure is logged at `error` with the project and
 * the limits, and the queued task waits for the next event the scheduler hears — the state before
 * S-25.21, never a task started past a limit.
 */
import { raisedWipLimits, type WipRaise, type WipRaisedRecorder } from '@platform/application';
import type { Id } from '@platform/contracts';
import type { WipLimits } from '@platform/domain';

/** The route's request logger — what a failed append is reported to. */
export interface WipRaiseLog {
  error(fields: Record<string, unknown>, message: string): void;
}

export interface WipRaiseNotifier {
  /** The limits admission uses for the project now (`ProjectSettings.wip`); `null` with no row. */
  readonly limitsInForce: (projectId: string) => Promise<WipLimits | null>;
  readonly recorder: WipRaisedRecorder;
}

/** Appends the project's `config.changed` when `raised` is not empty; nothing otherwise. */
export const recordWipRaise = async (
  notifier: WipRaiseNotifier,
  input: {
    readonly projectId: string;
    readonly scope: 'project' | 'org';
    readonly raised: readonly WipRaise[];
    readonly userId: string;
    readonly log: WipRaiseLog;
  },
): Promise<void> => {
  if (input.raised.length === 0) {
    return;
  }
  try {
    await notifier.recorder.record({
      projectId: input.projectId as Id,
      scope: input.scope,
      raised: input.raised,
      actor: { kind: 'user', user_id: input.userId as Id },
    });
  } catch (error) {
    input.log.error(
      { err: error, project_id: input.projectId, scope: input.scope, raised: input.raised },
      'a WIP limit was raised and its config.changed could not be appended; a queued task starts at the next event the scheduler hears',
    );
  }
};

/** The project write's comparison: in force before (read first) against in force now. */
export const recordProjectWipRaise = async (
  notifier: WipRaiseNotifier,
  input: {
    readonly projectId: string;
    readonly before: WipLimits | null;
    readonly userId: string;
    readonly log: WipRaiseLog;
  },
): Promise<void> => {
  if (input.before === null) {
    return;
  }
  const after = await notifier.limitsInForce(input.projectId);
  if (after === null) {
    return;
  }
  await recordWipRaise(notifier, {
    projectId: input.projectId,
    scope: 'project',
    raised: raisedWipLimits(input.before, after),
    userId: input.userId,
    log: input.log,
  });
};
