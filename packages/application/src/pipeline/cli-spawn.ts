/**
 * The CLI spawn marker — the one record that tells a run that **may have reached the model** from a
 * run that cannot have (WP-150, BD-010's 2026-10-06 amendment, PROGRESS backlogs 410 and 489).
 *
 * ## Why it exists
 *
 * WP-131 holds an ended run nobody measured at the reservation it was admitted at, because nothing
 * on the row could prove the run had not spent: a run cancelled during provisioning and a run whose
 * CLI crashed mid-turn both ended with two null cost columns. On the first local test that hold
 * paused AUT-6820 for a run its shim had refused at the handshake — recorded as a `crash` and held
 * at the implementation cap of 40 USD for money that could not have been spent.
 *
 * The handshake is where the proof can live: the shim answers `hello.ok` before the runner sends the
 * `spawn` frame (TD-025), so the process holding the run writes `runs.cli_spawn_requested_at` in a
 * transaction of its own, **commits it**, and only then asks for the CLI. Its write is a
 * compare-and-set (`RunRepository.markCliSpawnRequested`): only where the column is null and the run
 * is still live, so a cancel or a sweep that ended the row first wins, and the late process starts
 * nothing. The rule this buys, in one line:
 *
 * > **No CLI without the marker** — so a run whose marker is null is a **measured zero**.
 *
 * Its ending writes the zero a start failure writes ({@link MEASURED_ZERO_COST}), and every cap's
 * held set excludes it (`packages/infrastructure/src/cost/pending-run-spend.ts`). A run **with** the
 * marker and no figure keeps WP-131's hold, unchanged.
 *
 * ## What it does not prove
 *
 * That the CLI **did** start: the marker is written before the `spawn` frame, so a run whose spawn
 * the shim then refused is held like any run that may have spent. That is the fail-closed side of
 * the window (standing rule 20), and it is one frame wide.
 */
import type { Id, IsoDateTime, RunCost, TokenUsage } from '@platform/contracts';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { type RunOutcome, RunStartError, type RunStartHooks } from '../ports/runner.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { RunRepository } from './store.js';

/** Nothing was spent, because nothing ran. Written out so no caller invents a different zero. */
export const NO_RUN_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 0,
};

/**
 * The cost of a run that never reached its CLI: `is_estimate: false`, because "nothing" is a
 * measurement, not a guess (BD-011). It lands in `runs.usd_reported`, so no cap holds the run.
 */
export const MEASURED_ZERO_COST: RunCost = { usd: 0, is_estimate: false, price_list_id: null };

/** What a caller lends the runner, and what it learns back. */
export interface CliSpawnRecord {
  /** Handed to `ClaudeRunner.start`. */
  readonly hooks: RunStartHooks;
  /** `true` once this record's own write committed — the CLI may then have been started. */
  readonly requested: () => boolean;
}

/**
 * The marker's writer for one run, as the process holding it composes it.
 *
 * The write is its **own** transaction — not the run row's first transaction, which committed
 * before the workspace was provisioned, and not the ending's, which is too late — so the marker is
 * durable the moment the hook answers `true`. A second call answers `false` without writing: the
 * runner asks once, and a runner that asked twice must not start two CLIs.
 */
export const recordCliSpawn = (deps: {
  readonly unitOfWork: UnitOfWork;
  readonly runs: Pick<RunRepository, 'markCliSpawnRequested'>;
  readonly now: () => IsoDateTime;
  readonly runId: Id;
  readonly logger?: Logger;
}): CliSpawnRecord => {
  const logger = deps.logger ?? silentLogger;
  let asked = false;
  let written = false;
  return {
    hooks: {
      beforeCliSpawn: async () => {
        if (asked) {
          logger.warn({ run_id: deps.runId }, 'a runner asked twice to start one run’s CLI');
          return false;
        }
        asked = true;
        written = await deps.unitOfWork.transaction(async (scope) =>
          deps.runs.markCliSpawnRequested(scope.tx, { runId: deps.runId, at: deps.now() }),
        );
        if (!written) {
          logger.warn(
            { run_id: deps.runId },
            'the run had already ended when its CLI was about to start; no CLI is started',
          );
        }
        return written;
      },
    },
    requested: () => written,
  };
};

/**
 * A stop's ending — a person's cancel or take-over (`cancelled`) or the runner's own hand-back
 * (`shutdown`) — which keeps its status when it lands before the marker: the person's decision is
 * the record, and only its money changes.
 */
export const isStopEnding = (outcome: RunOutcome): boolean =>
  outcome.status === 'cancelled' || outcome.terminalReason === 'shutdown';

/**
 * A stop that landed **before** the CLI was asked for, as a measured zero: no usage, no turns, the
 * start failure's zero, and not `costUnmeasured` — nothing could have been spent.
 */
export const unspawnedStop = (outcome: RunOutcome): RunOutcome => {
  const { costUnmeasured: _unmeasured, ...rest } = outcome;
  return {
    ...rest,
    numTurns: 0,
    usage: NO_RUN_USAGE,
    modelUsage: [],
    cost: MEASURED_ZERO_COST,
  };
};

/**
 * Why an ending that was not a stop is recorded as a start failure when it came back with no marker
 * (ruling (d)): a runner that reported a `crash`, a stall or anything else before it asked for the
 * CLI did not run one, so the honest record is *not started*, never `crash`. Terminal: nothing
 * known about it says another attempt would differ.
 */
export const cliSpawnNotRequested = (outcome: RunOutcome): RunStartError =>
  new RunStartError(
    `the session ended (${outcome.status}, ${outcome.terminalReason}) before its CLI was asked to start`,
    {
      retryable: false,
      diagnosis: { kind: 'workspace_failed', reason: 'cli_spawn_not_requested', commit: null },
    },
  );
