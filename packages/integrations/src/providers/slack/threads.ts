/**
 * Which thread belongs to which task, and which question is open in it.
 *
 * Two port promises need this, and neither can be kept from a Slack payload alone:
 *
 *  1. **`postTaskThread` is idempotent by `taskId`.** "Slack will happily start a second thread;
 *     the port promises one, so the *adapter* has to remember" (`FakeCommunication` divergence 1).
 *  2. **A threaded reply is an answer.** An inbound `message` event carries a `thread_ts` and
 *     nothing else — no task, no question. Turning it into `task.question.answered` needs the
 *     mapping this directory holds.
 *
 * ## The durable half is the executor's, and that is deliberate
 *
 * The default implementation is in memory, so a restart forgets. That is a **divergence, written
 * down** (see `provider.ts`), and the platform's durable answer to "did I already do this" is
 * `IntegrationActionExecutor`'s idempotency store. A `ThreadRef` is JSON, so the executor *can*
 * replay one: given an `IdempotencyPlan` keyed by task, a second call after a restart returns the
 * stored ref and issues **zero** HTTP requests, which
 * `test/contract/integrations/slack-executor.contract.test.ts` asserts against a *fresh* adapter —
 * the only version of that assertion the in-memory map cannot fake.
 *
 * **The plan is the caller's, and no production caller writes one** (corrected at WP-15b). This
 * docblock and `provider.ts` both said `post_task_thread` "carries" one; it does not —
 * `provider.ts`'s `send({ action: 'post_task_thread' })` attaches no `idempotency`, and the plan in
 * that contract test is built by the test. So the durable half is *available* and unused, and a
 * restarted process really would open a second thread. Whoever gives the action a plan owns the
 * assertion; `slack/digest.ts` is the only place in this repository that ships one.
 *
 * The interface is exported so WP-15 can supply a database-backed one without touching the
 * adapter: it is the seam, not an implementation detail.
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
  /** The task a thread belongs to, or `null` when this binding never opened it. */
  taskForThread(handle: SlackThreadHandle): Id | null;
  /** Records a question posted into a thread. The latest one is what a reply answers. */
  rememberQuestion(handle: SlackThreadHandle, questionId: Id): void;
  /** The most recently posted question in a thread, or `null`. */
  latestQuestion(handle: SlackThreadHandle): Id | null;
}

/**
 * Map key for a thread. The separator is written as the escape `\0`, never as a literal NUL
 * byte: a NUL in the source makes git treat the whole file as binary, so its diff renders as
 * "Bin 0 -> 3808 bytes", `grep -rn` skips it and it cannot be three-way merged. It happened at
 * WP-05 and again here, which is why `pnpm run -s nul:check` now fails the build on one.
 *
 * The separator stays unambiguous: a Slack channel id is `[A-Z0-9]+` and a `ts` is digits and a
 * dot, so neither half can contain a NUL.
 */
const keyOf = (handle: SlackThreadHandle): string => `${handle.channel}\0${handle.threadTs}`;

/**
 * The default directory: a map, bounded.
 *
 * `maxThreads` exists because this is reachable from an unbounded stream of tasks in a long-lived
 * process; the oldest entry is evicted, which costs a forgotten thread (a lost answer *route*,
 * recoverable) rather than a growing map (a lost process).
 */
export const createMemoryThreadDirectory = (maxThreads = 1000): SlackThreadDirectory => {
  const byTask = new Map<Id, SlackThreadHandle>();
  const taskByThread = new Map<string, Id>();
  const questionByThread = new Map<string, Id>();

  const evictIfNeeded = (): void => {
    while (byTask.size > maxThreads) {
      const [oldest] = byTask.keys();
      if (oldest === undefined) {
        return;
      }
      const handle = byTask.get(oldest);
      byTask.delete(oldest);
      if (handle !== undefined) {
        taskByThread.delete(keyOf(handle));
        questionByThread.delete(keyOf(handle));
      }
    }
  };

  return {
    rememberThread: (taskId, handle) => {
      byTask.set(taskId, handle);
      taskByThread.set(keyOf(handle), taskId);
      evictIfNeeded();
    },
    threadForTask: (taskId) => byTask.get(taskId) ?? null,
    taskForThread: (handle) => taskByThread.get(keyOf(handle)) ?? null,
    rememberQuestion: (handle, questionId) => {
      questionByThread.set(keyOf(handle), questionId);
    },
    latestQuestion: (handle) => questionByThread.get(keyOf(handle)) ?? null,
  };
};
