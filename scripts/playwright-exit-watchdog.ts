/**
 * A Playwright reporter that ends a run which has reported but not exited, naming what holds it
 * (WP-126, PROGRESS backlog 401).
 *
 * **What it is for.** CI's `web e2e (playwright)` job once printed `51 passed (45.0s)` and then
 * nothing for 31 minutes, until it was cancelled (`ci` `36952588895`, attempt 1); the rerun passed
 * in 1 m 23 s, and locally the target has always exited. The job log shows where it stopped:
 * `PASS: verify:web-e2e` — which `scripts/verify.mjs` prints when its child exits — never
 * appeared, and the runner's orphan sweep then terminated the `playwright test` process itself,
 * so the process that did not exit was Playwright's runner, after the list reporter's summary.
 * By then the `webServer` teardown has already run (Playwright tears its plugins down before it
 * calls `onEnd`), so what is left is the other reporters' `onEnd`/`onExit` — the HTML report on
 * CI — and the flush before Playwright's own bounded exit. **The handle that held it is not
 * known**: it was not reproduced (the target exited every local run) and the job printed nothing
 * after the summary. This reporter is the ruling's second branch: the next time it happens, the
 * run ends here and the log carries the open handles, which is the measurement the first hang
 * did not leave.
 *
 * **How.** It is listed after `list` and before `html` (`playwright.config.ts`), so its `onEnd`
 * runs once the summary is printed and before anything else that could wait. It arms one
 * **ref'd** timer: Playwright ends a healthy run with an explicit `process.exit` (its CLI calls
 * `gracefullyProcessExitDoNotHang`, which itself gives up after 30 s), so the timer never fires on
 * a run that ends; and being ref'd, it also covers the other shape of a stuck run — an awaited
 * promise with nothing behind it, where an empty loop would otherwise let Node exit with status 0
 * and a failed run read as green.
 *
 * **It fails the run** (exit 1) even when every test passed: a run that did not end is not a
 * verified run, and a red job with the handles named is what lets the next reader close the
 * defect instead of re-running it away (standing rule 84). The six-hour hold is also bounded one
 * level up, by the job's `timeout-minutes` (`.github/workflows/ci.yml`).
 */
import process from 'node:process';
import type { FullResult, Reporter } from '@playwright/test/reporter';

/**
 * How long after the summary a run may still be alive.
 *
 * Measured locally with `CI=true` (WP-126, at a one-minute load of 7–10): from the summary line to
 * the next line printed after the process ended, 39 ms for the whole passing suite and 27 ms for
 * a failing test whose trace the HTML report copied; two of the CI job's healthy runs read 77 ms and
 * 95 ms the same way (summary to `PASS: verify:web-e2e`). Playwright's own exit gives its browsers up to 30 s on top. Ninety seconds is past all
 * of it with room, and an order of magnitude below the job's bound.
 */
export const EXIT_GRACE_MS = 90_000;

/** What the reporter touches outside itself, so a test can drive it without ending its own process. */
export interface WatchdogHost {
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly write: (text: string) => void;
  readonly exit: (code: number) => void;
  /** One line per open resource, as specific as the runtime allows. */
  readonly openHandles: () => readonly string[];
}

interface HandleLike {
  readonly constructor?: { readonly name?: string };
  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly localPort?: number;
  readonly pid?: number;
  readonly spawnargs?: readonly string[];
  readonly address?: () => unknown;
  readonly fd?: number;
}

/**
 * A handle as a line: a socket by its endpoints, a child by its pid and command, a server by the
 * address it listens on, anything else by its type.
 */
export const describeHandle = (handle: HandleLike): string => {
  const type = handle.constructor?.name ?? typeof handle;
  if (typeof handle.pid === 'number') {
    return `${type} pid ${handle.pid}: ${(handle.spawnargs ?? []).join(' ').slice(0, 200)}`;
  }
  if (handle.remoteAddress !== undefined) {
    return `${type} ${handle.localPort ?? '?'} -> ${handle.remoteAddress}:${handle.remotePort ?? '?'}`;
  }
  // Before the address: a stdio pipe is a `Socket` whose `address()` is `{}` (measured).
  if (typeof handle.fd === 'number') return `${type} fd ${handle.fd}`;
  if (typeof handle.address === 'function') {
    let address: unknown;
    try {
      address = handle.address();
    } catch {
      address = undefined;
    }
    if (typeof address === 'string' || (address !== null && typeof address === 'object')) {
      const text = JSON.stringify(address);
      if (text !== '{}') return `${type} listening on ${text}`;
    }
  }
  return type;
};

/**
 * The process's open resources: the documented summary (`getActiveResourcesInfo`, type names and
 * counts) plus, where the runtime still has it, the handles themselves — `_getActiveHandles` is
 * undocumented, so its absence is tolerated and said.
 */
export const processOpenHandles = (): string[] => {
  const counts = new Map<string, number>();
  for (const type of process.getActiveResourcesInfo()) {
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const summary = `resources: ${[...counts].map(([type, count]) => `${type} ×${count}`).join(', ')}`;
  const internal = (process as unknown as { _getActiveHandles?: () => HandleLike[] })
    ._getActiveHandles;
  if (typeof internal !== 'function') {
    return [summary, '(this Node has no _getActiveHandles; only the summary is known)'];
  }
  return [summary, ...internal.call(process).map(describeHandle)];
};

const processHost: WatchdogHost = {
  setTimer: (callback, ms) => setTimeout(callback, ms),
  write: (text) => {
    process.stderr.write(text);
  },
  exit: (code) => {
    process.exit(code);
  },
  openHandles: processOpenHandles,
};

export default class ExitWatchdog implements Reporter {
  readonly #graceMs: number;
  readonly #host: WatchdogHost;

  constructor(options: { graceMs?: number; host?: WatchdogHost } = {}) {
    this.#graceMs = options.graceMs ?? EXIT_GRACE_MS;
    this.#host = options.host ?? processHost;
  }

  printsToStdio(): boolean {
    return false;
  }

  onEnd(result: FullResult): void {
    const endedAt = new Date().toISOString();
    this.#host.setTimer(() => {
      const lines = this.#host.openHandles().map((line) => `  ${line}`);
      this.#host.write(
        `FAIL: playwright-exit-watchdog — the run ended (${result.status}) at ${endedAt} and the ` +
          `process was still alive ${this.#graceMs / 1000} s later. Open handles:\n` +
          `${lines.join('\n')}\n`,
      );
      this.#host.exit(1);
    }, this.#graceMs);
  }
}
