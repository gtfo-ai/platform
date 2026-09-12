/**
 * The agent composition's decisions, which are all about **absence**.
 *
 * The composed path — a real `createClaudeRunner` driving a scripted CLI through a whole instance —
 * is `test/e2e/pipeline/agent-run.e2e.test.ts`. What a unit tier can say that the e2e cannot is what
 * happens when a collaborator is missing, and that each absence is reported *by name* rather than as
 * a boolean, because the name is what an operator has to act on.
 */
import type { LogFields, Logger, RunSpec, ToolApprovalRequest } from '@platform/application';
import { runner as runnerAdapters } from '@platform/infrastructure';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  agentRunEnvironment,
  type ComposedAgentRunner,
  composeAgentRunner,
  injectedSecretRedactorFor,
  unattendedToolApprovals,
} from './agent.js';

/** Narrowing rather than a cast: the refusal is a union member, and the cast hid that. */
const missingOf = (composed: ComposedAgentRunner): readonly string[] =>
  composed.runner === null ? composed.missing : [];

const recordingLogger = (): { logger: Logger; lines: { fields: LogFields; message: string }[] } => {
  const lines: { fields: LogFields; message: string }[] = [];
  const push = (fields: LogFields, message: string) => lines.push({ fields, message });
  return { logger: { debug: push, info: push, warn: push, error: push }, lines };
};

const pool = {} as pg.Pool;
const tools = runnerAdapters.recordingTools();
const provisioner: runnerAdapters.RunWorkspaceProvisioner = {
  provision: async () => {
    throw new Error('not used in this test');
  },
};

describe('composing the agent runner', () => {
  it('composes one when it has a provisioner and a credential', () => {
    const { logger } = recordingLogger();
    const composed = composeAgentRunner({
      pool,
      provisioner,
      tools,
      providerMode: 'api',
      modelApiKey: 'FAKE-anthropic-key-not-a-real-secret-000',
      logger,
    });
    expect(composed.runner).not.toBeNull();
  });

  it('names the workspace provisioner when there is none, and does not pretend', () => {
    const { logger } = recordingLogger();
    const composed = composeAgentRunner({
      pool,
      provisioner: undefined,
      tools,
      providerMode: 'api',
      modelApiKey: 'FAKE-anthropic-key-not-a-real-secret-000',
      logger,
    });
    expect(composed.runner).toBeNull();
    // The name, not "unavailable": Q52 is what an operator has to read about, and TD-021 is why this
    // process may not simply build a Docker client instead.
    expect(missingOf(composed).join(' ')).toContain('Q52');
    expect(missingOf(composed).join(' ')).toContain('TD-021');
  });

  it('refuses in api mode with no model credential, and names that instead', () => {
    const { logger } = recordingLogger();
    const composed = composeAgentRunner({
      pool,
      provisioner,
      tools,
      providerMode: 'api',
      modelApiKey: null,
      logger,
    });
    expect(composed.runner).toBeNull();
    expect(missingOf(composed)).toEqual([expect.stringContaining('ANTHROPIC_API_KEY')]);
  });

  it('needs no model credential in local mode, where the binary is the operator’s', () => {
    const { logger } = recordingLogger();
    const composed = composeAgentRunner({
      pool,
      provisioner,
      tools,
      providerMode: 'local',
      modelApiKey: null,
      logger,
    });
    expect(composed.runner).not.toBeNull();
  });

  it('lists both absences at once, so one fix does not reveal the next', () => {
    const { logger } = recordingLogger();
    const composed = composeAgentRunner({
      pool,
      provisioner: undefined,
      tools,
      providerMode: 'api',
      modelApiKey: null,
      logger,
    });
    expect(missingOf(composed)).toHaveLength(2);
  });
});

describe('the run environment', () => {
  it('names the credential it injects, so TD-012 step 1 covers it', () => {
    // A key in `env` that is not in `secretEnvNames` is a credential no redactor knows about, which
    // is precisely the defect step 1 exists to prevent — so the two are returned together.
    expect(agentRunEnvironment({ providerMode: 'api', modelApiKey: 'FAKE-key-000000' })).toEqual({
      env: { ANTHROPIC_API_KEY: 'FAKE-key-000000' },
      secretEnvNames: ['ANTHROPIC_API_KEY'],
    });
  });

  it('injects nothing in local mode or with no key', () => {
    expect(agentRunEnvironment({ providerMode: 'local', modelApiKey: 'FAKE-key-000000' })).toEqual({
      env: {},
      secretEnvNames: [],
    });
    expect(agentRunEnvironment({ providerMode: 'api', modelApiKey: null })).toEqual({
      env: {},
      secretEnvNames: [],
    });
  });
});

describe('the per-run redactor', () => {
  const specWith = (env: Record<string, string>, names: string[]): RunSpec =>
    runnerAdapters.runSpecFixture({ env, secretEnvNames: names });

  it('replaces the values behind secretEnvNames, under a placeholder named for the variable', () => {
    const { logger } = recordingLogger();
    const redactor = injectedSecretRedactorFor(
      specWith({ ANTHROPIC_API_KEY: 'FAKE-anthropic-000000' }, ['ANTHROPIC_API_KEY']),
      logger,
    );
    const out = redactor.redactText('I read FAKE-anthropic-000000 from my environment');
    expect(out.value).toBe('I read [REDACTED:integration:anthropic_api_key] from my environment');
    expect(out.count).toBe(1);
  });

  it('skips a name whose value is missing or too short, and says so', () => {
    // `exactSecretRedactor` refuses a value under `MIN_SECRET_LENGTH` because redacting it would
    // erase ordinary text. The fail-closed answer to "this run has a 4-character credential" is a
    // warning about the credential, not a run that cannot start.
    const { logger, lines } = recordingLogger();
    const redactor = injectedSecretRedactorFor(
      specWith({ SHORT: 'abc' }, ['SHORT', 'ABSENT']),
      logger,
    );
    expect(redactor.redactText('abc').count).toBe(0);
    expect(lines.filter((line) => line.message.includes('cannot be redacted'))).toHaveLength(2);
  });
});

describe('the approvals port', () => {
  it('denies, with a reason, and never throws', async () => {
    // BD-025's unattended default, and the port's own contract: an implementation that cannot reach a
    // human resolves `deny`; a throw from `canUseTool` would end the run instead of the tool call.
    const { logger, lines } = recordingLogger();
    const decision = await unattendedToolApprovals(logger).requestApproval({
      runId: 'r',
      taskId: 't',
      toolName: 'Bash',
      detail: 'rm -rf /',
      input: {},
      reason: 'matched the ask list',
      timeoutMs: 1,
      signal: new AbortController().signal,
    } as unknown as ToolApprovalRequest);
    expect(decision).toMatchObject({ decision: 'deny', questionId: null });
    expect(decision.reason).toContain('cannot ask a human');
    expect(lines).toHaveLength(1);
  });
});
