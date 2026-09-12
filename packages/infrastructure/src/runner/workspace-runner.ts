/**
 * The `ClaudeRunner` a run's **workspace** is built for — WP-15g's answer to "the runner has to be
 * built per run".
 *
 * ## Why this exists at all
 *
 * `createClaudeRunner` takes `spawnClaudeCodeProcess` as a **construction-time** dependency
 * (`claude-runner.ts`), and the transport it needs is **per run**: TD-025 §2 puts a Unix socket and
 * a token in `<ctl>/<run-id>/`, so the thing the SDK spawns through cannot be known before there is
 * a run id. `ClaudeRunner.start` is also synchronous while provisioning a workspace is not. This
 * adapter is the seam between those two facts: one object a composition root can register, which
 * builds the real runner *inside* `start` and hands back a `RunHandle` whose `outcome` resolves when
 * the run does. It is the shape WP-15a's binding loader already uses for the same reason — build the
 * adapter per call, because what it must carry is per call (Q55).
 *
 * ## Every ending frees the workspace, and "every" is enumerated
 *
 * WP-13's teardown finding is that a run container outlives anything that signals one pid, so the
 * workspace is released only if something calls `release` on **every** path. There are eight, and
 * they are the reason `release` is in a `finally` rather than after the await:
 *
 *  - the six terminal statuses of a `RunOutcome` — `completed`, `failed`, `cancelled`,
 *    `budget_exceeded`, `timed_out`, `stalled` (a `stop()` from a human ends as one of them);
 *  - the outcome promise **rejecting**, which is a runner fault rather than a run result;
 *  - `start` failing before there is a run at all — provisioning, or the runner's own spec
 *    validation.
 *
 * `workspace-runner.test.ts` drives them **one at a time** rather than asserting "release was
 * called" once, because a behaviour parameterised over a set needs a test parameterised over the
 * same set or the set is decoration (standing rule 68).
 *
 * ## What it does to the spec, and why
 *
 * `spec.workspacePath` is replaced by the provisioned `workdir`. The planner builds that field from
 * a composition root's `workspacePath(taskId)` callback, which cannot know where the container has
 * the checkout mounted (`/work/repo`, TD-021); the SDK's `cwd` has to be the path the *CLI* sees,
 * because the CLI runs inside the container. The substitution happens here, at the one place that
 * knows both, and the original value is logged so a surprised reader can see the swap.
 *
 * ## What is retryable
 *
 * A failure to *provision* is a transport failure and is worth another attempt; a spec the launcher
 * refuses is not. {@link classifyProvisionFailure} is that rule, in one place, defaulting to
 * **terminal** for anything it does not recognise — the fail-closed direction, because a failure
 * shape nobody has classified should tell a human rather than spin (Q59(a);
 * `stage-executor.ts` is what acts on it).
 */
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type {
  ClaudeRunner,
  Logger,
  RunHandle,
  RunOutcome,
  RunSpec,
  RunStopReason,
  SteerMessage,
  TerminalRunStatus,
} from '@platform/application';
import { RunStartError, silentLogger, WorkspaceError } from '@platform/application';

/** How a run ended, as the thing that frees the workspace sees it. */
export type RunWorkspaceEnding =
  /** The run produced an outcome; `status` is its terminal status. */
  | { readonly kind: 'ended'; readonly status: TerminalRunStatus }
  /** There was never a run: provisioning or `start` threw. */
  | { readonly kind: 'not_started' }
  /** The run was started and its outcome promise rejected — a fault, not a result. */
  | { readonly kind: 'crashed' };

/** A workspace a run can be executed in: where the CLI runs, how to reach it, how to give it back. */
export interface ProvisionedRunWorkspace {
  /** The `cwd` the CLI is spawned in, as the *container* sees it (`/work/repo`, TD-021). */
  readonly workdir: string;
  /** `Options.spawnClaudeCodeProcess` for this run — the runlet transport, or a test's fake CLI. */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Called exactly once, whichever way the run ended. Must tolerate being called after a failure. */
  release(ending: RunWorkspaceEnding): Promise<void>;
}

/**
 * Provisions the workspace of one run.
 *
 * Deliberately **not** in `packages/application`: its product is a `SpawnedProcess` factory, and
 * that is a type of `@anthropic-ai/claude-agent-sdk`, which the application ring may not import —
 * the same reason `WorkspaceProvider.attach` returns a `WorkspaceAttachment` instead of the SDK's
 * own type. The implementations are a launcher-side one (composed by a launcher process, which is
 * the only thing allowed to hold a Docker client — TD-021's WP-15g amendment) and the test one that
 * hands back a fake CLI.
 */
export interface RunWorkspaceProvisioner {
  provision(spec: RunSpec): Promise<ProvisionedRunWorkspace>;
}

/** What this adapter needs besides the provisioner. */
export interface WorkspaceClaudeRunnerOptions {
  readonly provisioner: RunWorkspaceProvisioner;
  /**
   * Builds the real runner for one run, over the transport the provisioner produced.
   *
   * A callback rather than a `ClaudeRunnerDependencies` object, because the composition root owns
   * what goes in one (the transcript sink, the approvals port, the platform tools, the injected
   * secret redactor) and this file must not grow a second opinion about any of them.
   */
  readonly build: (transport: {
    readonly spawn: (options: SpawnOptions) => SpawnedProcess;
    readonly workdir: string;
  }) => ClaudeRunner;
  readonly logger?: Logger;
}

/**
 * Is a provisioning failure worth another attempt?
 *
 * `WorkspaceError.code` is the only classification the platform has, and the split follows what an
 * operator would do about each: `engine_unavailable` (the daemon, or the socket proxy in front of
 * it, refused or was unreachable) and `workspace_failed` (a step of the lifecycle failed — a mirror
 * fetch, a clone, a helper container) are conditions that pass, while `invalid_spec` is a statement
 * about *this* spec and would fail identically on every attempt. `not_found` is retryable for the
 * same reason `engine_unavailable` is: the run's control directory not being there yet is what a
 * launcher that has just restarted looks like.
 *
 * Anything that is not a `WorkspaceError` is **terminal**, which is the fail-closed answer: a new
 * failure shape parks one task and tells a human, rather than retrying something nobody has looked
 * at. A provisioner may also throw a {@link RunStartError} itself, which is taken as given.
 */
export const classifyProvisionFailure = (error: unknown): { readonly retryable: boolean } => {
  if (error instanceof RunStartError) {
    return { retryable: error.retryable };
  }
  if (error instanceof WorkspaceError) {
    return {
      retryable:
        error.code === 'engine_unavailable' ||
        error.code === 'workspace_failed' ||
        error.code === 'not_found',
    };
  }
  return { retryable: false };
};

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export const createWorkspaceClaudeRunner = (
  options: WorkspaceClaudeRunnerOptions,
): ClaudeRunner => {
  const logger = options.logger ?? silentLogger;

  return {
    start: (spec: RunSpec): RunHandle => {
      /**
       * A `stop()` or `steer()` that arrives before the inner handle exists.
       *
       * It cannot be dropped: `stop` is how a human cancels or takes over a run, and provisioning a
       * workspace takes seconds during which the UI already shows a running run. It cannot be
       * applied either, because there is nothing to apply it to yet — so it is remembered and
       * applied the moment the run starts. A stop **wins over** a steer that arrived before it: the
       * run is ending, and pushing a user turn into a session that is about to be interrupted is
       * work nobody reads.
       */
      let handle: RunHandle | null = null;
      let pendingStop: RunStopReason | null = null;
      const pendingSteers: SteerMessage[] = [];

      const outcome = (async (): Promise<RunOutcome> => {
        let workspace: ProvisionedRunWorkspace;
        try {
          workspace = await options.provisioner.provision(spec);
        } catch (error) {
          const { retryable } = classifyProvisionFailure(error);
          logger.error(
            { err: error, run_id: spec.runId, stage: spec.stage, retryable },
            'the run workspace could not be provisioned',
          );
          // There is no workspace, so there is nothing to release — the provisioner owes the
          // "either it returns a handle or it leaves nothing behind" guarantee for its own partial
          // failures, which is what `LauncherService.startRun` discharges (standing rule 54).
          throw new RunStartError(
            `the run workspace could not be provisioned: ${describe(error)}`,
            {
              retryable,
              cause: error,
            },
          );
        }

        let ending: RunWorkspaceEnding = { kind: 'not_started' };
        try {
          if (workspace.workdir !== spec.workspacePath) {
            logger.debug(
              { run_id: spec.runId, planned: spec.workspacePath, workdir: workspace.workdir },
              'the run runs in the workspace’s own working directory, not the planned path',
            );
          }
          handle = options
            .build({ spawn: workspace.spawn, workdir: workspace.workdir })
            .start({ ...spec, workspacePath: workspace.workdir });
          for (const message of pendingSteers.splice(0)) {
            await handle.steer(message);
          }
          if (pendingStop !== null) {
            await handle.stop(pendingStop);
          }
          const result = await handle.outcome;
          ending = { kind: 'ended', status: result.status };
          return result;
        } catch (error) {
          // `build().start()` throwing is a fault in the composition or a spec the runner refuses:
          // terminal, because the same spec would be refused again. A rejected `outcome` is the
          // run crashing after it started.
          ending = handle === null ? { kind: 'not_started' } : { kind: 'crashed' };
          if (handle === null) {
            throw new RunStartError(`the runner refused to start this run: ${describe(error)}`, {
              retryable: false,
              cause: error,
            });
          }
          throw error;
        } finally {
          // The one line that must run on all eight paths.
          try {
            await workspace.release(ending);
          } catch (error) {
            logger.error(
              { err: error, run_id: spec.runId, ending: ending.kind },
              'the run workspace could not be released; a container may still be running',
            );
          }
        }
      })();
      // The rejection is delivered to whoever awaits `outcome` (the stage executor, inside its own
      // try/catch). Without this, a rejection that nobody has awaited *yet* — the window between
      // `start` returning and the executor's `await` — is an unhandled rejection, which in Node 24
      // terminates the process.
      outcome.catch(() => undefined);

      return {
        runId: spec.runId,
        outcome,
        steer: async (message) => {
          if (handle === null) {
            pendingSteers.push(message);
            return;
          }
          await handle.steer(message);
        },
        stop: async (reason) => {
          if (handle === null) {
            pendingStop ??= reason;
            return;
          }
          await handle.stop(reason);
        },
      };
    },
  };
};
