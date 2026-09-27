/**
 * **Structural waits for the suites that start real processes — bounded by the test, not by a
 * literal** (WP-69, PROGRESS backlog 25).
 *
 * A structural wait asserts that something *happens* — a socket file appears, a pid file is written,
 * a pid stops existing — and never how fast. Until WP-69 each one carried a hand-written deadline
 * (30 s twice in the conformance suite, 15 s in `waitForProcessGone`, 15 s twice in `shim.test.ts`:
 * five literals), and what such a deadline measures is **process scheduling**: the conformance
 * suite failed a push at a one-minute load of 12.63 and again at 7.97, inside the fully parallel
 * `unit`+`contract` run, and passed alone at 5.66 on the same commit. A number sized at one load is
 * wrong at the next, so none is written here.
 *
 * **Which level owns the bound: the project.** The suites that use these helpers run in vitest's
 * `process` project (`vitest.config.ts`), which runs **after** the parallel group and one file at a
 * time, with a `testTimeout` of its own — the precedent `integration` and `e2e-fake-claude` set for
 * suites that own real resources. Every wait here derives its deadline from the **running test's
 * own budget**, read off vitest at run time rather than inferred: it may use
 * {@link STRUCTURAL_WAIT_SHARE} of that budget, measured from the test's start, so the wait always
 * fails **first** and names the component it was waiting for — a shim that never spawns fails as
 * *"the shim to spawn the fake CLI …"*, not as `Test timed out` (rule 56: a timeout that reports
 * first blames nobody). A genuinely dead component still fails at the speed it dies wherever a
 * suite asserts the death itself; what this changes is only how long a slow host is given.
 *
 * `scripts/verify.test.ts` holds the membership in both directions: a test file that imports this
 * module is in the `process` project, and the `process` project holds nothing else.
 *
 * Not exported from the package barrel: it imports `vitest`, which has no place in anything that
 * runs (`entry.ts` explains the same for the run image).
 */
import { stat } from 'node:fs/promises';
import { TestRunner } from 'vitest';

/** The share of the running test's budget one structural wait may spend before it fails by name. */
export const STRUCTURAL_WAIT_SHARE = 0.75;

const POLL_MS = 20;

/** A structural wait that ran out of the share of its test's budget it was given. */
export class StructuralWaitExpiredError extends Error {
  readonly what: string;
  constructor(what: string, message: string) {
    super(message);
    this.name = 'StructuralWaitExpiredError';
    this.what = what;
  }
}

interface WaitBudget {
  readonly deadline: number;
  readonly allowedMs: number;
  readonly testTimeoutMs: number;
  readonly project: string;
}

/**
 * The running test's budget, **as vitest resolved it** — the project's `testTimeout`, or the
 * per-test override if one was written — and the instant the test started.
 */
export const currentWaitBudget = (): WaitBudget => {
  const test = TestRunner.getCurrentTest();
  if (test === undefined) {
    throw new Error(
      'a structural wait must run inside a test: its bound is that test’s own budget (the ' +
        '"process" project in vitest.config.ts)',
    );
  }
  const startedAt = test.result?.startTime ?? Date.now();
  const allowedMs = Math.floor(test.timeout * STRUCTURAL_WAIT_SHARE);
  return {
    deadline: startedAt + allowedMs,
    allowedMs,
    testTimeoutMs: test.timeout,
    project: test.file.projectName ?? '(unnamed)',
  };
};

/**
 * Polls until `ready` is true; fails naming `what` once the test's share is spent.
 *
 * `what` is a sentence about the **component**, in the infinitive — *"the shim to listen on its
 * control socket"* — because it is the whole of the failure a reader gets.
 */
export const waitUntil = async (
  what: string,
  ready: () => boolean | Promise<boolean>,
  pollMs = POLL_MS,
): Promise<void> => {
  const budget = currentWaitBudget();
  for (;;) {
    if (await ready()) {
      return;
    }
    if (Date.now() > budget.deadline) {
      throw new StructuralWaitExpiredError(
        what,
        `waited for ${what}, and it did not happen within ${budget.allowedMs} ms — ` +
          `${STRUCTURAL_WAIT_SHARE * 100}% of this test's ${budget.testTimeoutMs} ms budget, ` +
          `which the "${budget.project}" project owns (vitest.config.ts)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

/**
 * The same bound for a wait that is a **promise** rather than a condition — a frame the shim owes,
 * a process's `exit`, an SDK query running to its result.
 *
 * Without it such an `await` has no deadline of its own, and a shim that never answers ends as
 * vitest's `Test timed out` naming nobody: the WP-69 canary measured exactly that for the
 * `spawn.ok` a non-spawning shim never sends, beside a pid-file wait that named the shim.
 */
export const settlesWithin = async <T>(what: string, pending: Promise<T>): Promise<T> => {
  const budget = currentWaitBudget();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new StructuralWaitExpiredError(
            what,
            `waited for ${what}, and it did not happen within ${budget.allowedMs} ms — ` +
              `${STRUCTURAL_WAIT_SHARE * 100}% of this test's ${budget.testTimeoutMs} ms budget, ` +
              `which the "${budget.project}" project owns (vitest.config.ts)`,
          ),
        ),
      Math.max(0, budget.deadline - Date.now()),
    );
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
};

/** {@link waitUntil} for a file to exist — a socket being bound, a marker being written. */
export const waitForFile = (what: string, file: string): Promise<void> =>
  waitUntil(`${what} (${file})`, async () => (await stat(file).catch(() => null)) !== null);

/** {@link waitUntil} for the operating system to stop knowing a pid. */
export const waitForProcessGone = (pid: number, what = `process ${pid} to exit`): Promise<void> =>
  waitUntil(
    what,
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    10,
  );
