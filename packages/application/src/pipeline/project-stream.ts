/**
 * One transaction that appends to a **project** stream, retried in place when another writer took
 * the sequence first (WP-109, PROGRESS backlog **333** and **357**).
 *
 * ## The shape it replaces
 *
 * Every project-stream writer outside the dispatcher reads `nextStreamSequence('project', …)` over
 * the **pool** and then opens the transaction that appends at it. The read sees nothing a transaction
 * holds and locks nothing, so moving it inside the callback does not close the window — it only
 * shortens it (`knowledge/decide.ts` had it inside and raced all the same, backlog 357). Another
 * project-stream append landing between the read and the commit fails the transaction with
 * {@link StreamConflictError} — migration 0005's sequence guard — and before this module the
 * knowledge passes let that fail the **job**: pg-boss ran it again a minute later (measured 79 s,
 * backlog 333), and an operator command (the business interview, a knowledge rejection) answered
 * `500 internal_error`.
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
 * {@link PROJECT_STREAM_APPEND_ATTEMPTS} tries — the inbound audit log's bound
 * (`DEFAULT_INBOUND_SEQUENCE_ATTEMPTS`) and WP-90's, for the same reason: the race is another writer
 * taking the sequence in the milliseconds between the read and the append, and four consecutive
 * losses on one stream is contention nothing here should retry through. After the last attempt the
 * conflict is thrown to the caller exactly as before, so a job still fails into pg-boss's retry.
 *
 * Only a conflict on **this** project's stream is retried. A conflict on any other stream — a writer
 * that also appended to a task stream in the same transaction — is not a race this function can
 * win by re-reading the project's sequence, and it is rethrown on the first attempt.
 */
import type { Id } from '@platform/contracts';
import { StreamConflictError } from '../errors.js';
import type { EventStore } from '../ports/event-store.js';
import type { Logger } from '../ports/logger.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';

/** How many times one project-stream append is tried before its conflict reaches the caller. */
export const PROJECT_STREAM_APPEND_ATTEMPTS = 4;

export interface ProjectStreamAppendDependencies {
  readonly unitOfWork: UnitOfWork;
  /** The project stream's next sequence, read just before each attempt (the docblock says why). */
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
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
  for (let attempt = 1; ; attempt += 1) {
    const streamSeq = await dependencies.eventStore.nextStreamSequence(
      'project',
      request.projectId,
    );
    try {
      return await dependencies.unitOfWork.transaction((scope) => work(scope, streamSeq));
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
        'another writer took the project stream’s sequence; running the transaction again at the next one, with nothing read outside it repeated',
      );
    }
  }
};
