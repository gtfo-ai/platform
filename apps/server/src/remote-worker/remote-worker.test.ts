/**
 * **`ROLE=remote-worker`, in one process** — WP-283 (1)–(3), over a fake core that answers the
 * worker protocol with the `@platform/contracts` schemas the real routes serve, a fake launcher and
 * the scripted Claude CLI under the **real** runner (`createWorkspaceClaudeRunner` over
 * `createClaudeRunner`).
 *
 * What it holds:
 *
 *  - the configuration refuses a database URL and a secret key **by name**, and reads the Claude
 *    token from `_FILE`;
 *  - TD-031 §2's invariant over the constants: `TTL − ½·renew ≥ 2 × renew`;
 *  - a whole run: every request the worker makes parses with the core's own request schema; the
 *    **Claude token is in no request at all** — header or body — though the scripted model echoed
 *    it and wrote it to stderr (WP-283 (2)); `spawn` is answered before the CLI starts; the workspace
 *    is released (every export) **before** `finish`; the run token rides `Authorization` only;
 *  - a `409 lease_lost` on the heartbeat stops the session: no `finish`, and the release exports
 *    nothing;
 *  - self-termination: a session whose renewals fail for `TTL − ½·renew` stops and pushes nothing;
 *  - a steer and a cancel delivered on the heartbeat are applied and acked before `finish`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type RunPackage,
  runPackageSchema,
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_VERSION,
  WORKER_REMOTE_LEASE_RENEW_MS,
  WORKER_REMOTE_LEASE_TTL_MS,
  workerFinishRequestSchema,
  workerHeartbeatRequestSchema,
  workerSpawnRequestSchema,
  workerTranscriptRequestSchema,
} from '@platform/contracts';
import {
  type launcher as launcherAdapters,
  runner as runnerAdapters,
} from '@platform/infrastructure';
import { afterAll, describe, expect, it } from 'vitest';
import { asLoggerPort, createLogger } from '../logging.js';
import { loadRemoteWorkerConfig, REFUSED_WORKER_VARIABLES } from './config.js';
import { type CoreFetch, createCoreClient } from './core-client.js';
import { selfTerminationMsOf } from './retry.js';
import { startRunSession } from './run-session.js';
import { packageWorkspaceProvisioner } from './workspaces.js';

/** Obviously fake, and in no shape a pattern rule knows: only the exact-value redactor can catch it. */
const CLAUDE_TOKEN = 'FAKE-claude-oauth-token-wp283-not-a-real-secret-0001';
const RUN_TOKEN = 'FAKEwp283runtokenAAAAAAAAAAAAAAAAAAAAAAAAAA';
const RUN_CREDENTIAL = 'FAKE-wp283-run-credential-0001';
const RUN_ID = '00000000-0000-4000-8000-000000002831';
const TASK_ID = '00000000-0000-4000-8000-000000002832';
const PROJECT_ID = '00000000-0000-4000-8000-000000002833';
const DIGEST = `sha256:${'a'.repeat(64)}`;

const scratch = mkdtempSync(path.join(tmpdir(), 'remote-worker-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const runPackage = (): RunPackage =>
  runPackageSchema.parse({
    runId: RUN_ID,
    epoch: 3,
    runToken: RUN_TOKEN,
    run: runnerAdapters.runSpecFixture({
      runId: RUN_ID as never,
      taskId: TASK_ID as never,
      projectId: PROJECT_ID as never,
      providerMode: 'local',
      env: { PATH: '/usr/bin' },
      secretEnvNames: [],
      platformTools: ['report_progress'],
      skills: [],
      workspacePath: '/work/repo',
    }),
    workspace: {
      runId: RUN_ID,
      projectId: PROJECT_ID,
      repo: {
        url: 'https://git.example.test/acme/api.git',
        defaultBranch: 'main',
        checkoutBranch: null,
        checkoutCommit: null,
        cacheKey: 'acme-api',
      },
      limits: { cpus: 2, memoryMb: 4096, pidsLimit: 512, tmpfsMb: 256, stopGraceSeconds: 10 },
      egress: { hosts: ['api.anthropic.com', 'git.example.test'], connectPorts: [443] },
      runtime: 'runc',
      readOnly: false,
      skills: [],
      protectedPaths: [],
      env: {},
      keepUntil: '2026-11-07T00:00:00.000Z',
      runletProtocol: 3,
    },
    credential: {
      host: 'git.example.test',
      username: 'oauth2',
      password: RUN_CREDENTIAL,
      scope: 'push',
      expiresAt: '2026-11-07T00:00:00.000Z',
      source: 'minted',
    },
    skills: { digest: 'skills@none', files: {}, versions: {} },
    images: { run: DIGEST, egress: DIGEST },
    limits: { leaseTtlMs: WORKER_REMOTE_LEASE_TTL_MS },
  });

/** What the scripted model does: it echoes the Claude token and writes it to stderr. */
const script = (awaitSteers = 0): runnerAdapters.FakeCliScript => [
  {
    step: 'emit',
    message: {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'none',
      claude_code_version: '2.1.267',
      cwd: '/work/repo',
      tools: ['Read'],
      mcp_servers: [{ name: 'platform', status: 'connected' }],
      model: 'claude-opus-5',
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: '00000001-0000-4000-8000-000000000000',
      session_id: 'fake-session-wp283',
    },
  },
  { step: 'await_user' },
  { step: 'stderr', text: `debug: CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}\n` },
  {
    step: 'emit',
    message: {
      type: 'assistant',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          { type: 'text', text: `my token is ${CLAUDE_TOKEN} and git's is ${RUN_CREDENTIAL}` },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      parent_tool_use_id: null,
      uuid: '00000002-0000-4000-8000-000000000000',
      session_id: 'fake-session-wp283',
    },
  },
  ...Array.from({ length: awaitSteers }, () => ({ step: 'await_user' as const })),
  {
    step: 'emit',
    message: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      result: `done (${CLAUDE_TOKEN})`,
      duration_ms: 100,
      duration_api_ms: 90,
      stop_reason: 'end_turn',
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.25,
          contextWindow: 200_000,
          maxOutputTokens: 64_000,
        },
      },
      permission_denials: [],
      structured_output: {
        reproduction: { kind: 'reproduced', steps: ['a'], evidence: ['b'] },
        root_cause: `the token ${CLAUDE_TOKEN}`,
        confidence: 'high',
        affected_scope: ['x'],
        fix_direction: 'y',
        regression_test_idea: 'z',
        questions: [],
      },
      uuid: '00000003-0000-4000-8000-000000000000',
      session_id: 'fake-session-wp283',
    },
  },
  { step: 'exit', code: 0, signal: null },
];

interface Captured {
  readonly verb: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A core that answers the run verbs as the routes do, and records every request whole. */
const fakeCore = (options: {
  /** The heartbeat's answer by beat number (from 1); absent is a renewal with nothing pending. */
  readonly beat?: (n: number) => { readonly status: number; readonly body: unknown } | null;
}) => {
  const captured: Captured[] = [];
  const events: string[] = [];
  let beats = 0;
  const fetch: CoreFetch = async (url, init) => {
    const verb = new URL(url).pathname.replace('/api/worker/v1/', '').replace(RUN_ID, ':id');
    const headers = init.headers as Record<string, string>;
    const body = String(init.body ?? '');
    captured.push({ verb, headers, body });
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const answer = (status: number, json: unknown): Response =>
      new Response(json === null ? null : JSON.stringify(json), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    switch (verb) {
      case 'runs/:id/heartbeat': {
        workerHeartbeatRequestSchema.parse(parsed);
        beats += 1;
        const scripted = options.beat?.(beats) ?? null;
        if (scripted !== null) return answer(scripted.status, scripted.body);
        // A held request with nothing pending, shortened; it ends early when the worker goes away.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 20);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
        return answer(200, {
          lease_expires_at: '2026-11-05T10:10:00.000Z',
          commands: [],
          approvals: [],
        });
      }
      case 'runs/:id/transcript':
        workerTranscriptRequestSchema.parse(parsed);
        return answer(200, {
          stored: (parsed.entries as unknown[]).length,
          refused_seqs: [],
        });
      case 'runs/:id/spawn':
        workerSpawnRequestSchema.parse(parsed);
        events.push('core:spawn');
        return answer(200, { started_at: '2026-11-05T10:00:00.000Z' });
      case 'runs/:id/finish': {
        const request = workerFinishRequestSchema.parse(parsed);
        events.push('core:finish');
        return answer(200, {
          outcome: 'settled',
          ending: {
            status: request.outcome.kind === 'ran' ? request.outcome.status : 'failed',
            terminal_reason:
              request.outcome.kind === 'ran' ? request.outcome.terminal_reason : 'start_failure',
            epoch: request.epoch,
          },
        });
      }
      case 'runs/:id/late-cost':
        return answer(200, { recorded: false });
      default:
        return answer(404, { error: { code: 'not_found', message: verb } });
    }
  };
  return { fetch, captured, events };
};

/** A launcher that records its two calls, whose create answers a control socket under the root. */
const fakeLauncher = (events: string[]) => {
  const ends: launcherAdapters.EndRunRequestPayload[] = [];
  const creates: launcherAdapters.CreateRunRequestPayload[] = [];
  const client = {
    createRun: async (request: launcherAdapters.CreateRunRequestPayload) => {
      creates.push(request);
      events.push('launcher:create');
      return {
        handle: { runId: RUN_ID, containerId: 'fake' },
        attachment: {
          socketPath: path.join(scratch, RUN_ID, 'control.sock'),
          token: 'fake-attach-token',
          workdir: '/work/repo',
        },
        claudeCodePath: '/usr/local/bin/claude',
        credentialScope: 'push',
        existingProtectedPaths: { state: 'unlisted', reason: 'a unit fake' },
        replayed: false,
      } as unknown as launcherAdapters.CreateRunResponse;
    },
    endRun: async (_runId: string, request: launcherAdapters.EndRunRequestPayload) => {
      ends.push(request);
      events.push('launcher:end');
      return { exported: null, keepUntil: null, failures: [] };
    },
    health: async () => {
      throw new Error('not asked');
    },
    listRuns: async () => ({ runs: [] }),
    destroyRun: async () => ({ found: false }),
  } as unknown as launcherAdapters.LauncherControlClient;
  return { client, ends, creates };
};

const run = (options: {
  readonly core: ReturnType<typeof fakeCore>;
  readonly awaitSteers?: number;
  readonly monotonic?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}) => {
  const lines: string[] = [];
  const logger = asLoggerPort(
    createLogger({
      level: 'debug',
      format: 'json',
      role: 'remote-worker',
      destination: { write: (line: string) => lines.push(line) },
    }),
  );
  const launcher = fakeLauncher(options.core.events);
  const pkg = runPackage();
  let cli: runnerAdapters.FakeCli | null = null;
  const session = startRunSession({
    pkg,
    core: createCoreClient({
      baseUrl: 'https://core.example.test',
      fetch: options.core.fetch,
    }).forRun(pkg.runId, pkg.runToken),
    claudeToken: CLAUDE_TOKEN,
    logger,
    ...(options.monotonic === undefined ? {} : { monotonic: options.monotonic }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    selfTerminationCheckMs: 10,
    provisionerFor: ({ sshSign, exportsAllowed }) =>
      packageWorkspaceProvisioner(pkg, {
        launcher: launcher.client,
        controlRoot: scratch,
        clock: runnerAdapters.systemClock,
        sshSign,
        exportsAllowed,
        repositoryPathOf: () => 'acme/api',
        spawnFor: () => {
          cli = runnerAdapters.fakeSpawnClaudeCodeProcess(script(options.awaitSteers), {
            interruptedResult: {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              num_turns: 1,
              duration_ms: 1,
              duration_api_ms: 1,
              stop_reason: null,
              total_cost_usd: 0.01,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
              },
              modelUsage: {},
              permission_denials: [],
              errors: [],
              uuid: '00000004-0000-4000-8000-000000000000',
              session_id: 'fake-session-wp283',
            },
          });
          const spawn = cli.spawn;
          return (spawnOptions) => {
            options.core.events.push('cli:spawned');
            return spawn(spawnOptions);
          };
        },
        logger,
      }),
  });
  return { session, launcher, lines, cli: () => cli };
};

describe('ROLE=remote-worker’s configuration (WP-283 (1))', () => {
  const base = {
    APP_CORE_URL: 'https://core.example.test',
    CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
    APP_LAUNCHER_URL: 'http://launcher:7780',
    APP_LAUNCHER_TOKEN: 'FAKE-launcher-token-0000000000000000',
    APP_WORKSPACE_CONTROL_ROOT: '/run/agentic/ctl',
  };

  it('starts with no database and no secret key, and reads the Claude token from _FILE', () => {
    const file = path.join(scratch, 'claude-token');
    writeFileSync(file, `${CLAUDE_TOKEN}\n`);
    const config = loadRemoteWorkerConfig({
      ...base,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN_FILE: file,
      PLATFORM_RUNTIME_IMAGE: `ghcr.io/acme/platform-runtime@${DIGEST}`,
      PLATFORM_EGRESS_IMAGE: 'platform-egress:dev',
    });
    expect(config.claudeToken).toBe(CLAUDE_TOKEN);
    expect(config.concurrency).toBe(1);
    expect(config.imageDigests).toEqual([DIGEST]);
  });

  it.each(REFUSED_WORKER_VARIABLES)('refuses %s by name', (name) => {
    expect(() => loadRemoteWorkerConfig({ ...base, [name]: 'postgres://app@db/app' })).toThrow(
      new RegExp(`${name} is set: a remote worker has no database and no instance secret key`),
    );
  });

  it('refuses a missing core URL, Claude token and launcher, naming each', () => {
    expect(() => loadRemoteWorkerConfig({})).toThrow(
      /APP_CORE_URL is required[\s\S]*CLAUDE_CODE_OAUTH_TOKEN is required[\s\S]*APP_LAUNCHER_URL is required/,
    );
  });
});

describe('self-termination’s bound (TD-031 §2)', () => {
  it('is TTL − ½·renew, 585 s for a remote run, and tolerates at least two missed beats', () => {
    const bound = selfTerminationMsOf(WORKER_REMOTE_LEASE_TTL_MS, WORKER_REMOTE_LEASE_RENEW_MS);
    expect(bound).toBe(585_000);
    expect(bound).toBeGreaterThanOrEqual(2 * WORKER_REMOTE_LEASE_RENEW_MS);
  });
});

describe('a remote run, from its package to its finish (WP-283 (1)–(2))', () => {
  it('puts the Claude token in no request, asks spawn before the CLI, and exports before finish', async () => {
    const core = fakeCore({});
    const { session, launcher, lines, cli } = run({ core });
    expect(await session.done).toBe('settled');

    // The Claude token went into the CLI's environment — and only there.
    expect(cli()?.spawnOptions?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_TOKEN);
    expect(JSON.stringify(launcher.creates)).not.toContain(CLAUDE_TOKEN);
    // Every request, whole — verb, headers, body — and the transcript reached the core (rule 42).
    expect(core.captured.some((request) => request.verb === 'runs/:id/transcript')).toBe(true);
    for (const request of core.captured) {
      expect(`${request.verb} ${request.body}`).not.toContain(CLAUDE_TOKEN);
      expect(JSON.stringify(request.headers)).not.toContain(CLAUDE_TOKEN);
      // The run token authenticates in a header and never travels in a body.
      expect(request.body).not.toContain(RUN_TOKEN);
      expect(request.headers.authorization).toBe(`Bearer ${RUN_TOKEN}`);
      expect(request.headers[WORKER_PROTOCOL_HEADER]).toBe(String(WORKER_PROTOCOL_VERSION));
    }
    const transcript = core.captured
      .filter((request) => request.verb === 'runs/:id/transcript')
      .map((request) => request.body)
      .join('\n');
    expect(transcript).toContain('[REDACTED:integration:claude_code_oauth_token]');
    expect(transcript).not.toContain(RUN_CREDENTIAL);
    // …and in no log line either.
    expect(lines.join('\n')).not.toContain(CLAUDE_TOKEN);

    // The marker before the CLI, the workspace's release (its exports) before the finish.
    expect(core.events.indexOf('core:spawn')).toBeLessThan(core.events.indexOf('cli:spawned'));
    expect(core.events.indexOf('launcher:end')).toBeGreaterThan(-1);
    expect(core.events.indexOf('launcher:end')).toBeLessThan(core.events.indexOf('core:finish'));
    const finish = workerFinishRequestSchema.parse(
      JSON.parse(core.captured.find((request) => request.verb === 'runs/:id/finish')?.body ?? '{}'),
    );
    expect(finish).toMatchObject({ epoch: 3, outcome: { kind: 'ran', status: 'completed' } });
  });

  it('stops on lease_lost: no finish, and the workspace is released', async () => {
    const core = fakeCore({
      beat: () => ({
        status: 409,
        body: { error: { code: 'lease_lost', message: 'another claim holds it' } },
      }),
    });
    // The CLI waits for a steer that never comes, so only the loss can end the run.
    const { session, launcher } = run({ core, awaitSteers: 1 });
    expect(await session.done).toBe('lease_lost');
    expect(core.events).not.toContain('core:finish');
    expect(launcher.ends).toHaveLength(1);
  });

  it('self-terminates after TTL − ½·renew without a renewal, and pushes nothing more', async () => {
    let now = 0;
    const core = fakeCore({
      beat: () => {
        // Every beat fails on the network, and the monotonic clock passes the bound meanwhile.
        now += 600_000;
        return { status: 503, body: { error: { code: 'unavailable', message: 'deploying' } } };
      },
    });
    const { session } = run({
      core,
      awaitSteers: 1,
      monotonic: () => now,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
    expect(await session.done).toBe('self_terminated');
    expect(core.events).not.toContain('core:finish');
  });

  it('applies a steer and a cancel from the heartbeat and acks both before finish', async () => {
    const STEER = '00000000-0000-4000-8000-0000000028a1';
    const CANCEL = '00000000-0000-4000-8000-0000000028a2';
    let steered = false;
    const core = fakeCore({
      beat: (n) => {
        if (n === 2 && !steered) {
          steered = true;
          return {
            status: 200,
            body: {
              lease_expires_at: '2026-11-05T10:10:00.000Z',
              commands: [
                {
                  id: STEER,
                  kind: 'steer',
                  payload: {
                    text: 'look at the login test',
                    author_user_id: '00000000-0000-4000-8000-0000000028b1',
                    author_label: 'Alice',
                  },
                },
              ],
              approvals: [],
            },
          };
        }
        if (n === 4) {
          return {
            status: 200,
            body: {
              lease_expires_at: '2026-11-05T10:10:00.000Z',
              commands: [{ id: CANCEL, kind: 'cancel', payload: {} }],
              approvals: [],
            },
          };
        }
        return null;
      },
    });
    // Two user turns: the steer arrives, then the CLI waits again until the cancel stops it.
    const { session, cli } = run({ core, awaitSteers: 2 });
    expect(await session.done).toBe('settled');
    expect(JSON.stringify(cli()?.stdin)).toContain('look at the login test');
    const acks = core.captured
      .filter((request) => request.verb === 'runs/:id/heartbeat')
      .flatMap((request) => workerHeartbeatRequestSchema.parse(JSON.parse(request.body)).acks);
    expect(acks).toContainEqual({ command_id: STEER, outcome: 'applied' });
    expect(acks).toContainEqual({ command_id: CANCEL, outcome: 'applied' });
    const lastAck = core.captured.findLastIndex(
      (request) => request.verb === 'runs/:id/heartbeat' && request.body.includes(CANCEL),
    );
    const finish = core.captured.findIndex((request) => request.verb === 'runs/:id/finish');
    expect(lastAck).toBeLessThan(finish);
    expect(
      workerFinishRequestSchema.parse(JSON.parse(core.captured[finish]?.body ?? '{}')),
    ).toMatchObject({ outcome: { kind: 'ran', status: 'cancelled' }, stop_reason: 'cancelled' });
  });
});

describe('the package’s workspace release (WP-283, TD-031 §2 and §14)', () => {
  const takeOverEnding = {
    kind: 'ended' as const,
    status: 'cancelled' as const,
    takeOver: {
      branch: 'agentic/ACME-1',
      commitMessage: 'wip: hand-over to Alice',
      tarball: true,
      keepUntil: '2026-11-19T00:00:00.000Z',
    },
  };
  const provisioned = async (exportsAllowed: boolean) => {
    const events: string[] = [];
    const launcher = fakeLauncher(events);
    const pkg = runPackage();
    const workspace = await packageWorkspaceProvisioner(pkg, {
      launcher: launcher.client,
      controlRoot: scratch,
      clock: runnerAdapters.systemClock,
      sshSign: async () => null,
      exportsAllowed: () => exportsAllowed,
      repositoryPathOf: () => 'acme/api',
      spawnFor: () => runnerAdapters.fakeSpawnClaudeCodeProcess(script()).spawn,
    }).provision(pkg.run as never);
    return { workspace, launcher };
  };

  it('exports a take-over’s branch with no tarball, whatever the command asked (backlog 688)', async () => {
    const { workspace, launcher } = await provisioned(true);
    await workspace.release(takeOverEnding as never);
    expect(launcher.ends[0]?.export).toMatchObject({ branch: 'agentic/ACME-1', tarball: false });
  });

  it('exports nothing for a run that is lost, take-over or not (TD-031 §2)', async () => {
    const { workspace, launcher } = await provisioned(false);
    await workspace.release(takeOverEnding as never);
    expect(launcher.ends[0]?.export).toBeNull();
  });

  it('sends the package’s workspace, credential, skills and images to the launcher — and no Claude token', async () => {
    const { launcher } = await provisioned(true);
    expect(launcher.creates[0]).toMatchObject({
      spec: { runId: RUN_ID },
      credential: { password: RUN_CREDENTIAL, source: 'minted' },
      images: { run: DIGEST, egress: DIGEST },
    });
    expect(launcher.creates[0]?.helperAgentSocket).toBeUndefined();
    expect(JSON.stringify(launcher.creates)).not.toContain(CLAUDE_TOKEN);
  });
});
