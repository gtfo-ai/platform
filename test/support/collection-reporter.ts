/**
 * The vitest reporter half of the collection bound (WP-213, PROGRESS backlog 597):
 * `scripts/vitest-bounded.mjs` starts vitest with an IPC channel and this reporter, and the reporter
 * tells it, per test file, when collection **began** and when it **ended** — and, at most once a
 * second, that the run is still doing something.
 *
 * Which hook means which was measured on vitest 5.0.0, not read: `onTestModuleQueued` fires when a
 * worker takes the file (with two workers, two files are queued at once and the third only after
 * one ends), and `onTestModuleCollected` once its top level and its `describe` bodies have run. A
 * file queued and never collected is therefore the file being collected — the stall 597 saw, where
 * a `describe` body looped — whereas the last file *collected* is some other, healthy file.
 *
 * **A worker that dies while collecting** also leaves its file queued and never collected, and
 * vitest records that crash only when its whole run ends (measured: the `Worker exited
 * unexpectedly` error reached `state.catchError` 4 s after the crash, as the last file finished).
 * No hook reaches the crashed file sooner, so the activity message is what tells the two apart: a
 * crashed file is left behind by a run that goes on, a stalled one by a run that has nothing left
 * to do (review round 1).
 *
 * With no channel (a vitest started by anything else) it sends nothing.
 */
import process from 'node:process';
import type { Reporter, TestModule } from 'vitest/node';

export type CollectionEvent = 'queued' | 'collected';

export type CollectionMessage =
  | {
      readonly event: CollectionEvent;
      readonly project: string;
      /** Relative to the project's root, which is how the stall is named. */
      readonly file: string;
    }
  | { readonly event: 'activity' };

const ACTIVITY_INTERVAL_MS = 1_000;

const send = (message: CollectionMessage): void => {
  process.send?.(message);
};

const module = (event: CollectionEvent, testModule: TestModule): CollectionMessage => ({
  event,
  project: testModule.project.name,
  file: testModule.relativeModuleId,
});

export default class CollectionReporter implements Reporter {
  private lastActivity = 0;

  onInit(): void {
    // The channel must not keep vitest alive once its run has ended.
    process.channel?.unref();
  }

  onTestModuleQueued(testModule: TestModule): void {
    send(module('queued', testModule));
  }

  onTestModuleCollected(testModule: TestModule): void {
    send(module('collected', testModule));
  }

  onTestModuleEnd(): void {
    this.activity();
  }

  onTestCaseReady(): void {
    this.activity();
  }

  onTestCaseResult(): void {
    this.activity();
  }

  onHookStart(): void {
    this.activity();
  }

  onHookEnd(): void {
    this.activity();
  }

  private activity(): void {
    const now = Date.now();
    if (now - this.lastActivity >= ACTIVITY_INTERVAL_MS) {
      this.lastActivity = now;
      send({ event: 'activity' });
    }
  }
}
