/**
 * The production `ClaudeRunner`, composed — WP-15g, and the thing every green result about a run in
 * this repository was missing.
 *
 * ## What was actually wrong
 *
 * WP-12 built the runner, WP-14 the launcher, WP-15a composed the pipeline, and
 * `apps/server/src/pipeline.ts` composed `unavailableClaudeRunner()`, whose `start` **throws**. So
 * the only runner any test ever drove was `FakeClaudeRunner`, which picks its scenario from
 * `spec.stage` and **never reads the prompt** (standing rule 82). This file composes the real one:
 * `createClaudeRunner` — the adapter over the SDK's own `query()` — with the four collaborators it
 * needs, three of which had no production implementation at all before this work package.
 *
 * ## TD-021 holds, and that is the reason for the shape
 *
 * *No process that composes the pipeline or serves `/webhooks/*` may construct a Docker client*
 * (TD-021's WP-15g amendment). So this file takes a {@link RunWorkspaceProvisioner} and never a
 * `WorkspaceProvider`: what a run needs from the workspace is the control channel of TD-025 §2 — a
 * socket path and a token on a volume the runner has mounted — and obtaining that touches no daemon.
 * `updateMirror`, `create`, `kill`, `export`, `destroy`, `purgeExpired` and `broker` stay on the
 * launcher side of that boundary, in the `platform-launcher` container. The check that keeps this
 * honest is `apps/launcher/src/docker-access.test.ts`, which reads the repository off disk.
 *
 * **A process with no launcher configuration composes no agent runner**, which is Q59(b)'s answer:
 * it logs which piece is missing, and still runs the status mapping, the workpad and every outbound
 * provider call. Refusing to compose the pipeline at all would be louder and would stop the part of
 * the loop that works without an agent. Since WP-53 that process also does not **subscribe**
 * `stage.execute` or `task.ask` (TD-028 decision 5), so those jobs queue rather than failing.
 *
 * That costs the platform **gates** as well, and TD-028's WP-53 amendment is where the trade is
 * written down: `ci_gate`, `rebase_gate` and `merged_gate` are a *branch of the same handler on the
 * same queue*, and the queue is not split because `stage.execute` is `stately` per task — a second
 * queue would let a gate and a stage for one task run at once.
 *
 * The provisioner is no longer absent in a shipped instance: `compose.yml`'s `runner` service is
 * the same image with `APP_LAUNCHER_URL`, `APP_LAUNCHER_TOKEN` and the `ctl` mount, and
 * `apps/server/src/workspaces.ts` composes `createLauncherRunWorkspaceProvisioner` from them.
 *
 * ## The three collaborators that did not exist
 *
 *  - **The transcript sink.** `run_messages` has existed since WP-06 and nothing wrote a row;
 *    `createPostgresTranscriptSink` is the writer (and migration `0016` is what writing found).
 *  - **The approvals port.** {@link unattendedToolApprovals} *denies*, which is BD-025's stated
 *    default for an unattended run, and says so in the reason the model is shown. It is a refusal and
 *    not a null object: an `allow` would let the ask-list through silently, which is the fail-open
 *    direction, and a `throw` would break the port's contract ("it never throws to mean no").
 *  - **The injected-secret redactor.** TD-012 step 1 for *this run*: the values behind
 *    `RunSpec.secretEnvNames`, built per run, so the model credential the CLI is given cannot appear
 *    in a transcript row, an error or a stored artifact. The runner composes the pattern rules (step
 *    2) after it — and since WP-52 round 2 **so does the artifact write**, which had step 1 alone
 *    while the transcript of the same model message had both (`StageExecutorOptions.redactor`).
 */
import type {
  Broadcast,
  ClaudeRunner,
  Logger,
  PlatformToolPort,
  ToolApprovalPort,
} from '@platform/application';
import {
  injectedSecretRedactorFor,
  injectedSecretRedactorForEnvironment,
  RUN_TRANSCRIPT_TOPIC,
} from '@platform/application';
import { runner as runnerAdapters } from '@platform/infrastructure';
import type pg from 'pg';

/**
 * BD-025's unattended default: **deny**, with a reason the model can act on.
 *
 * technical/05 § "Command and tool policy" ends an `ask` decision with "timeout = question timeout;
 * unattended default deny", and this build has nowhere to ask: the Question aggregate has no HTTP
 * surface bound to a live run and nothing waits for an answer (`platform-tools.ts` lists the same
 * gap for `ask_human`). So every escalation is denied immediately rather than after the run has spent
 * its question timeout waiting for a human who cannot be reached — the same answer, hours earlier.
 *
 * It does **not** throw. The port's docblock is explicit: an implementation that cannot reach a human
 * resolves `deny`; it never throws to mean "no". A throw from `canUseTool` would end the run instead
 * of the tool call.
 */
export const unattendedToolApprovals = (logger: Logger): ToolApprovalPort => ({
  requestApproval: async (request) => {
    logger.warn(
      {
        run_id: request.runId,
        task_id: request.taskId,
        tool: request.toolName,
        reason: request.reason,
      },
      'a run asked for approval and this build cannot ask a human, so it was denied (BD-025 unattended default deny)',
    );
    return {
      decision: 'deny',
      reason:
        'this instance cannot ask a human for approval yet (no Question surface is bound to a live run), so an `ask` decision is denied. Do the work another way, or report in your artifact that you needed approval.',
      questionId: null,
    };
  },
});

/**
 * TD-012 step 1 for one run, and for the environment a run *would* be given.
 *
 * **Both are re-exports since WP-52**, not definitions. The construction moved to
 * `packages/application/src/pipeline/run-redaction.ts` because the artifact write and the two
 * prompt columns are written by the stage executor and the ask executor, which are in that ring and
 * cannot import a composition root — and a second construction there would have made "the artifact
 * and the transcript of the run that produced it cannot name different secrets" a claim about two
 * pieces of code agreeing (standing rule 63). `agent.test.ts` asserts the identity, so the
 * indirection cannot become a copy.
 */
export { injectedSecretRedactorFor, injectedSecretRedactorForEnvironment };

export interface AgentRunnerOptions {
  readonly pool: pg.Pool;
  /**
   * Where the transcript sink announces each stored entry's position (WP-15h).
   *
   * A hint, never content: `apps/server/src/sse/transcript-bridge.ts` reads the rows back for the
   * connections it holds, which is what lets the process serving the stream be a different one
   * from the process that ran the agent.
   */
  readonly broadcast: Broadcast;
  /** Absent means "this process runs no agent" — the Q59(b) default. */
  readonly provisioner: runnerAdapters.RunWorkspaceProvisioner | undefined;
  /** The nine in-process MCP tools this process composed (`platform-tools.ts`). */
  readonly tools: PlatformToolPort;
  /**
   * BD-004's two modes, and what each one authenticates a run with.
   *
   * *"`local` runs the operator's own binary"* is how this line read until WP-53 and it has not
   * been true since WP-22: `compose.local.yml` says *"the CLI does not run in this container: it
   * runs in the per-run `platform-runtime` container"*, so both modes run the **same pinned
   * binary** in the run image and differ only in the credential — `ANTHROPIC_API_KEY` for `api`,
   * `CLAUDE_CODE_OAUTH_TOKEN` (a Claude Code subscription) for `local`.
   */
  readonly providerMode: 'api' | 'local';
  readonly modelApiKey: string | null;
  /** `CLAUDE_CODE_OAUTH_TOKEN` — `local` mode's credential (PROGRESS backlog 128). */
  readonly modelOauthToken?: string | null;
  readonly logger: Logger;
}

/** What a process is missing when it composes no agent runner, in the order it should be fixed. */
export interface AgentRunnerRefusal {
  readonly runner: null;
  readonly missing: readonly string[];
}

export type ComposedAgentRunner = { readonly runner: ClaudeRunner } | AgentRunnerRefusal;

/**
 * Composes the agent runner, or explains why it did not.
 *
 * Two conditions, and both are *configuration* rather than build state: a workspace provisioner
 * (which needs `APP_LAUNCHER_URL` and `APP_LAUNCHER_TOKEN` — TD-028's control plane, built at
 * WP-53), and the provider mode's own model credential. Each absence is returned by name so the
 * composition root can log it, which is the shape `startRuntime` already uses for the runner and the
 * audit log.
 */
export const composeAgentRunner = (options: AgentRunnerOptions): ComposedAgentRunner => {
  const missing: string[] = [];
  if (options.provisioner === undefined) {
    missing.push(
      "a run workspace provisioner (set APP_LAUNCHER_URL and APP_LAUNCHER_TOKEN to reach the platform-launcher container over TD-028's control plane; TD-021 forbids this process from holding a Docker client of its own)",
    );
  }
  if (options.providerMode === 'api' && options.modelApiKey === null) {
    missing.push('ANTHROPIC_API_KEY (APP_PROVIDER_MODE=api needs a model credential)');
  }
  if (options.providerMode === 'local' && (options.modelOauthToken ?? null) === null) {
    missing.push(
      'CLAUDE_CODE_OAUTH_TOKEN (APP_PROVIDER_MODE=local runs the pinned CLI in the run container and it authenticates with a Claude Code subscription token)',
    );
  }
  if (options.provisioner === undefined || missing.length > 0) {
    return { runner: null, missing };
  }

  const sink = runnerAdapters.createPostgresTranscriptSink({
    sql: options.pool,
    logger: options.logger,
    // TD-007's second destination, as a hint (WP-15h). `publish` is outside any transaction and
    // runs after the insert has returned, so the row is committed before anybody is told about it.
    announce: async (hint) =>
      options.broadcast.publish({ topic: RUN_TRANSCRIPT_TOPIC, payload: hint }),
  });
  const approvals = unattendedToolApprovals(options.logger);
  const provisioner = options.provisioner;
  return {
    runner: runnerAdapters.createWorkspaceClaudeRunner({
      provisioner,
      logger: options.logger,
      build: ({ spawn }) =>
        runnerAdapters.createClaudeRunner({
          sink,
          approvals,
          tools: options.tools,
          clock: runnerAdapters.systemClock,
          logger: options.logger,
          injectedSecretRedactorFor: (spec) => injectedSecretRedactorFor(spec, options.logger),
          spawnClaudeCodeProcess: spawn,
        }),
    }),
  };
};

/**
 * The run environment a spec carries — TD-021 phase 1's "the model credential is in env,
 * documented", and **the one place that decides what a run container is given**.
 *
 * Returned as the pair the planner needs (`env` and `secretEnvNames`) so the two cannot drift: a key
 * in `env` that is not named in `secretEnvNames` is a credential no redactor knows about, which is
 * the defect TD-012 step 1 exists to prevent.
 *
 * ## `local` mode used to be given nothing at all, and a test pinned it (PROGRESS backlog **128**)
 *
 * This function returned `{ env: {}, secretEnvNames: [] }` for anything that was not `api` mode,
 * and `agent.test.ts` asserted it by name. So BD-004's `local` mode — which Q14 records as
 * *"first-class"* and which `compose.local.yml` makes compose refuse to resolve without
 * `CLAUDE_CODE_OAUTH_TOKEN` — started a run container with **no credential of any kind**, while
 * *no server source read that variable*. It was latent only because nothing composed a workspace
 * provisioner; WP-53 is the row that does.
 *
 * The answer is (1) of the entry's two, and it is a measurement rather than a preference: against
 * `platform-runtime:dev` (`claude` 2.1.267) the pinned CLI reads `CLAUDE_CODE_OAUTH_TOKEN` from
 * its process environment and authenticates with it — *"401 OAuth access token is invalid"* for a
 * bogus one, against *"Not logged in · Please run /login"* for none. One name, in the one place,
 * with the name in `secretEnvNames`.
 */
export const agentRunEnvironment = (
  options: Pick<AgentRunnerOptions, 'providerMode' | 'modelApiKey' | 'modelOauthToken'>,
): { readonly env: Record<string, string>; readonly secretEnvNames: string[] } => {
  if (options.providerMode === 'local') {
    const token = options.modelOauthToken ?? null;
    // Absent is an empty environment and **not** an error here: this function has no way to fail,
    // and the refusal that matters already exists one level up — `composeAgentRunner` names the
    // missing credential and composes no runner at all.
    return token === null
      ? { env: {}, secretEnvNames: [] }
      : { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, secretEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'] };
  }
  if (options.modelApiKey === null) {
    return { env: {}, secretEnvNames: [] };
  }
  return {
    env: { ANTHROPIC_API_KEY: options.modelApiKey },
    secretEnvNames: ['ANTHROPIC_API_KEY'],
  };
};
