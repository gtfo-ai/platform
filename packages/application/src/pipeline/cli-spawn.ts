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
 * marker and no figure keeps WP-131's hold, unchanged — unless its frame was withheld (below).
 *
 * ## When the frame is withheld after the marker (WP-163, BD-010's 2026-10-08 amendment)
 *
 * The marker commits **before** the frame, so a stop, a kill or a lost connection can land while
 * it commits, and the run shim's adapter then sends no `spawn` frame (PROGRESS backlog 501). The
 * adapter knows that exactly and says so through `RunStartHooks.cliSpawnWithheld`; the record keeps
 * it as the **withheld** fact, and the executors read one predicate, {@link
 * CliSpawnRecord.mayHaveReachedCli} — *written and not withheld* — so such a run ends as an
 * unspawned one: a stop through {@link unspawnedStop} with the step `spawn_withheld`, anything else
 * a start failure (`ended_before_cli_spawn`), both at {@link MEASURED_ZERO_COST}. **The marker is
 * not cleared**: `runs.cli_spawn_requested_at` stays the true record that the platform asked, and
 * the run's `exit_detail` says the frame was withheld.
 *
 * ## What it does not prove
 *
 * That the CLI **did** start: the marker is written before the `spawn` frame, so a run whose spawn
 * the shim then refused is held like any run that may have spent. That is the fail-closed side of
 * the window (standing rule 20), and it is one frame wide. Nor does a withheld frame survive the
 * process that withheld it: WP-163 (d)'s residual, stated at {@link recordCliSpawn}.
 */
import type { Id, IsoDateTime, RunCost, RunStartFailure, TokenUsage } from '@platform/contracts';
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
  /**
   * `true` once this record's own write committed **and** the runner did not then withhold the
   * `spawn` frame (WP-163): the run **may have reached its CLI**, so a run that ended with no figure
   * is held at its reservation. `false` is a measured zero.
   */
  readonly mayHaveReachedCli: () => boolean;
  /** `true` when the marker was written and the runner then withheld the frame (WP-163). */
  readonly withheld: () => boolean;
  /**
   * `true` once the runner reached the spawn gate and asked — whether or not the write committed.
   * It tells a stop that landed while the workspace and the shim were still being prepared from one
   * that landed at the marker itself (WP-154 (b′), {@link stoppedBeforeCliSpawn}).
   */
  readonly asked: () => boolean;
}

/**
 * The marker's writer for one run, as the process holding it composes it.
 *
 * The write is its **own** transaction — not the run row's first transaction, which committed
 * before the workspace was provisioned, and not the ending's, which is too late — so the marker is
 * durable the moment the hook answers `true`. A second call answers `false` without writing: the
 * runner asks once, and a runner that asked twice must not start two CLIs.
 *
 * Residual (WP-163 (d)): `cliSpawnWithheld` is recorded in this process's memory only, so a process
 * that dies after the marker committed and before the run's ending was recorded leaves a marked,
 * unmeasured run that the lease sweep ends held — fail-closed, and as wide as the marker's commit
 * plus the ending's transaction.
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
  let withheld = false;
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
      cliSpawnWithheld: () => {
        withheld = true;
      },
    },
    mayHaveReachedCli: () => written && !withheld,
    withheld: () => written && withheld,
    asked: () => asked,
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
export const unspawnedStop = (outcome: RunOutcome, startFailure?: RunStartFailure): RunOutcome => {
  const { costUnmeasured: _unmeasured, ...rest } = outcome;
  return {
    ...rest,
    numTurns: 0,
    usage: NO_RUN_USAGE,
    modelUsage: [],
    cost: MEASURED_ZERO_COST,
    ...(startFailure === undefined ? {} : { startFailure }),
  };
};

/**
 * How far a stopped run got before its CLI was asked for (WP-154 (b′), PROGRESS backlog 502).
 *
 * - `unheld` — no process held a live lease on the run, so the cancel ended the row **in place**
 *   (`endRunRecordInPlace`) and nothing was asked of a workspace on its behalf after that;
 * - `preparing` — the process holding the run applied the stop while its workspace and run shim
 *   were still being prepared, before the runner reached the spawn gate;
 * - `spawn_gate` — the runner had reached the spawn gate and the marker was not written;
 * - `spawn_withheld` — the marker was written and the runner then withheld the `spawn` frame
 *   (WP-163): the stop landed while the marker committed.
 */
export type UnspawnedStopStep = 'unheld' | 'preparing' | 'spawn_gate' | 'spawn_withheld';

const STOP_ENDING_WORDS = {
  cancelled: 'cancelled by a person',
  shutdown: "handed back when the platform's runner stopped",
} as const;

const STOP_STEP_WORDS: Readonly<Record<UnspawnedStopStep, string>> = {
  unheld: 'no process was holding the run, so it was ended as a record',
  preparing: 'while its workspace and run shim were being prepared',
  spawn_gate: 'at the CLI spawn marker, which was not written',
  spawn_withheld: 'the CLI spawn marker was written and the spawn frame was then withheld',
};

/** The step a stop that never reached its CLI had reached, read off its record. */
export const unspawnedStepOf = (spawn: CliSpawnRecord): UnspawnedStopStep =>
  spawn.withheld() ? 'spawn_withheld' : spawn.asked() ? 'spawn_gate' : 'preparing';

/**
 * The cause a stop that landed **before** the CLI spawn marker records — on `runs.exit_detail`
 * and on its terminal event's `start_failure` — so the run page can say *did not start* and the
 * event log can tell this run from one that started and was stopped (WP-154 (b′)).
 *
 * Platform text only, from two closed tables: who ended it and the step it had reached. **Never a
 * `workspace_failed` word** (`describeStartFailure`'s vocabulary): a person's cancel is not a
 * workspace failure, and the run's status (`cancelled`) still says who ended it — the architect's
 * amendment to WP-150's ruling (d). `detail` is `null`: no launcher said anything.
 */
export const stoppedBeforeCliSpawn = (input: {
  readonly ending: keyof typeof STOP_ENDING_WORDS;
  readonly step: UnspawnedStopStep;
  /** The stage's start attempt, or 1 where the caller cannot know it (an in-place cancel, an ask). */
  readonly attempt: number;
  /** `true` only for a hand-back the stage was re-enqueued after. */
  readonly retryable: boolean;
}): RunStartFailure => ({
  kind: 'not_started',
  diagnosis: `${STOP_ENDING_WORDS[input.ending]} before its CLI was asked to start: ${STOP_STEP_WORDS[input.step]}`,
  detail: null,
  truncated: false,
  attempt: input.attempt,
  retryable: input.retryable,
});

/** Which of {@link stoppedBeforeCliSpawn}'s endings a stop outcome is. */
export const stopEndingOf = (outcome: RunOutcome): 'cancelled' | 'shutdown' =>
  outcome.terminalReason === 'shutdown' ? 'shutdown' : 'cancelled';

/**
 * Why an ending that was not a stop is recorded as a start failure when it came back with no marker
 * (ruling (d)): a runner that reported a `crash`, a stall or anything else before it asked for the
 * CLI did not run one, so the honest record is *not started*, never `crash`. Terminal: nothing
 * known about it says another attempt would differ.
 *
 * A record whose frame was **withheld** after the marker (WP-163 (c)) is the same ending with the
 * reason `ended_before_cli_spawn`: the platform asked, and no CLI was started.
 */
export const cliSpawnNotRequested = (outcome: RunOutcome, spawn: CliSpawnRecord): RunStartError =>
  spawn.withheld()
    ? new RunStartError(
        `the session ended (${outcome.status}, ${outcome.terminalReason}) after its CLI spawn marker was written and before the spawn frame was sent`,
        {
          retryable: false,
          diagnosis: { kind: 'workspace_failed', reason: 'ended_before_cli_spawn', commit: null },
        },
      )
    : new RunStartError(
        `the session ended (${outcome.status}, ${outcome.terminalReason}) before its CLI was asked to start`,
        {
          retryable: false,
          diagnosis: { kind: 'workspace_failed', reason: 'cli_spawn_not_requested', commit: null },
        },
      );
