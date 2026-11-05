/**
 * One transaction that appends to a **project** stream — WP-109 (PROGRESS backlog **333** and
 * **357**), and since BACKLOG 971 one that **waits** for the stream rather than racing for it.
 *
 * ## The shape it replaced, twice
 *
 * Every project-stream writer outside the dispatcher used to read `nextStreamSequence('project', …)`
 * over the **pool** and then open the transaction that appended at it. Another project-stream append
 * landing between the read and the commit failed the transaction with {@link StreamConflictError} —
 * migration 0005's sequence guard — and before WP-109 the knowledge passes let that fail the **job**
 * (measured 79 s, backlog 333). WP-109 retried it in place, four times; the integration stream's
 * identical loop lost four in a row under CI's load (BACKLOG 970), and a project stream is shared by
 * as many writers.
 *
 * Now the transaction's first statement is `scope.events.lockStreamSequence`: the project
 * stream's advisory lock, then its sequence on the transaction's own connection. Two writers of one
 * project wait for each other, and the read takes no second connection from the pool. The lock comes
 * before anything `work` locks, so it is the first lock of every project-stream transaction, and
 * no transaction takes it while holding a row.
 *
 * ## What the retry repeats, and what it never does
 *
 * `work` is called once per attempt with the freshly read sequence, inside a transaction of its own,
 * and must build its events from that sequence. A lost attempt's transaction has **rolled back**, so
 * everything `work` wrote in it — a claim, a row, an idempotency record — is written again by the
 * next attempt rather than duplicated. What `work` must not do is call a provider: anything read or
 * performed **before** this function is held by the caller's closure and is never repeated here,
 * which is the whole point of retrying in place instead of failing the job (WP-90's contract for the
 * delivery measures, now everybody's). A caller whose `work` reads only the transaction's own state
 * may re-decide on each attempt; one that holds an answer read outside states what that answer can
 * make stale.
 *
 * ## The bound
 *
 * {@link PROJECT_STREAM_APPEND_ATTEMPTS} tries, kept as the **defence** rather than the mechanism:
 * every project-stream writer takes the lock, so a conflict now means a writer that bypassed it.
 * After the last attempt the conflict is thrown to the caller, so a job still fails into pg-boss's
 * retry.
 *
 * Only a conflict on **this** project's stream is retried. A conflict on any other stream — a writer
 * that also appended to a task stream in the same transaction — is not a race this function can
 * win by re-reading the project's sequence, and it is rethrown on the first attempt.
 *
 * It refuses to run inside an open transaction ({@link assertOutsideTransaction}): it opens its own,
 * and a caller holding another connection's row locks while it waits on the stream lock is a wait
 * the database cannot see as a deadlock.
 */
import type { Id } from '@platform/contracts';
import { StreamConflictError } from '../errors.js';
import { assertOutsideTransaction } from '../events/open-transaction.js';
import type { Logger } from '../ports/logger.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';

/** How many times one project-stream append is tried before its conflict reaches the caller. */
export const PROJECT_STREAM_APPEND_ATTEMPTS = 4;

export interface ProjectStreamAppendDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly logger?: Logger;
}

const isThisProjectsConflict = (error: unknown, projectId: Id): error is StreamConflictError =>
  error instanceof StreamConflictError &&
  error.streamType === 'project' &&
  error.streamId === projectId;

/**
 * Runs `work` in a transaction at the project stream's next sequence, re-reading the sequence and
 * running it again on a lost race, up to {@link PROJECT_STREAM_APPEND_ATTEMPTS} times.
 *
 * `writer` names the caller in the debug line a lost race leaves, so a log reader can tell which
 * pass collided.
 */
export const appendOnProjectWithRetry = async <T>(
  dependencies: ProjectStreamAppendDependencies,
  request: { readonly projectId: Id; readonly writer: string },
  work: (scope: TransactionScope, streamSeq: number) => Promise<T>,
): Promise<T> => {
  assertOutsideTransaction(`a project stream append (${request.writer})`);
  for (let attempt = 1; ; attempt += 1) {
    let streamSeq = 0;
    try {
      return await dependencies.unitOfWork.transaction(async (scope) => {
        streamSeq = await scope.events.lockStreamSequence('project', request.projectId);
        return work(scope, streamSeq);
      });
    } catch (error) {
      if (!isThisProjectsConflict(error, request.projectId)) {
        throw error;
      }
      if (attempt >= PROJECT_STREAM_APPEND_ATTEMPTS) {
        throw error;
      }
      dependencies.logger?.debug(
        {
          project_id: request.projectId,
          writer: request.writer,
          attempt,
          stream_seq: streamSeq,
        },
        'a writer that bypassed the stream lock took the project stream’s sequence; running the transaction again at the next one, with nothing read outside it repeated',
      );
    }
  }
};
