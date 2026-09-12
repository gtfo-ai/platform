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
 * **The provisioner is absent by default**, which is Q59(b)'s answer: a process with no launcher
 * configuration composes no agent runner, logs which piece is missing, and still runs the gates, the
 * status mapping, the workpad and every outbound provider call. Refusing to compose the pipeline at
 * all would be louder and would stop the part of the loop that works without an agent.
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
 *    2) after it.
 */
import type {
  Broadcast,
  ClaudeRunner,
  Logger,
  PlatformToolPort,
  RunSpec,
  SecretRedactor,
  ToolApprovalPort,
} from '@platform/application';
import {
  exactSecretRedactor,
  MIN_SECRET_LENGTH,
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
 * TD-012 step 1 for one run: exact match of every secret the platform injected into it.
 *
 * Built from the spec rather than from configuration, because the spec is what the CLI was actually
 * given: a value that is not in `env` cannot leak through this run, and a value that *is* must be
 * redacted whatever put it there. A name whose value is missing or too short to redact safely is
 * **skipped with a warning** rather than failing the run — `exactSecretRedactor` refuses a value
 * under {@link MIN_SECRET_LENGTH} because redacting it would erase ordinary text, and the fail-closed
 * answer to "this run has an 8-character credential" is a warning about the credential, not a run
 * that cannot start.
 */
export const injectedSecretRedactorFor = (spec: RunSpec, logger: Logger): SecretRedactor =>
  injectedSecretRedactorForEnvironment(
    { env: spec.env, secretEnvNames: spec.secretEnvNames },
    logger,
    { runId: spec.runId },
  );

/**
 * The same redactor, built from the environment a run *would* be given rather than from one run.
 *
 * Its second caller is the Librarian (WP-18b): a proposal's text is model output on its way to a
 * `kb_proposals` row and to a commit on the project's repository, and the model that wrote it was
 * handed this process' own model credential. The run-scoped redactor lives inside the runner and is
 * gone by the time a proposal is curated, so the composition root builds the same set of secrets
 * from `agentRunEnvironment` — the one function that decides what a run's environment contains, so
 * the two cannot name different values.
 */
export const injectedSecretRedactorForEnvironment = (
  environment: {
    readonly env: Readonly<Record<string, string>>;
    readonly secretEnvNames: readonly string[];
  },
  logger: Logger,
  context: { readonly runId?: string } = {},
): SecretRedactor => {
  const secrets = environment.secretEnvNames.flatMap((name) => {
    const value = environment.env[name];
    if (value === undefined || value.length < MIN_SECRET_LENGTH) {
      logger.warn(
        {
          ...(context.runId === undefined ? {} : { run_id: context.runId }),
          env_name: name,
          present: value !== undefined,
        },
        'a run names a secret environment variable that cannot be redacted, so its value is not replaced in this run’s transcript',
      );
      return [];
    }
    // The placeholder is the variable's own name, lower-cased: it is stable, unique inside one spec
    // (env names are unique by construction), and readable in an audit row as
    // `[REDACTED:integration:anthropic_api_key]`.
    return [{ name: name.toLowerCase(), value }];
  });
  return exactSecretRedactor(secrets);
};

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
  /** `api` needs a model credential; `local` runs the operator's own binary (BD-004). */
  readonly providerMode: 'api' | 'local';
  readonly modelApiKey: string | null;
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
 * (which needs a launcher this build has no transport to — Q52), and, in `api` provider mode, a model
 * credential. Each absence is returned by name so the composition root can log it, which is the shape
 * `startRuntime` already uses for the runner and the audit log.
 */
export const composeAgentRunner = (options: AgentRunnerOptions): ComposedAgentRunner => {
  const missing: string[] = [];
  if (options.provisioner === undefined) {
    missing.push(
      'a run workspace provisioner (Q52: this build has no transport to the platform-launcher container, and TD-021 forbids this process from holding a Docker client)',
    );
  }
  if (options.providerMode === 'api' && options.modelApiKey === null) {
    missing.push('ANTHROPIC_API_KEY (APP_PROVIDER_MODE=api needs a model credential)');
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
 * The run environment a spec carries in `api` mode — TD-021 phase 1's "the Anthropic key is in env,
 * documented".
 *
 * Returned as the pair the planner needs (`env` and `secretEnvNames`) so the two cannot drift: a key
 * in `env` that is not named in `secretEnvNames` is a credential no redactor knows about, which is
 * the defect TD-012 step 1 exists to prevent.
 */
export const agentRunEnvironment = (
  options: Pick<AgentRunnerOptions, 'providerMode' | 'modelApiKey'>,
): { readonly env: Record<string, string>; readonly secretEnvNames: string[] } => {
  if (options.providerMode !== 'api' || options.modelApiKey === null) {
    return { env: {}, secretEnvNames: [] };
  }
  return {
    env: { ANTHROPIC_API_KEY: options.modelApiKey },
    secretEnvNames: ['ANTHROPIC_API_KEY'],
  };
};
