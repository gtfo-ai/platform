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
import { runlet as runletAdapters, runner as runnerAdapters } from '@platform/infrastructure';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  agentRunEnvironment,
  type ComposedAgentRunner,
  composeAgentRunner,
  injectedSecretRedactorFor,
  injectedSecretRedactorForEnvironment,
  runTranscriptRedactorFor,
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
const runSecrets = applicationRunRedaction.createRunScopedSecrets({ now: () => 0 });

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
      runSecrets,
      tools,
      providerMode: 'api',
      modelApiKey: 'FAKE-anthropic-key-not-a-real-secret-000',
      modelOauthToken: null,
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
      runSecrets,
      tools,
      providerMode: 'api',
      modelApiKey: 'FAKE-anthropic-key-not-a-real-secret-000',
      modelOauthToken: null,
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
      runSecrets,
      tools,
      providerMode: 'api',
      modelApiKey: null,
      modelOauthToken: null,
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
      runSecrets,
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
      runSecrets,
      tools,
      providerMode: 'local',
      modelApiKey: null,
      modelOauthToken: null,
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
      runSecrets,
      tools,
      providerMode: 'api',
      modelApiKey: null,
      modelOauthToken: null,
      logger,
    });
    expect(missingOf(composed)).toHaveLength(2);
  });
});

/**
 * WP-118 (TD-025's amendment, PROGRESS backlog 342): this file is the production composition, and
 * the launcher's answer only reaches the CLI if its `build` forwards it. Driven through the composed
 * runner to the one seam that shows it — the environment the SDK hands `spawnClaudeCodeProcess`,
 * which the run shim gives the CLI verbatim — and stopped there.
 */
describe('the composed runner hands the launcher’s CLI environment to the spawn (WP-118)', () => {
  it('spawns the CLI with the proxy, HOME, CLAUDE_CONFIG_DIR, PATH and one git list of two', async () => {
    const { logger } = recordingLogger();
    const spawned: Record<string, string | undefined>[] = [];
    const answering: runnerAdapters.RunWorkspaceProvisioner = {
      provision: async () => ({
        workdir: '/work/repo',
        claudeCodePath: '/usr/local/bin/claude',
        cliEnvironment: {
          proxy: { url: 'http://egress-wp118:8888', noProxy: 'localhost,127.0.0.1' },
          home: '/tmp',
          claudeConfigDir: '/tmp/claude',
          path: '/usr/local/bin:/usr/bin:/bin',
          gitConfig: [
            {
              key: 'credential.helper',
              value: '!agentic-runlet credential --socket /ctl/cred.sock',
            },
          ],
        },
        spawn: (options) => {
          spawned.push({ ...options.env });
          throw new Error('the spawn is the seam under test; the run stops here');
        },
        release: async () => {},
      }),
    };
    const composed = composeAgentRunner({
      pool,
      broadcast,
      provisioner: answering,
      runSecrets,
      tools,
      providerMode: 'api',
      modelApiKey: 'FAKE-anthropic-key-not-a-real-secret-000',
      modelOauthToken: null,
      logger,
    });
    if (composed.runner === null) {
      throw new Error('expected a runner');
    }
    const spec = runnerAdapters.runSpecFixture({
      env: agentRunEnvironment({
        providerMode: 'api',
        modelApiKey: 'FAKE-anthropic-key-not-a-real-secret-000',
        modelOauthToken: null,
      }).env,
      secretEnvNames: ['ANTHROPIC_API_KEY'],
      artifactType: null,
    });
    await composed.runner.start(spec).outcome.catch(() => undefined);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      ANTHROPIC_API_KEY: 'FAKE-anthropic-key-not-a-real-secret-000',
      HTTPS_PROXY: 'http://egress-wp118:8888',
      HTTP_PROXY: 'http://egress-wp118:8888',
      NO_PROXY: 'localhost,127.0.0.1',
      HOME: '/tmp',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
    });
  });
});

/**
 * **A containerised CLI's stderr reaches the runner's redactor** (WP-127, PROGRESS backlog 344).
 *
 * The frame is real: the run shim (`createRunletShim`) runs a child that writes the run's own model
 * credential on stderr and exits before its first stream message, and the spawn is the production
 * `createRunletSpawn` the launcher provisioner builds — with no `onStderr`, as there. Only the
 * command is replaced (the image's `claude` is not on this machine). What is asserted is the one
 * `warn` line, redacted, and that the stderr text reached neither the outcome nor the transcript.
 */
describe('the composed runner logs a containerised CLI’s stderr, redacted (WP-127)', () => {
  it('writes a CLI that died before its stream at warn, with the credential replaced', async () => {
    const key = 'FAKE-anthropic-key-not-a-real-secret-000';
    const { logger, lines } = recordingLogger();
    const volume = await runletAdapters.createControlVolume();
    const token = 'run-token-wp127-0000000000000000';
    const shim = runletAdapters.createRunletShim({
      controlSocketPath: volume.controlSocketPath,
      credentialSocketPath: volume.credentialSocketPath,
      token,
      clock: runnerAdapters.systemClock,
    });
    await shim.start();
    try {
      const transport = runletAdapters.createRunletSpawn({
        socketPath: volume.controlSocketPath,
        token,
        clock: runnerAdapters.systemClock,
      });
      const script = `process.stderr.write('auth failed for ${key}\\n'); process.exit(1);`;
      const answering: runnerAdapters.RunWorkspaceProvisioner = {
        provision: async () => ({
          workdir: process.cwd(),
          claudeCodePath: '/usr/local/bin/claude',
          // The command is the only thing replaced; the sink seam is the transport's own.
          spawn: Object.assign(
            (options: Parameters<typeof transport>[0]) =>
              transport({ ...options, ...runletAdapters.nodeScript(script), cwd: process.cwd() }),
            { setStderrSink: transport.setStderrSink },
          ),
          release: async () => {},
        }),
      };
      const composed = composeAgentRunner({
        pool,
        broadcast,
        provisioner: answering,
        runSecrets,
        tools,
        providerMode: 'api',
        modelApiKey: key,
        modelOauthToken: null,
        logger,
      });
      if (composed.runner === null) {
        throw new Error('expected a runner');
      }
      const spec = runnerAdapters.runSpecFixture({
        env: agentRunEnvironment({ providerMode: 'api', modelApiKey: key, modelOauthToken: null })
          .env,
        secretEnvNames: ['ANTHROPIC_API_KEY'],
        artifactType: null,
      });
      const outcome = await composed.runner.start(spec).outcome;

      const warned = lines.filter((line) =>
        line.message.includes('before its first stream message'),
      );
      expect(warned).toHaveLength(1);
      expect(String(warned[0]?.fields['stderr'])).toMatch(
        /^auth failed for \[REDACTED:[^\]]+\]\n$/,
      );
      expect(JSON.stringify(lines)).not.toContain(key);
      expect(outcome.status).toBe('failed');
      expect(JSON.stringify(outcome)).not.toContain('auth failed');
    } finally {
      await shim.close();
      await volume.cleanup();
    }
  });
});

describe('the run environment', () => {
  it('names the credential it injects, so TD-012 step 1 covers it', () => {
    // A key in `env` that is not in `secretEnvNames` is a credential no redactor knows about, which
    // is precisely the defect step 1 exists to prevent — so the two are returned together.
    expect(
      agentRunEnvironment({
        providerMode: 'api',
        modelApiKey: 'FAKE-key-000000',
        modelOauthToken: null,
      }),
    ).toEqual({
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
    expect(
      agentRunEnvironment({ providerMode: 'local', modelApiKey: null, modelOauthToken: null }),
    ).toEqual({
      env: {},
      secretEnvNames: [],
    });
    expect(
      agentRunEnvironment({ providerMode: 'api', modelApiKey: null, modelOauthToken: null }),
    ).toEqual({
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

/**
 * TD-028's WP-76 amendment decision 8: the transcript redactor of a run is built when the run
 * starts, and its git credential is minted while its workspace is provisioned — so the redactor has
 * to learn a value that did not exist when it was built.
 */
describe('the run transcript redactor (WP-76)', () => {
  it('replaces a credential registered after it was built, and the spec’s own secrets too', () => {
    const secrets = applicationRunRedaction.createRunScopedSecrets({
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    });
    const spec = {
      runId: '11111111-1111-4111-8111-111111111111',
      env: { ANTHROPIC_API_KEY: 'FAKE-anthropic-key-not-a-real-secret-000' },
      secretEnvNames: ['ANTHROPIC_API_KEY'],
    } as unknown as RunSpec;
    const redactor = runTranscriptRedactorFor(spec, secrets, recordingLogger().logger);
    const token = 'fake_run_credential_push_000001';
    expect(redactor.redactText(`git push with ${token}`).count).toBe(0);

    secrets.add(spec.runId, token, '2026-01-03T00:00:00.000Z');

    const later = redactor.redactText(
      `git push with ${token} and FAKE-anthropic-key-not-a-real-secret-000`,
    );
    expect(later.count).toBe(2);
    expect(later.value).not.toContain(token);
  });
});
