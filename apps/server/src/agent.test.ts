/**
 * The agent composition's decisions, which are all about **absence**.
 *
 * The composed path — a real `createClaudeRunner` driving a scripted CLI through a whole instance —
 * is `test/e2e/pipeline/agent-run.e2e.test.ts`. What a unit tier can say that the e2e cannot is what
 * happens when a collaborator is missing, and that each absence is reported *by name* rather than as
 * a boolean, because the name is what an operator has to act on.
 */
import type {
  Broadcast,
  LogFields,
  Logger,
  RunSpec,
  ToolApprovalRequest,
} from '@platform/application';
import * as applicationRunRedaction from '@platform/application';
import { runner as runnerAdapters } from '@platform/infrastructure';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  agentRunEnvironment,
  type ComposedAgentRunner,
  composeAgentRunner,
  injectedSecretRedactorFor,
  injectedSecretRedactorForEnvironment,
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
/**
 * A broadcast that refuses every call.
 *
 * Composition must not *use* it — the transcript hint is published from inside a run, and these
 * cases compose without running — so a throwing double is the assertion: a composition that
 * reached for the transport would fail here rather than pass silently against a no-op (standing
 * rule 1's direction, applied to a test double).
 */
const broadcast = {
  publish: async () => {
    throw new Error('composition must not publish');
  },
  subscribe: async () => {
    throw new Error('composition must not subscribe');
  },
  close: async () => {
    throw new Error('composition must not close the broadcast');
  },
} satisfies Broadcast;
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
      broadcast,
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
      broadcast,
      provisioner: undefined,
      tools,
      providerMode: 'api',
      modelApiKey: 'FAKE-anthropic-key-not-a-real-secret-000',
      logger,
    });
    expect(composed.runner).toBeNull();
    // The **variables**, not "unavailable" and no longer an open-question number: since WP-53 the
    // transport exists, so what an operator has to read about is the two settings that switch this
    // process on — and TD-021 is still why it may not simply build a Docker client instead.
    expect(missingOf(composed).join(' ')).toContain('APP_LAUNCHER_URL');
    expect(missingOf(composed).join(' ')).toContain('APP_LAUNCHER_TOKEN');
    expect(missingOf(composed).join(' ')).toContain('TD-021');
  });

  it('refuses in api mode with no model credential, and names that instead', () => {
    const { logger } = recordingLogger();
    const composed = composeAgentRunner({
      pool,
      broadcast,
      provisioner,
      tools,
      providerMode: 'api',
      modelApiKey: null,
      logger,
    });
    expect(composed.runner).toBeNull();
    expect(missingOf(composed)).toEqual([expect.stringContaining('ANTHROPIC_API_KEY')]);
  });

  /**
   * PROGRESS backlog **128**, in the one case that used to pin the defect.
   *
   * This read *"needs no model credential in local mode, where the binary is the operator's"* and
   * asserted a composed runner with **no credential at all**. That sentence was true when BD-004's
   * `local` mode meant an operator's own `claude` on the host; since WP-22 `compose.local.yml`
   * states the opposite — *"the CLI does not run in this container: it runs in the per-run
   * `platform-runtime` container"* — so the mode runs the same pinned binary and differs only in
   * which credential it authenticates with. WP-53 measured the binary reading
   * `CLAUDE_CODE_OAUTH_TOKEN` out of its process environment.
   */
  it('needs the subscription token in local mode, because the run container gets the same CLI', () => {
    const { logger } = recordingLogger();
    const composed = composeAgentRunner({
      pool,
      broadcast,
      provisioner,
      tools,
      providerMode: 'local',
      modelApiKey: null,
      modelOauthToken: 'FAKE-oat-0000000000',
      logger,
    });
    expect(composed.runner).not.toBeNull();
  });

  it('refuses local mode with no subscription token, and names it', () => {
    const { logger } = recordingLogger();
    const composed = composeAgentRunner({
      pool,
      broadcast,
      provisioner,
      tools,
      providerMode: 'local',
      modelApiKey: null,
      logger,
    });
    expect(composed.runner).toBeNull();
    expect(missingOf(composed)).toEqual([expect.stringContaining('CLAUDE_CODE_OAUTH_TOKEN')]);
  });

  it('lists both absences at once, so one fix does not reveal the next', () => {
    const { logger } = recordingLogger();
    const composed = composeAgentRunner({
      pool,
      broadcast,
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

  /**
   * The other half of backlog **128**: `local` mode was given an **empty** environment and this
   * case asserted it by name, which is why the gap survived five work packages.
   */
  it('injects the subscription token in local mode, named the same way', () => {
    expect(
      agentRunEnvironment({
        providerMode: 'local',
        modelApiKey: null,
        modelOauthToken: 'FAKE-oat-0000000000',
      }),
    ).toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-oat-0000000000' },
      secretEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'],
    });
  });

  it('never carries the other mode’s credential into a run', () => {
    // `api` mode's key is meaningless to a subscription CLI and would be a second secret in the
    // container for nothing — the reasoning `compose.local.yml` already gives for blanking it.
    expect(
      agentRunEnvironment({
        providerMode: 'local',
        modelApiKey: 'FAKE-key-000000',
        modelOauthToken: 'FAKE-oat-0000000000',
      }).env,
    ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-oat-0000000000' });
    expect(
      agentRunEnvironment({
        providerMode: 'api',
        modelApiKey: 'FAKE-key-000000',
        modelOauthToken: 'FAKE-oat-0000000000',
      }).env,
    ).toEqual({ ANTHROPIC_API_KEY: 'FAKE-key-000000' });
  });

  it('injects nothing when the mode’s own credential is absent', () => {
    expect(agentRunEnvironment({ providerMode: 'local', modelApiKey: null })).toEqual({
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

  /**
   * **The same function, not an equivalent one** — TD-012's WP-52 amendment, held as an identity.
   *
   * The construction moved to `packages/application/src/pipeline/run-redaction.ts` because the
   * artifact write and the two prompt columns happen in that ring, and this module re-exports it.
   * An equality of *behaviour* would pass against a copy that drifts; an equality of *object* is
   * what makes "the artifact and the transcript of the run that produced it cannot name different
   * secrets" a fact about the build rather than about two pieces of code agreeing (rule 63).
   */
  it('is literally the application ring’s function, so the two constructions cannot diverge', () => {
    expect(injectedSecretRedactorFor).toBe(applicationRunRedaction.injectedSecretRedactorFor);
    expect(injectedSecretRedactorForEnvironment).toBe(
      applicationRunRedaction.injectedSecretRedactorForEnvironment,
    );
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
