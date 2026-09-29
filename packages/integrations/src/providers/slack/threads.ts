/**
 * Which thread this adapter instance opened for which task — `postTaskThread`'s promise, kept for
 * the life of one instance.
 *
 * The port promises one thread per task: "Slack will happily start a second thread; the port
 * promises one, so the *adapter* has to remember" (`FakeCommunication` divergence 1). This map is
 * that memory, and it is **only** that.
 *
 * ## It is not the inbound map any more (WP-88, PROGRESS backlog 195)
 *
 * Until WP-88 this directory also answered "which task does this thread belong to, and which
 * question is open in it" for the inbound normaliser. The binding loader builds an adapter **per
 * call** so the redactor can carry the call's run-scoped credentials (Q55), so on the inbound path
 * the directory was always empty and a threaded reply reached nothing. The durable map is the
 * platform's: the notify duty records the thread in `chat_threads` (migration 0062) and the
 * question's message on its `notifications` row, and the ingress hands the normaliser
 * `InboundContext.resolveThread`. The two inbound methods this interface used to carry
 * (`taskForThread`, `latestQuestion`) and the writer beside them (`rememberQuestion`) are deleted
 * rather than left as a second, kinder answer a test could keep passing against.
 *
 * ## The durable half of the outbound promise is the executor's
 *
 * On the pipeline's path this map is empty on every call for the same reason, and the platform's
 * durable answer to "did I already open this thread" is `IntegrationActionExecutor`'s idempotency
 * store: `communicationWrites.taskThread` (`@platform/application`'s `pipeline/integrations.ts`)
 * attaches a plan keyed `<provider>:thread:<taskId>`, and a `ThreadRef` is JSON, so a second call
 * after a restart replays the stored ref and issues **zero** HTTP requests —
 * `test/contract/integrations/slack-executor.contract.test.ts` asserts it against a *fresh* adapter.
 */
import type { Id } from '@platform/contracts';

export interface SlackThreadHandle {
  readonly channel: string;
  readonly threadTs: string;
}

export interface SlackThreadDirectory {
  /** Records that `taskId`'s conversation lives at `handle`. Repeats are idempotent. */
  rememberThread(taskId: Id, handle: SlackThreadHandle): void;
  threadForTask(taskId: Id): SlackThreadHandle | null;
}

/**
 * The default directory: a map, bounded.
 *
 * `maxThreads` exists because this is reachable from an unbounded stream of tasks in a long-lived
 * process; the oldest entry is evicted, which costs a second thread for an old task (the executor's
 * idempotency plan still replays the first) rather than a growing map (a lost process).
 */
export const createMemoryThreadDirectory = (maxThreads = 1000): SlackThreadDirectory => {
  const byTask = new Map<Id, SlackThreadHandle>();

  const evictIfNeeded = (): void => {
    while (byTask.size > maxThreads) {
      const [oldest] = byTask.keys();
      if (oldest === undefined) {
        return;
      }
      byTask.delete(oldest);
    }
  };

  return {
    rememberThread: (taskId, handle) => {
      byTask.set(taskId, handle);
      evictIfNeeded();
    },
    threadForTask: (taskId) => byTask.get(taskId) ?? null,
  };
};
