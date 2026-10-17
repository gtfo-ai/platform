/**
 * `RunStartHooks` for a test whose subject is not the CLI spawn marker (WP-150).
 *
 * Every shipped runner asks `beforeCliSpawn` before it starts a CLI and starts none when it answers
 * `false`, so a test that drives a runner directly has to answer it. This one answers `answer`
 * (default `true`, the marker written) and counts the asks, so a case can still assert that the
 * runner asked — once — or did not.
 */
import type { RunStartHooks } from '../ports/runner.js';

export interface CountingStartHooks extends RunStartHooks {
  /** How many times the runner asked. */
  readonly asks: () => number;
  /** How many times the runner said the frame was withheld after a written marker (WP-163). */
  readonly withholds: () => number;
}

export const countingStartHooks = (answer: boolean | (() => Promise<boolean>) = true) => {
  let asked = 0;
  let withheld = 0;
  const hooks: CountingStartHooks = {
    beforeCliSpawn: async () => {
      asked += 1;
      return typeof answer === 'function' ? answer() : answer;
    },
    cliSpawnWithheld: () => {
      withheld += 1;
    },
    asks: () => asked,
    withholds: () => withheld,
  };
  return hooks;
};
