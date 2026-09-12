/**
 * A run workspace whose "container" is a scripted CLI — the seam that lets the **real** runner run
 * inside the e2e tier (WP-15g).
 *
 * ## Why this exists rather than another fake runner
 *
 * `FakeClaudeRunner` picks its scenario from `spec.stage` and **never reads the prompt**, so no test
 * driven through it can fail because the prompt was empty, wrong, or contained a ticket the platform
 * never opened — standing rule 82, and the reason WP-15g's first acceptance criterion is written
 * about *the bytes the CLI received*. This provisioner replaces only the process: everything above it
 * is production code — `apps/server`'s own `composeAgentRunner`, `createClaudeRunner`, the Agent
 * SDK's real `query()` and control protocol, the real hook dispatch, the production
 * `run_messages` sink and the per-run TD-012 redactor. The only double is the thing standing in for
 * the model, which is what technical/10 asks of this tier.
 *
 * ## What it does not prove
 *
 * Nothing about the real `claude` binary, the real container, the real run shim, the egress policy or
 * the model. Those meet each other once, against a daemon, in
 * `node scripts/runlet-launcher-check.mjs`, which is not a `verify` target because it needs Docker.
 */
import type { RunSpec } from '@platform/application';
import { runner as runnerAdapters, workspace as workspaceAdapters } from '@platform/infrastructure';

/**
 * The model credential the instance is started with, and the value every redaction assertion looks
 * for.
 *
 * Obviously fake (BD-002) and deliberately **not** in a shape TD-012 step 2's gitleaks-derived
 * patterns match: an `sk-ant-…` value would be redacted by the pattern rules whether or not the
 * run's own injected-secret redactor was composed, so it could not tell the two apart. This one can
 * only be caught by step 1 — the exact values behind `RunSpec.secretEnvNames` — which is the half
 * `apps/server/src/agent.ts` builds per run.
 */
export const PLANTED_MODEL_KEY = 'FAKE-anthropic-key-not-a-real-secret-000';

/** What the placeholder for it looks like once the run's redactor has replaced it. */
export const PLANTED_MODEL_KEY_PLACEHOLDER = '[REDACTED:integration:anthropic_api_key]';

/**
 * Text every scripted run writes to its transcript beside the planted key.
 *
 * The positive half of the redaction assertion: a sink that stored nothing and a sink that redacted
 * everything look identical when you only check that the secret is absent (standing rule 42).
 */
export const TRANSCRIPT_CONTROL_TEXT = 'the stage read the ticket and did its work';

/** One scripted run, kept so a test can read what the CLI actually received. */
export interface AgentRunCapture {
  readonly stage: string;
  /** The spec the planner built — asserted against **only** for things the CLI cannot show. */
  readonly spec: RunSpec;
  readonly cli: runnerAdapters.FakeCli;
}

/** How a run's workspace was released, flattened to one string per run for a readable assertion. */
export interface WorkspaceRelease {
  readonly stage: string;
  /** The terminal status, or `not_started` / `crashed` when there was no outcome. */
  readonly ending: string;
}

const SESSION = 'fake-session-e2e';

/**
 * The NDJSON a scripted CLI plays for one run.
 *
 * The shapes are WP-12's `test/fixtures/claude/happy-path.script.jsonl`, reduced to the four
 * messages a stage needs and parameterised by the scenario's artifact: an `init` so the SDK has a
 * session, a wait for the prompt (which is what makes `FakeCli.stdin` carry it), one assistant turn,
 * and the `result` the runner reads the outcome, the usage and the cost off.
 *
 * The assistant turn **echoes the run's own model credential**, which is the leak this tier exists to
 * catch: a model repeating its environment into its answer is the ordinary way a credential reaches a
 * transcript, and the row it produces is what TD-012 step 1 has to have redacted.
 *
 * The `result` reports **two** models (WP-19): the run's own, and {@link SUBAGENT_MODEL} for the
 * share a sub-agent spent. A single-model result would leave the cost ledger's per-model split — the
 * branch that has to total back to the invoice — unexercised in every tier that runs a real runner,
 * which is standing rule 68's shape: a behaviour parameterised over a set needs a fixture that
 * carries more than one member of it. The two `costUSD` values sum to `total_cost_usd`, so the run's
 * recorded cost is unchanged and no other test's arithmetic moves.
 */

/** The model a sub-agent uses in the scripted result; cheap and different from the run's own. */
export const SUBAGENT_MODEL = 'claude-haiku-4-5';

/** What the sub-agent's share of a run costs in the script. */
export const SUBAGENT_COST_USD = 0.05;
export const fakeCliScriptFor = (
  spec: RunSpec,
  scenario: { readonly structuredOutput: unknown; readonly costUsd?: number },
): runnerAdapters.FakeCliScript => {
  const stage = spec.stage ?? 'stage';
  const cost = scenario.costUsd ?? 0.4;
  return [
    {
      step: 'emit',
      message: {
        type: 'system',
        subtype: 'init',
        apiKeySource: 'ANTHROPIC_API_KEY',
        claude_code_version: '2.1.267',
        cwd: spec.workspacePath,
        tools: [...spec.tools],
        mcp_servers: [{ name: 'platform', status: 'connected' }],
        model: spec.model,
        permissionMode: 'default',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
        uuid: '00000001-0000-4000-8000-000000000000',
        session_id: SESSION,
      },
    },
    // Until the SDK has written the prompt, nothing below runs — which is what makes the stdin
    // assertion an assertion about a real exchange rather than about a buffer.
    { step: 'await_user' },
    {
      step: 'emit',
      message: {
        type: 'assistant',
        message: {
          id: `msg_${stage}`,
          type: 'message',
          role: 'assistant',
          model: spec.model,
          content: [
            {
              type: 'text',
              text: `${TRANSCRIPT_CONTROL_TEXT} (ANTHROPIC_API_KEY=${PLANTED_MODEL_KEY})`,
            },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 80 },
        },
        parent_tool_use_id: null,
        uuid: '00000002-0000-4000-8000-000000000000',
        session_id: SESSION,
      },
    },
    {
      step: 'emit',
      message: {
        type: 'result',
        subtype: 'success',
        duration_ms: 1200,
        duration_api_ms: 1000,
        is_error: false,
        num_turns: 1,
        result: `${stage} finished`,
        stop_reason: 'end_turn',
        total_cost_usd: cost,
        usage: {
          input_tokens: 1200,
          output_tokens: 400,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
        modelUsage: {
          [spec.model]: {
            inputTokens: 1000,
            outputTokens: 350,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: Math.round((cost - SUBAGENT_COST_USD) * 1_000_000) / 1_000_000,
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
          },
          [SUBAGENT_MODEL]: {
            inputTokens: 200,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: SUBAGENT_COST_USD,
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
          },
        },
        permission_denials: [],
        structured_output: scenario.structuredOutput,
        uuid: '00000003-0000-4000-8000-000000000000',
        session_id: SESSION,
      },
    },
    { step: 'exit', code: 0, signal: null },
  ] as runnerAdapters.FakeCliScript;
};

export interface ScriptedWorkspaces {
  readonly provisioner: runnerAdapters.RunWorkspaceProvisioner;
  readonly runs: readonly AgentRunCapture[];
  readonly releases: readonly WorkspaceRelease[];
}

/**
 * Builds the provisioner and the two records a test reads it through.
 *
 * `workdir` is `workspaceAdapters.WORKSPACE_WORKDIR` — the real `/work/repo` of TD-021 — rather than
 * a path invented here, because the runner *replaces* `spec.workspacePath` with it and a test that
 * asserts the substitution must compare against the value production would use.
 */
export const scriptedWorkspaces = (
  scenarioFor: (stage: string) => { readonly structuredOutput: unknown; readonly costUsd?: number },
  /**
   * Called — and **awaited** — inside `provision`, before the CLI exists.
   *
   * Awaiting it is what lets a caller hold a run at its workspace: `provision` is the last thing
   * that happens before the scripted process starts playing, so a promise resolved by the test is
   * a run paused at a known point (WP-15h's live-transcript assertion needs one).
   */
  onSpec?: (spec: RunSpec) => void | Promise<void>,
): ScriptedWorkspaces => {
  const runs: AgentRunCapture[] = [];
  const releases: WorkspaceRelease[] = [];
  return {
    runs,
    releases,
    provisioner: {
      provision: async (spec) => {
        const stage = spec.stage ?? '';
        await onSpec?.(spec);
        const cli = runnerAdapters.fakeSpawnClaudeCodeProcess(
          fakeCliScriptFor(spec, scenarioFor(stage)),
        );
        runs.push({ stage, spec, cli });
        return {
          workdir: workspaceAdapters.WORKSPACE_WORKDIR,
          spawn: cli.spawn,
          release: async (ending) => {
            releases.push({
              stage,
              ending: ending.kind === 'ended' ? ending.status : ending.kind,
            });
          },
        };
      },
    },
  };
};
