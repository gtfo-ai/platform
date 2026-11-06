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

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PlatformToolContext, RunProgressRecorder } from '@platform/application';
import {
  type RunPackage,
  runPackageSchema,
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_VERSION,
  WORKER_REMOTE_LEASE_RENEW_MS,
  WORKER_REMOTE_LEASE_TTL_MS,
  workerApprovalRequestSchema,
  workerClaimRequestSchema,
  workerClaimScopeRequestSchema,
  workerFinishRequestSchema,
  workerHandshakeRequestSchema,
  workerHeartbeatRequestSchema,
  workerLocalClaimScopeSchema,
  workerLocalOffersSchema,
  workerLocalStateSchema,
  workerManualPauseRequestSchema,
  workerOfferClaimRequestSchema,
  workerPauseRequestSchema,
  workerRunCancelRequestSchema,
  workerRunReleaseRequestSchema,
  workerSpawnRequestSchema,
  workerTranscriptRequestSchema,
} from '@platform/contracts';
import {
  type launcher as launcherAdapters,
  runner as runnerAdapters,
} from '@platform/infrastructure';
import { afterAll, describe, expect, it } from 'vitest';
import { asLoggerPort, createLogger } from '../logging.js';
import { type ClaudeCliLauncher, runBounded } from './claude-sign-in.js';
import { loadRemoteWorkerConfig, REFUSED_WORKER_VARIABLES } from './config.js';
import {
  CoreCallError,
  type CoreFetch,
  createCoreClient,
  type RunScopedClient,
} from './core-client.js';
import { retrying, selfTerminationMsOf } from './retry.js';
import {
  createRemoteToolPort,
  guardedRunClient,
  redactKeysAndValues,
  startRunSession,
  workerSecretRedactor,
} from './run-session.js';
import { DRAIN_MARKER_FILE, startRemoteWorker } from './runtime.js';
import { UI_TOKEN_FILE } from './ui-token.js';
import { packageWorkspaceProvisioner } from './workspaces.js';

/** Obviously fake, and in no shape a pattern rule knows: only the exact-value redactor can catch it. */
const CLAUDE_TOKEN = 'FAKE-claude-oauth-token-wp283-not-a-real-secret-0001';
const RUN_TOKEN = 'FAKEwp283runtokenAAAAAAAAAAAAAAAAAAAAAAAAAA';
const RUN_CREDENTIAL = 'FAKE-wp283-run-credential-0001';
const RUN_ID = '00000000-0000-4000-8000-000000002831';
const TASK_ID = '00000000-0000-4000-8000-000000002832';
const PROJECT_ID = '00000000-0000-4000-8000-000000002833';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const APPROVAL_ID = '00000000-0000-4000-8000-0000000028d1';
const WORKER_ID = '00000000-0000-4000-8000-0000000029f1';
/** A stored worker credential, so the runtime skips the device flow. */
const WORKER_CREDENTIAL = `wkr_${'a'.repeat(26)}_${'C'.repeat(43)}`;
/** What this worker's launcher answers — distinct from the package's own values (backlog 695). */
const LAUNCHER_WORKDIR = '/work/launcher-checkout';
const LAUNCHER_CLI = '/opt/launcher-image/bin/claude';

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
const script = (awaitSteers = 0, askApproval = false): runnerAdapters.FakeCliScript => [
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
  ...(askApproval
    ? [
        {
          step: 'can_use_tool' as const,
          tool_name: 'WebFetch',
          input: { url: `https://example.test/?t=${CLAUDE_TOKEN}`, [CLAUDE_TOKEN]: 'as a key' },
          tool_use_id: 'toolu_approval_1',
          decision_reason: `asked because ${CLAUDE_TOKEN}`,
        },
      ]
    : []),
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

/**
 * A session its usage limit ends (WP-285): the `rate_limit_event` with `status: "rejected"` and a
 * reset `resetsInMs` from now (in milliseconds, which the magnitude rule reads as such), then the
 * `429` result the CLI fails with — the shape of `test/fixtures/claude/usage-limit-rejected`.
 */
const limitedScript = (resetsInMs: number): runnerAdapters.FakeCliScript => [
  ...script().slice(0, 2),
  {
    step: 'emit',
    message: {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: Date.now() + resetsInMs },
      uuid: '00000002-0000-4000-8000-000000000285',
      session_id: 'fake-session-wp283',
    },
  },
  {
    step: 'emit',
    message: {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      duration_ms: 10,
      duration_api_ms: 8,
      num_turns: 1,
      result: 'Claude usage limit reached.',
      stop_reason: null,
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
      modelUsage: {},
      permission_denials: [],
      uuid: '00000003-0000-4000-8000-000000000285',
      session_id: 'fake-session-wp283',
    },
  },
  { step: 'exit', code: 1, signal: null },
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
  /** The worker verbs too (WP-292): handshake, one claimed package, then `204`s. */
  readonly claims?: readonly RunPackage[];
  /** The transcript upload's answer by upload number (from 1); absent stores the batch. */
  readonly transcript?: (n: number) => { readonly status: number; readonly body: unknown } | null;
  /** `GET offers`' entries (WP-293); absent is none. */
  readonly offers?: readonly unknown[];
  /** What `POST offers/:id/claim` answers (WP-293): the package, or `409 offer_not_claimable`. */
  readonly takes?: readonly (RunPackage | 'refused')[];
  /** The projects `GET claim-scope` lists (WP-293). */
  readonly scopeProjects?: readonly { id: string; key: string; name: string }[];
  /** The handshake's answer by number (from 1); absent is the worker's settings (WP-294 (6)). */
  readonly handshake?: (n: number) => { readonly status: number; readonly body: unknown } | null;
  /** `device/token`'s answer by poll number (from 1); absent is `authorization_pending`. */
  readonly deviceToken?: (n: number) => { readonly status: number; readonly body: unknown } | null;
}) => {
  const captured: Captured[] = [];
  const events: string[] = [];
  /** Commands the next beat delivers — what a recorded `run_commands` row is (WP-292's cancel). */
  const pendingCommands: { id: string; kind: 'cancel'; payload: Record<string, never> }[] = [];
  const claims = [...(options.claims ?? [])];
  const takes = [...(options.takes ?? [])];
  let claimProjectIds: string[] | null = null;
  let manuallyPausedAt: string | null = null;
  /** Approvals opened and not yet delivered: the next beat answers each `deny`, once. */
  const opened: string[] = [];
  let beats = 0;
  let uploads = 0;
  let handshakes = 0;
  let devices = 0;
  let polls = 0;
  const fetch: CoreFetch = async (url, init) => {
    const verb = new URL(url).pathname.replace('/api/worker/v1/', '').replace(RUN_ID, ':id');
    const headers = init.headers as Record<string, string>;
    const body = String(init.body ?? '');
    captured.push({ verb, headers, body });
    // A `GET` sends no body (WP-293's reads).
    const parsed = (body === '' ? {} : JSON.parse(body)) as Record<string, unknown>;
    const method = init.method ?? 'POST';
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
        if (pendingCommands.length > 0) {
          return answer(200, {
            lease_expires_at: '2026-11-05T10:10:00.000Z',
            commands: pendingCommands.splice(0),
            approvals: [],
          });
        }
        if (opened.length > 0) {
          return answer(200, {
            lease_expires_at: '2026-11-05T10:10:00.000Z',
            commands: [],
            approvals: opened.splice(0).map((approval_id) => ({
              approval_id,
              decision: 'deny',
              reason: 'denied on the core',
              question_id: null,
            })),
          });
        }
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
      case 'runs/:id/transcript': {
        workerTranscriptRequestSchema.parse(parsed);
        uploads += 1;
        const scripted = options.transcript?.(uploads) ?? null;
        if (scripted !== null) return answer(scripted.status, scripted.body);
        return answer(200, {
          stored: (parsed.entries as unknown[]).length,
          refused_seqs: [],
        });
      }
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
      case 'runs/:id/release':
        workerRunReleaseRequestSchema.parse(parsed);
        events.push('core:release');
        return answer(204, null);
      case 'pause':
        workerPauseRequestSchema.parse(parsed);
        events.push('core:pause');
        return answer(204, null);
      case 'runs/:id/approvals':
        workerApprovalRequestSchema.parse(parsed);
        opened.push(APPROVAL_ID);
        return answer(200, { approval_id: APPROVAL_ID });
      case 'device': {
        devices += 1;
        // A new code each time: `BCDF-GHJ<n>` over the alphabet.
        const letter = 'BCDFGHJKLM'.charAt(devices % 10);
        return answer(200, {
          device_code: `${'d'.repeat(42)}${letter}`,
          user_code: `BCDF-GHJ${letter}`,
          verification_uri: 'https://core.example.test/workers/approve',
          interval: 5,
          expires_in: 600,
        });
      }
      case 'device/token': {
        polls += 1;
        const scripted = options.deviceToken?.(polls) ?? null;
        if (scripted !== null) return answer(scripted.status, scripted.body);
        return answer(400, { error: 'authorization_pending' });
      }
      case 'handshake':
        {
          workerHandshakeRequestSchema.parse(parsed);
          handshakes += 1;
          const scripted = options.handshake?.(handshakes) ?? null;
          if (scripted !== null) return answer(scripted.status, scripted.body);
        }
        return answer(200, {
          protocol: {
            current: WORKER_PROTOCOL_VERSION,
            accepted: [WORKER_PROTOCOL_VERSION - 1, WORKER_PROTOCOL_VERSION],
          },
          digests: {
            platform: DIGEST,
            platform_launcher: DIGEST,
            platform_runtime: DIGEST,
            platform_egress: DIGEST,
          },
          compose_bundle_digest: 'e'.repeat(64),
          worker: {
            id: WORKER_ID,
            name: 'alice-laptop',
            concurrency: 1,
            paused_until: null,
            paused_reason: null,
            manually_paused_at: manuallyPausedAt,
            claim_project_ids: claimProjectIds,
          },
          server_time: '2026-11-05T10:00:00.000Z',
        });
      case 'claim-scope': {
        if (method === 'PUT') {
          const request = workerClaimScopeRequestSchema.parse(parsed);
          const next = request.claim_project_ids === null ? null : [...request.claim_project_ids];
          const performed = JSON.stringify(next) !== JSON.stringify(claimProjectIds);
          claimProjectIds = next;
          return answer(200, { claim_project_ids: claimProjectIds, performed });
        }
        return answer(200, {
          claim_project_ids: claimProjectIds,
          projects: options.scopeProjects ?? [],
        });
      }
      case 'offers':
        return answer(200, { offers: options.offers ?? [] });
      case 'offers/:id/claim': {
        workerOfferClaimRequestSchema.parse(parsed);
        const next = takes.shift() ?? 'refused';
        return next === 'refused'
          ? answer(409, {
              error: { code: 'offer_not_claimable', message: 'this offer cannot be taken' },
            })
          : answer(200, next);
      }
      case 'claims': {
        workerClaimRequestSchema.parse(parsed);
        const next = claims.shift();
        if (next !== undefined) return answer(200, next);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return answer(204, null);
      }
      case 'manual-pause': {
        const { paused } = workerManualPauseRequestSchema.parse(parsed);
        const performed = (manuallyPausedAt !== null) !== paused;
        if (performed) manuallyPausedAt = paused ? '2026-11-05T10:05:00.000Z' : null;
        return answer(200, { manually_paused_at: manuallyPausedAt, performed });
      }
      case 'runs/:id/cancel': {
        workerRunCancelRequestSchema.parse(parsed);
        const commandId = '00000000-0000-4000-8000-0000000029c1';
        pendingCommands.push({ id: commandId, kind: 'cancel', payload: {} });
        return answer(202, {
          run_id: RUN_ID,
          task_id: TASK_ID,
          status: 'running',
          task_state: 'paused',
          performed: true,
          command_id: commandId,
        });
      }
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
          workdir: LAUNCHER_WORKDIR,
        },
        claudeCodePath: LAUNCHER_CLI,
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
  readonly askApproval?: boolean;
  readonly monotonic?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The scripted CLI; absent is {@link script}'s. */
  readonly script?: runnerAdapters.FakeCliScript;
  /** WP-285: the worker's usage pause, asked before the spawn call. */
  readonly usagePausedUntil?: () => string | null;
  readonly onUsageLimit?: (limit: { readonly resetsAt: string | null }) => void;
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
    ...(options.usagePausedUntil === undefined
      ? {}
      : { usagePausedUntil: options.usagePausedUntil }),
    ...(options.onUsageLimit === undefined ? {} : { onUsageLimit: options.onUsageLimit }),
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
          cli = runnerAdapters.fakeSpawnClaudeCodeProcess(
            options.script ?? script(options.awaitSteers, options.askApproval),
            {
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
            },
          );
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

  it('reads APP_WORKER_USAGE_PAUSE_DEFAULT in seconds, an hour by default, refusing one outside a minute to eight days (WP-285)', () => {
    expect(loadRemoteWorkerConfig(base).usagePauseDefaultMs).toBe(3_600_000);
    expect(
      loadRemoteWorkerConfig({ ...base, APP_WORKER_USAGE_PAUSE_DEFAULT: '900' })
        .usagePauseDefaultMs,
    ).toBe(900_000);
    for (const bad of ['59', '691201', '1h', '-5']) {
      expect(() =>
        loadRemoteWorkerConfig({ ...base, APP_WORKER_USAGE_PAUSE_DEFAULT: bad }),
      ).toThrow(/APP_WORKER_USAGE_PAUSE_DEFAULT/);
    }
  });

  it('refuses a missing launcher by name, and starts with no core URL and no Claude token — the wizard asks (WP-294 (1))', () => {
    expect(() => loadRemoteWorkerConfig({})).toThrow(/APP_LAUNCHER_URL is required/);
    expect(() => loadRemoteWorkerConfig({})).not.toThrow(/APP_CORE_URL|CLAUDE_CODE_OAUTH_TOKEN/);
    const config = loadRemoteWorkerConfig({
      ...base,
      APP_CORE_URL: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    });
    // An empty value counts as absent (TD-031's first-run amendment §1).
    expect(config.coreUrl).toBeNull();
    expect(config.claudeToken).toBeNull();
    expect(config.coreCandidates).toEqual([]);
    expect(config.claudeCliPath).toBe('/opt/claude-cli/claude');
    expect(
      loadRemoteWorkerConfig({
        ...base,
        APP_WORKER_CORE_CANDIDATES: 'https://core.example.test/x, http://localhost:3000',
      }).coreCandidates,
    ).toEqual(['https://core.example.test', 'http://localhost:3000']);
    // `http:` only to this machine, and no userinfo — named, never silently dropped.
    for (const refused of ['http://core.example.test', 'https://u:p@core.example.test']) {
      expect(() =>
        loadRemoteWorkerConfig({ ...base, APP_WORKER_CORE_CANDIDATES: refused }),
      ).toThrow(/APP_WORKER_CORE_CANDIDATES has/);
    }
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

    // Backlog 695: the CLI runs where this worker's launcher said — its checkout and its run image's
    // binary — never the core's planned `workspacePath`/`claudeCodePath` from the package.
    const spawned = cli()?.spawnOptions;
    expect(runPackage().run.workspacePath).not.toBe(LAUNCHER_WORKDIR);
    expect(spawned?.cwd).toBe(LAUNCHER_WORKDIR);
    expect(JSON.stringify([spawned?.command, ...(spawned?.args ?? [])])).toContain(LAUNCHER_CLI);
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

  it('stops the run when the core holds no more of its transcript (transcript_full, backlog 754)', async () => {
    const core = fakeCore({
      transcript: () => ({
        status: 409,
        body: { error: { code: 'transcript_full', message: 'at most 100000 entries' } },
      }),
    });
    // The CLI waits for a steer that never comes: only the refusal can end the run.
    const { session } = run({ core, awaitSteers: 1 });
    const bounded = await Promise.race([
      session.done,
      new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), 5_000)),
    ]);
    expect(bounded).toBe('settled');
    // Settled through `finish`, as a cancel, after one refused upload and no second one.
    const finish = core.captured.find((request) => request.verb === 'runs/:id/finish');
    expect(workerFinishRequestSchema.parse(JSON.parse(finish?.body ?? '{}')).outcome).toMatchObject(
      {
        kind: 'ran',
        status: 'cancelled',
      },
    );
    expect(core.captured.filter((request) => request.verb === 'runs/:id/transcript')).toHaveLength(
      1,
    );
  });

  it('self-terminates at exactly TTL − ½·renew (585 s) without a renewal — not a millisecond before — and pushes nothing more', async () => {
    // The claim's answer is the session's first renewal, read at monotonic 0.
    let now = 0;
    const core = fakeCore({
      beat: () => ({ status: 503, body: { error: { code: 'unavailable', message: 'deploying' } } }),
    });
    const { session } = run({
      core,
      awaitSteers: 1,
      monotonic: () => now,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
    now = 584_999;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(session.state.ending).toBeNull();
    now = 585_000;
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

/**
 * WP-285 (TD-031 decision 11 as amended 2026-11-04): a usage limit is observable only after the
 * CLI spawned, so a rejection is **always** the mid-run branch — `finish` with `rate_limited`,
 * never a release. A release with `usage_limited` is only for a worker that already knew it was
 * paused when it reached the spawn call.
 */
describe('a usage limit on a remote run (WP-285)', () => {
  it('a rejection after the spawn marker never takes the release path: it finishes rate_limited and pauses', async () => {
    const core = fakeCore({});
    const limits: { resetsAt: string | null }[] = [];
    const { session } = run({
      core,
      script: limitedScript(30 * 60_000),
      onUsageLimit: (limit) => limits.push(limit),
    });
    expect(await session.done).toBe('settled');
    expect(core.events).toContain('core:spawn');
    expect(core.events).not.toContain('core:release');
    expect(core.captured.some((request) => request.verb === 'runs/:id/release')).toBe(false);
    const finish = workerFinishRequestSchema.parse(
      JSON.parse(core.captured.find((request) => request.verb === 'runs/:id/finish')?.body ?? '{}'),
    );
    expect(finish.outcome).toMatchObject({
      kind: 'ran',
      status: 'failed',
      terminal_reason: 'rate_limited',
    });
    // The worker is told when the limit resets, so it can pause — before its finish.
    expect(limits).toHaveLength(1);
    expect(Date.parse(limits[0]?.resetsAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('a worker already paused at its spawn call hands the run back unspent: release usage_limited, no CLI, no finish', async () => {
    const core = fakeCore({});
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const { session, cli } = run({ core, usagePausedUntil: () => until });
    expect(await session.done).toBe('released');
    const release = workerRunReleaseRequestSchema.parse(
      JSON.parse(
        core.captured.find((request) => request.verb === 'runs/:id/release')?.body ?? '{}',
      ),
    );
    expect(release).toEqual({ epoch: 3, reason: 'usage_limited', resets_at: until });
    expect(core.events).not.toContain('core:spawn');
    expect(core.events).not.toContain('cli:spawned');
    expect(core.events).not.toContain('core:finish');
    expect(cli()?.spawnOptions ?? null).toBeNull();
  });

  it('a pause that has already passed is no pause: the run starts', async () => {
    const core = fakeCore({});
    const past = new Date(Date.now() - 1_000).toISOString();
    const { session } = run({ core, usagePausedUntil: () => past });
    expect(await session.done).toBe('settled');
    expect(core.events).not.toContain('core:release');
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

describe('every body a worker sends passes its exact-value guard (WP-283 (2))', () => {
  /** A token planted deep — in a value, a nested array and a key — of a body of each verb's shape. */
  const planted = (extra: Record<string, unknown>): Record<string, unknown> => ({
    epoch: 3,
    ...extra,
    deep: [{ note: `x ${CLAUDE_TOKEN} y`, [CLAUDE_TOKEN]: { again: [CLAUDE_TOKEN] } }],
  });
  const VERBS: readonly [keyof RunScopedClient, Record<string, unknown>][] = [
    ['heartbeat', planted({ acks: [] })],
    ['transcript', planted({ entries: [{ seq: 1, event: { text: CLAUDE_TOKEN } }] })],
    ['tool', planted({ tool_use_id: 'u1', input: { query: CLAUDE_TOKEN } })],
    ['approval', planted({ detail: CLAUDE_TOKEN, input: { [CLAUDE_TOKEN]: 1 } })],
    ['sshSign', planted({ key_blob: 'AAAA', data: 'AAAA', flags: 0 })],
    ['spawn', planted({})],
    ['release', planted({ reason: 'shutdown' })],
    // The error bodies: a run's error text and a start failure's own words.
    [
      'finish',
      planted({
        outcome: { kind: 'not_started', failure: 'x', detail: `launcher said ${CLAUDE_TOKEN}` },
        error: `${CLAUDE_TOKEN} in an error`,
      }),
    ],
    ['lateCost', planted({ session_id: CLAUDE_TOKEN })],
    // WP-292: the local page's cancel carries a person's reason.
    ['cancel', planted({ reason: `stop it ${CLAUDE_TOKEN}` })],
  ];

  it('names all ten run verbs', () => {
    const client = createCoreClient({ baseUrl: 'https://core.example.test' }).forRun(
      RUN_ID,
      RUN_TOKEN,
    );
    expect(VERBS.map(([verb]) => verb).sort()).toEqual(Object.keys(client).sort());
  });

  it.each(VERBS)(
    '%s: no token in the body it sends, first attempt and retry alike',
    async (verb, body) => {
      const sent: string[] = [];
      let attempts = 0;
      const record = async (payload: unknown) => {
        sent.push(JSON.stringify(payload));
        attempts += 1;
        // The first attempt fails as a network failure does, so the retry's body is seen too.
        if (attempts === 1) throw new CoreCallError('transient', 503, null, 'down');
        return {} as never;
      };
      const inner: RunScopedClient = {
        heartbeat: record,
        transcript: record,
        tool: (_name, payload) => record(payload),
        approval: record,
        sshSign: record,
        spawn: record,
        release: record,
        finish: record,
        lateCost: record,
        cancel: (payload) => record(payload),
      };
      const guarded = guardedRunClient(
        inner,
        workerSecretRedactor({
          claudeToken: CLAUDE_TOKEN,
          runToken: RUN_TOKEN,
          runCredential: null,
        }),
      );
      const send = (): Promise<unknown> =>
        verb === 'tool'
          ? guarded.tool('kb_search', body)
          : verb === 'cancel'
            ? guarded.cancel(body, 'local-ui-cancel-key-1')
            : (guarded[verb] as (payload: unknown) => Promise<unknown>)(body);
      await retrying(send, { giveUp: () => false, sleep: async () => {} });
      expect(sent).toHaveLength(2);
      for (const text of sent) {
        expect(text).not.toContain(CLAUDE_TOKEN);
        expect(text).toContain('[REDACTED:integration:claude_code_oauth_token]');
      }
    },
  );

  it('redacts object keys as well as values, keeping two keys that redact alike', () => {
    const redactor = workerSecretRedactor({
      claudeToken: CLAUDE_TOKEN,
      runToken: RUN_TOKEN,
      runCredential: RUN_CREDENTIAL,
    });
    const out = redactKeysAndValues(redactor, {
      [CLAUDE_TOKEN]: 1,
      // Already the placeholder: the token's key redacts to this one, and both are kept.
      '[REDACTED:integration:claude_code_oauth_token]': 1,
      nested: { [RUN_CREDENTIAL]: [CLAUDE_TOKEN] },
      [`x${CLAUDE_TOKEN}`]: 2,
      [`x${RUN_TOKEN}`]: 3,
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(CLAUDE_TOKEN);
    expect(text).not.toContain(RUN_CREDENTIAL);
    expect(text).not.toContain(RUN_TOKEN);
    expect(Object.keys(out as object)).toHaveLength(5);
    expect(Object.keys(out as object)).toContain(
      '[REDACTED:integration:claude_code_oauth_token]#2',
    );
  });
});

describe('the worker’s tool port (TD-031 §10b; backlog 752)', () => {
  const context = (progress?: RunProgressRecorder): PlatformToolContext => ({
    runId: RUN_ID as never,
    taskId: TASK_ID as never,
    projectId: PROJECT_ID as never,
    mode: 'normal',
    signal: new AbortController().signal,
    ...(progress === undefined ? {} : { progress }),
  });
  const port = (tool: RunScopedClient['tool']) =>
    createRemoteToolPort({
      core: { tool } as RunScopedClient,
      epoch: 3,
      redactor: workerSecretRedactor({
        claudeToken: CLAUDE_TOKEN,
        runToken: RUN_TOKEN,
        runCredential: null,
      }),
      call: (_what, send) => retrying(send, { giveUp: () => false, sleep: async () => {} }),
      sleep: async () => {},
      giveUp: () => false,
    });

  it('asks the core again after a 503 under the same tool_use_id, and sends no token', async () => {
    const bodies: { tool_use_id: string; input: unknown }[] = [];
    const tools = port(async (name, body) => {
      expect(name).toBe('open_mr');
      bodies.push(body as { tool_use_id: string; input: unknown });
      if (bodies.length === 1) throw new CoreCallError('transient', 503, null, 'deploying');
      return { result: { status: 'opened', iid: 7 }, is_error: false };
    });
    const answer = await tools.openMergeRequest(
      { title: 'a change', description: `see ${CLAUDE_TOKEN}` },
      context(),
    );
    expect(answer).toEqual({ status: 'opened', iid: 7 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.tool_use_id).toBe(bodies[1]?.tool_use_id);
    expect(JSON.stringify(bodies)).not.toContain(CLAUDE_TOKEN);
    // A second call of the tool is a second call: a fresh id.
    await tools.openMergeRequest({ title: 'b', description: 'c' }, context());
    expect(bodies[2]?.tool_use_id).not.toBe(bodies[0]?.tool_use_id);
  });

  it('answers report_progress from the runner’s own door and asks the core nothing (backlog 752)', async () => {
    const asked: string[] = [];
    const recorded: unknown[] = [];
    const tools = port(async (name) => {
      asked.push(name);
      return { result: 'unused', is_error: false };
    });
    const answer = await tools.reportProgress(
      { summary: 'wrote the totals test' },
      context({
        record: async (report: unknown) => {
          recorded.push(report);
          return { recorded: true };
        },
      } as unknown as RunProgressRecorder),
    );
    expect(asked).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(typeof answer).toBe('string');
  });
});

describe('an approval the runner asks for, through the core (TD-031 §9)', () => {
  it('opens it with no token in its body and hands the model the decision the heartbeat delivered', async () => {
    const core = fakeCore({});
    const { session, cli } = run({ core, askApproval: true });
    expect(await session.done).toBe('settled');
    const opened = core.captured.filter((request) => request.verb === 'runs/:id/approvals');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.body).not.toContain(CLAUDE_TOKEN);
    expect(opened[0]?.body).toContain('[REDACTED:integration:claude_code_oauth_token]');
    expect(JSON.stringify(cli()?.callbacks)).toContain('denied on the core');
  });
});

describe('a run’s tail for the local page (WP-292 (2))', () => {
  it('keeps the entries as uploaded — no Claude token, no run credential — and the reported tokens and cost', async () => {
    const core = fakeCore({});
    const { session } = run({ core });
    expect(await session.done).toBe('settled');
    const tail = JSON.stringify(session.state.tail);
    expect(session.state.tail.length).toBeGreaterThan(0);
    // The scripted model echoed both; the tail is what left for the core, redacted.
    expect(tail).not.toContain(CLAUDE_TOKEN);
    expect(tail).not.toContain(RUN_CREDENTIAL);
    expect(tail).toContain('[REDACTED:integration:');
    expect(session.state.tokens).toBe(15);
    expect(session.state.tokensFinal).toBe(true);
    expect(session.state.costUsd).toBe(0.25);
  });

  it('counts tokens so far from each model turn before the result arrives (backlog 772)', async () => {
    const core = fakeCore({});
    // The CLI waits for a user turn after its assistant message, so the result has not arrived.
    const { session } = run({ core, awaitSteers: 1 });
    for (let tries = 0; tries < 200 && session.state.tokens === null; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(session.state.tokens).toBe(15);
    expect(session.state.tokensFinal).toBe(false);
    expect(session.state.costUsd).toBeNull();
    session.shutdown();
    await session.done;
  });
});

describe('the worker’s local page (WP-292 (1), (2), (4), (5))', () => {
  /** A web bundle with the page and one asset, as the image's `apps/web/dist` carries them. */
  const webRoot = (): string => {
    const root = mkdtempSync(path.join(scratch, 'web-'));
    writeFileSync(path.join(root, 'worker.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><p>the SPA</p>');
    writeFileSync(path.join(root, '.env'), 'NOT_SERVED=1');
    mkdirSync(path.join(root, 'assets'));
    writeFileSync(path.join(root, 'assets', 'worker-abc.js'), 'console.log(1)');
    return root;
  };
  const PUBLISHED = 7357;

  /** One raw request, with the `Host` and headers a browser (or an attacker) would send. */
  const request = (
    port: number,
    input: {
      readonly method?: string;
      readonly path: string;
      readonly host?: string;
      readonly headers?: Record<string, string>;
      readonly body?: unknown;
    },
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> =>
    new Promise((resolve, reject) => {
      const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
      const outgoing = http.request(
        {
          host: '127.0.0.1',
          port,
          method: input.method ?? 'GET',
          path: input.path,
          headers: {
            host: input.host ?? `127.0.0.1:${PUBLISHED}`,
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            ...input.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(payload);
    });

  const until = async (what: string, check: () => boolean): Promise<void> => {
    for (let tries = 0; tries < 1_000; tries += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const start = async (options: {
    readonly stateDir: string;
    readonly core: ReturnType<typeof fakeCore>;
    readonly ui?: boolean;
    /** The scripted CLI of every run; absent waits for a steer (`script(1)`). */
    readonly script?: () => runnerAdapters.FakeCliScript;
    readonly auth?: 'none' | 'token';
    /** `null`: the wizard's platform step (WP-294); absent is the core. */
    readonly coreUrl?: string | null;
    /** `null`: the wizard's Claude step (WP-294); absent is the planted token. */
    readonly claudeToken?: string | null;
    readonly claudeCli?: ClaudeCliLauncher;
    readonly probeFetch?: CoreFetch;
    readonly sleep?: (ms: number) => Promise<void>;
    /** The launcher's health check (default: it answers, holding the run and egress images). */
    readonly health?: () => Promise<unknown>;
  }) => {
    const lines: string[] = [];
    const launcher = fakeLauncher(options.core.events);
    const worker = await startRemoteWorker({
      ...(options.claudeCli === undefined ? {} : { claudeCli: options.claudeCli }),
      ...(options.probeFetch === undefined ? {} : { probeFetch: options.probeFetch }),
      config: {
        coreUrl: options.coreUrl === undefined ? 'https://core.example.test' : options.coreUrl,
        claudeToken: options.claudeToken === undefined ? CLAUDE_TOKEN : options.claudeToken,
        coreCandidates: [],
        launcherUrl: 'http://launcher:7780',
        launcherToken: 'FAKE-launcher-token-000000000000000000',
        controlRoot: scratch,
        stateDir: options.stateDir,
        concurrency: 1,
        imageDigests: [DIGEST],
        host: '127.0.0.1',
        port: 0,
        logLevel: 'info',
        commit: null,
        ui: {
          enabled: options.ui ?? true,
          host: '127.0.0.1',
          listenPort: 0,
          publishedPort: PUBLISHED,
          auth: options.auth ?? 'token',
        },
        platformImageDigest: DIGEST,
      },
      coreFetch: options.core.fetch,
      launcher: {
        ...(launcher.client as object),
        health: options.health ?? (async () => ({ images: { run: DIGEST, egress: DIGEST } })),
      } as unknown as launcherAdapters.LauncherControlClient,
      spawnFor: () => {
        const cli = runnerAdapters.fakeSpawnClaudeCodeProcess(options.script?.() ?? script(1), {
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
            uuid: '00000005-0000-4000-8000-000000000000',
            session_id: 'fake-session-wp283',
          },
        });
        return cli.spawn;
      },
      logDestination: { write: (line: string) => lines.push(line) },
      webRoot: webRoot(),
      sleep: options.sleep ?? (async () => {}),
    });
    const internal = await worker.listen();
    return { worker, lines, internal };
  };

  const stateDirWithCredential = (): string => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    writeFileSync(path.join(stateDir, 'credential'), `${WORKER_CREDENTIAL}\n`, { mode: 0o600 });
    return stateDir;
  };

  const portOf = (address: string | null): number => Number(new URL(address ?? '').port);

  it('serves the page behind its token, Host and Origin checks; shows the run with no secret in it; and cancels through the core', async () => {
    const stateDir = stateDirWithCredential();
    const pkg = runPackageSchema.parse({
      ...runPackage(),
      display: { projectKey: 'ACME', ticketKey: 'ACME-7', title: 'Fix the login page' },
    });
    const core = fakeCore({ claims: [pkg] });
    const { worker, lines } = await start({ stateDir, core });
    try {
      const port = portOf(worker.uiAddress());
      // (1) The token: created once 0600, logged once as a fragment, on stdout only.
      const tokenFile = path.join(stateDir, UI_TOKEN_FILE);
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      const token = readFileSync(tokenFile, 'utf8').trim();
      const announced = lines.filter((line) => line.includes(token));
      expect(announced).toHaveLength(1);
      expect(announced[0]).toContain(`http://127.0.0.1:${PUBLISHED}/#token=${token}`);
      const auth = { authorization: `Bearer ${token}` };

      await until('the run is running', () =>
        [...worker.sessions.values()].some(
          (session) => session.state.phase === 'running' && session.state.tail.length >= 2,
        ),
      );
      // Planted in a log line too: the log tail is redacted by the same values.
      worker.logger.info(
        { planted: `${CLAUDE_TOKEN} ${RUN_CREDENTIAL} ${token} ${WORKER_CREDENTIAL}` },
        'a line that carries every secret',
      );

      const answers: { status: number; headers: http.IncomingHttpHeaders }[] = [];
      const ask = async (input: Parameters<typeof request>[1]) => {
        const answer = await request(port, input);
        answers.push(answer);
        return answer;
      };
      // 401: no bearer, a wrong one.
      expect((await ask({ path: '/api/local/state' })).status).toBe(401);
      expect(
        (
          await ask({
            path: '/api/local/state',
            headers: { authorization: `Bearer ${'x'.repeat(43)}` },
          })
        ).status,
      ).toBe(401);
      // 421: a foreign Host, and the right name on the wrong port — even with the token.
      for (const host of [
        'evil.example.test',
        `evil.example.test:${PUBLISHED}`,
        '127.0.0.1:9',
        '',
      ]) {
        expect((await ask({ path: '/api/local/state', host, headers: auth })).status, host).toBe(
          421,
        );
      }
      // The three names it does answer to.
      for (const host of [
        `localhost:${PUBLISHED}`,
        `127.0.0.1:${PUBLISHED}`,
        `[::1]:${PUBLISHED}`,
      ]) {
        expect((await ask({ path: '/api/local/state', host, headers: auth })).status, host).toBe(
          200,
        );
      }
      // 403: a mutation with no Origin, or a foreign one — with the token.
      for (const origin of [
        undefined,
        'https://evil.example.test',
        `http://localhost:${PUBLISHED}`,
      ]) {
        const refused = await ask({
          method: 'POST',
          path: '/api/local/pause',
          headers: { ...auth, ...(origin === undefined ? {} : { origin }) },
          body: { paused: true },
        });
        expect(refused.status, String(origin)).toBe(403);
      }
      expect(core.captured.some((call) => call.verb === 'manual-pause')).toBe(false);

      // (2) The view, and no secret on it.
      const state = await ask({ path: '/api/local/state', headers: auth });
      const parsed = workerLocalStateSchema.parse(JSON.parse(state.text));
      expect(parsed).toMatchObject({
        worker_id: WORKER_ID,
        worker_name: 'alice-laptop',
        connection: 'connected',
        protocol: WORKER_PROTOCOL_VERSION,
        manually_paused_at: null,
        draining: false,
        launcher: 'ok',
        update_pending: false,
        concurrency: 1,
      });
      expect(parsed.runs).toHaveLength(1);
      expect(parsed.runs[0]).toMatchObject({
        run_id: RUN_ID,
        project_key: 'ACME',
        ticket_key: 'ACME-7',
        title: 'Fix the login page',
        role: pkg.run.role,
        phase: 'running',
        // The model's one turn so far (backlog 772); no result yet, so no cost.
        tokens: 15,
        cost_usd: null,
      });
      expect(parsed.runs[0]?.transcript.length).toBeGreaterThan(0);
      expect(parsed.logs.some((line) => line.includes('a line that carries every secret'))).toBe(
        true,
      );
      for (const secret of [CLAUDE_TOKEN, RUN_CREDENTIAL, RUN_TOKEN, token, WORKER_CREDENTIAL]) {
        expect(state.text).not.toContain(secret);
      }
      // The static half: the page and its asset; nothing else of the bundle.
      expect((await ask({ path: '/' })).text).toContain('<div id="root">');
      expect((await ask({ path: '/assets/worker-abc.js' })).status).toBe(200);
      for (const refused of [
        '/index.html',
        '/.env',
        '/assets/../index.html',
        '/assets/%2e%2e/.env',
      ]) {
        expect((await ask({ path: refused })).status, refused).toBe(404);
      }

      // (5) Cancel: asked of the core with a key, delivered on this worker's heartbeat.
      const origin = { origin: `http://127.0.0.1:${PUBLISHED}` };
      expect(
        (
          await ask({
            method: 'POST',
            path: `/api/local/runs/${RUN_ID}/cancel`,
            headers: { ...auth, ...origin },
            body: {},
          })
        ).status,
      ).toBe(400);
      const cancelled = await ask({
        method: 'POST',
        path: `/api/local/runs/${RUN_ID}/cancel`,
        headers: { ...auth, ...origin, 'idempotency-key': 'page-cancel-1' },
        body: { reason: 'leaving' },
      });
      expect(cancelled.status).toBe(200);
      expect(JSON.parse(cancelled.text)).toEqual({
        run_id: RUN_ID,
        accepted: true,
        task_state: 'paused',
      });
      const asked = core.captured.find((call) => call.verb === 'runs/:id/cancel');
      expect(asked?.headers['idempotency-key']).toBe('page-cancel-1');
      expect(asked?.headers.authorization).toBe(`Bearer ${RUN_TOKEN}`);
      await until('the run ends', () => worker.sessions.size === 0);
      const finish = core.captured.find((call) => call.verb === 'runs/:id/finish');
      const finished = workerFinishRequestSchema.parse(JSON.parse(finish?.body ?? '{}'));
      expect(finished.stop_reason).toBe('cancelled');
      expect(finished.outcome).toMatchObject({ kind: 'ran', status: 'cancelled' });
      const acks = core.captured
        .filter((call) => call.verb === 'runs/:id/heartbeat')
        .flatMap((call) => workerHeartbeatRequestSchema.parse(JSON.parse(call.body)).acks);
      expect(acks).toContainEqual({
        command_id: '00000000-0000-4000-8000-0000000029c1',
        outcome: 'applied',
      });

      // (4) Pause and resume: the core's manual-pause, and the page reads it back.
      const paused = await ask({
        method: 'POST',
        path: '/api/local/pause',
        headers: { ...auth, ...origin },
        body: { paused: true },
      });
      expect(paused.status).toBe(200);
      expect(
        workerLocalStateSchema.parse(JSON.parse(paused.text)).manually_paused_at,
      ).not.toBeNull();
      const resumed = await ask({
        method: 'POST',
        path: '/api/local/pause',
        headers: { ...auth, ...origin },
        body: { paused: false },
      });
      expect(workerLocalStateSchema.parse(JSON.parse(resumed.text)).manually_paused_at).toBeNull();
      expect(
        core.captured
          .filter((call) => call.verb === 'manual-pause')
          .map((call) => JSON.parse(call.body)),
      ).toEqual([
        { paused: true, via: 'worker_ui' },
        { paused: false, via: 'worker_ui' },
      ]);

      // Every answer: no CORS header, no cookie, and the security headers.
      for (const answer of answers) {
        expect(
          Object.keys(answer.headers).filter((name) => name.startsWith('access-control-')),
        ).toEqual([]);
        expect(answer.headers['set-cookie']).toBeUndefined();
        expect(answer.headers['cache-control']).toBe('no-store');
        expect(answer.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(answer.headers['x-content-type-options']).toBe('nosniff');
      }
      // Nothing secret reached the core either (the reason travelled redacted).
      expect(JSON.stringify(core.captured.map((call) => call.body))).not.toContain(CLAUDE_TOKEN);
    } finally {
      await worker.stop();
    }
  });

  /**
   * WP-293 (5): the scope editor and *Take this one* through `/api/local/claim-scope`,
   * `/api/local/offers` and `/api/local/offers/:id/take`, under WP-292's bearer, `Host` and `Origin`
   * rules; a credential planted in an offer's title is not on the page; a take starts the run here
   * and a second one, with no slot free, is refused before the core is asked.
   */
  it('lists, takes and sets the claim scope behind the page’s checks, with no secret on an offer', async () => {
    const stateDir = stateDirWithCredential();
    const OFFER = {
      run_id: RUN_ID,
      kind: 'stage',
      project_key: 'ACME',
      ticket_key: 'ACME-7',
      title: `Fix the login page ${CLAUDE_TOKEN} ${WORKER_CREDENTIAL}`,
      stage: 'implementation',
      role: 'developer',
      offered_at: '2026-11-05T10:00:00.000Z',
      automatic: false,
    };
    const PROJECT = { id: PROJECT_ID, key: 'ACME', name: 'Acme storefront' };
    const core = fakeCore({
      offers: [OFFER],
      takes: ['refused', runPackage()],
      scopeProjects: [PROJECT],
    });
    const { worker } = await start({ stateDir, core });
    try {
      const port = portOf(worker.uiAddress());
      const token = readFileSync(path.join(stateDir, UI_TOKEN_FILE), 'utf8').trim();
      const auth = { authorization: `Bearer ${token}` };
      const origin = { origin: `http://127.0.0.1:${PUBLISHED}` };
      await until('the worker is connected', () => worker.state().connection === 'connected');
      const take = `/api/local/offers/${RUN_ID}/take`;
      // The page's rules hold on the new verbs: 401, 421, 403 — the core is asked nothing.
      expect((await request(port, { path: '/api/local/offers' })).status).toBe(401);
      expect((await request(port, { path: '/api/local/claim-scope' })).status).toBe(401);
      expect(
        (
          await request(port, {
            path: '/api/local/offers',
            host: 'evil.example.test',
            headers: auth,
          })
        ).status,
      ).toBe(421);
      for (const path_ of [take, '/api/local/claim-scope']) {
        for (const refused of [undefined, 'https://evil.example.test']) {
          const answer = await request(port, {
            method: 'POST',
            path: path_,
            headers: { ...auth, ...(refused === undefined ? {} : { origin: refused }) },
            body: path_ === take ? {} : { claim_project_ids: [] },
          });
          expect(`${path_} ${answer.status}`).toBe(`${path_} 403`);
        }
      }
      expect(
        core.captured.some(
          (call) => call.verb === 'offers/:id/claim' || call.verb === 'claim-scope',
        ),
      ).toBe(false);

      // The list, through the worker's exact-value redactor.
      const listed = await request(port, { path: '/api/local/offers', headers: auth });
      expect(listed.status).toBe(200);
      const offers = workerLocalOffersSchema.parse(JSON.parse(listed.text)).offers;
      expect(offers).toHaveLength(1);
      expect(offers[0]?.title).toContain('Fix the login page');
      for (const secret of [CLAUDE_TOKEN, WORKER_CREDENTIAL, token]) {
        expect(listed.text).not.toContain(secret);
      }
      expect(core.captured.find((call) => call.verb === 'offers')?.headers.authorization).toBe(
        `Bearer ${WORKER_CREDENTIAL}`,
      );

      // The scope: read, set to pick only through the core's PUT, read back.
      const read = await request(port, { path: '/api/local/claim-scope', headers: auth });
      expect(workerLocalClaimScopeSchema.parse(JSON.parse(read.text))).toEqual({
        claim_project_ids: null,
        projects: [PROJECT],
      });
      expect(
        (
          await request(port, {
            method: 'POST',
            path: '/api/local/claim-scope',
            headers: { ...auth, ...origin },
            body: { claim_project_ids: ['not-a-uuid'] },
          })
        ).status,
      ).toBe(400);
      const set = await request(port, {
        method: 'POST',
        path: '/api/local/claim-scope',
        headers: { ...auth, ...origin },
        body: { claim_project_ids: [] },
      });
      expect(set.status).toBe(200);
      expect(workerLocalClaimScopeSchema.parse(JSON.parse(set.text)).claim_project_ids).toEqual([]);
      const put = core.captured.find((call) => call.verb === 'claim-scope' && call.body !== '');
      expect(JSON.parse(put?.body ?? '{}')).toEqual({ claim_project_ids: [] });

      // A take the core refuses: its code, nothing started.
      const lost = await request(port, {
        method: 'POST',
        path: take,
        headers: { ...auth, ...origin },
        body: {},
      });
      expect(lost.status).toBe(409);
      expect(JSON.parse(lost.text).error.code).toBe('offer_not_claimable');
      expect(worker.sessions.size).toBe(0);
      // The take the core admits: the package runs here.
      const taken = await request(port, {
        method: 'POST',
        path: take,
        headers: { ...auth, ...origin },
        body: {},
      });
      expect(taken.status).toBe(200);
      expect(JSON.parse(taken.text)).toEqual({ run_id: RUN_ID });
      expect(worker.sessions.has(RUN_ID)).toBe(true);
      const picks = core.captured.filter((call) => call.verb === 'offers/:id/claim');
      expect(picks).toHaveLength(2);
      expect(workerOfferClaimRequestSchema.parse(JSON.parse(picks[1]?.body ?? '{}'))).toEqual({
        image_digests: [DIGEST],
      });
      // No slot left (concurrency 1): refused here, the core not asked again.
      const full = await request(port, {
        method: 'POST',
        path: take,
        headers: { ...auth, ...origin },
        body: {},
      });
      expect(full.status).toBe(409);
      expect(JSON.parse(full.text).error.code).toBe('no_free_slot');
      expect(core.captured.filter((call) => call.verb === 'offers/:id/claim')).toHaveLength(2);
    } finally {
      await worker.stop();
    }
  });

  /**
   * WP-285: a run its usage limit ended pauses the worker — `POST pause` with the reset, the local
   * page's *Paused — usage limit until …*, no claim while it holds — and when the reset passes it
   * claims again by itself. A person's hold is a different thing and is untouched.
   */
  it('pauses on a usage limit, tells the core, claims nothing until the reset, then claims again by itself', async () => {
    const stateDir = stateDirWithCredential();
    const pkg = runPackageSchema.parse({ ...runPackage() });
    const core = fakeCore({ claims: [pkg] });
    const RESET_IN_MS = 600;
    const { worker } = await start({ stateDir, core, script: () => limitedScript(RESET_IN_MS) });
    try {
      await until('the pause', () => core.events.includes('core:pause'));
      const pause = workerPauseRequestSchema.parse(
        JSON.parse(core.captured.find((call) => call.verb === 'pause')?.body ?? '{}'),
      );
      expect(pause).toMatchObject({ reason: 'usage_limited', estimated: false });
      expect(Date.parse(pause.until)).toBeGreaterThan(Date.now());
      // It paused before its finish, so the core's re-plan is not claimed back by this worker.
      expect(core.events.indexOf('core:pause')).toBeLessThan(core.events.indexOf('core:finish'));
      const state = worker.localState();
      expect(state.usage_paused_until).toBe(pause.until);
      expect(state.usage_paused_estimated).toBe(false);
      expect(state.manually_paused_at).toBeNull();
      // While it holds, no claim leaves this worker.
      const claimsAtPause = core.captured.filter((call) => call.verb === 'claims').length;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(pause.until) - Date.now() - 100)),
      );
      expect(core.captured.filter((call) => call.verb === 'claims').length).toBe(claimsAtPause);
      // The reset: it claims again by itself, and the page says it takes work.
      await until(
        'a claim after the reset',
        () => core.captured.filter((call) => call.verb === 'claims').length > claimsAtPause,
      );
      expect(worker.localState().usage_paused_until).toBeNull();
      expect(worker.localState().manually_paused_at).toBeNull();
    } finally {
      await worker.stop();
    }
  });

  /** WP-285: the end of a usage pause never lifts a person's hold — the two are separate pauses. */
  it('keeps a person’s Pause when the usage pause it was set during ends', async () => {
    const stateDir = stateDirWithCredential();
    const pkg = runPackageSchema.parse({ ...runPackage() });
    const core = fakeCore({ claims: [pkg] });
    const RESET_IN_MS = 600;
    const { worker } = await start({ stateDir, core, script: () => limitedScript(RESET_IN_MS) });
    try {
      await until('the usage pause', () => core.events.includes('core:pause'));
      const pause = workerPauseRequestSchema.parse(
        JSON.parse(core.captured.find((call) => call.verb === 'pause')?.body ?? '{}'),
      );
      await worker.setPaused(true);
      expect(worker.localState().manually_paused_at).not.toBeNull();
      const claimsAtHold = core.captured.filter((call) => call.verb === 'claims').length;
      // Past the limit's reset, and a little more.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(pause.until) - Date.now()) + 300),
      );
      expect(worker.localState().usage_paused_until).toBeNull();
      expect(worker.localState().manually_paused_at).not.toBeNull();
      expect(core.captured.filter((call) => call.verb === 'claims').length).toBe(claimsAtHold);
      // Nothing asked the core to lift the person's hold.
      const resumed = core.captured
        .filter((call) => call.verb === 'manual-pause')
        .map((call) => workerManualPauseRequestSchema.parse(JSON.parse(call.body)).paused);
      expect(resumed).toEqual([true]);
    } finally {
      await worker.stop();
    }
  });

  it('drains: claims nothing more and remembers it; the next start clears a drain’s pause — only a drain’s', async () => {
    const stateDir = stateDirWithCredential();
    const core = fakeCore({});
    const first = await start({ stateDir, core });
    const token = readFileSync(path.join(stateDir, UI_TOKEN_FILE), 'utf8').trim();
    const port = portOf(first.worker.uiAddress());
    await until('a claim', () => core.captured.some((call) => call.verb === 'claims'));
    const drained = await request(port, {
      method: 'POST',
      path: '/api/local/drain',
      headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${PUBLISHED}` },
      body: {},
    });
    expect(drained.status).toBe(202);
    expect(workerLocalStateSchema.parse(JSON.parse(drained.text))).toMatchObject({
      draining: true,
      manually_paused_at: '2026-11-05T10:05:00.000Z',
    });
    expect(existsSync(path.join(stateDir, DRAIN_MARKER_FILE))).toBe(true);
    expect(
      core.captured
        .filter((call) => call.verb === 'manual-pause')
        .map((call) => JSON.parse(call.body)),
    ).toEqual([{ paused: true, via: 'worker_ui_drain' }]);
    const claimsAtDrain = core.captured.filter((call) => call.verb === 'claims').length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(core.captured.filter((call) => call.verb === 'claims').length).toBe(claimsAtDrain);
    await first.worker.stop();

    // The next start: the drain's pause is cleared, the marker removed, and it claims again.
    const pausesBefore = core.captured.filter((call) => call.verb === 'manual-pause').length;
    const capturedBefore = core.captured.length;
    const second = await start({ stateDir, core });
    try {
      // The marker's removal is the last thing the clearing writes, after the core answered.
      await until(
        'the drain’s marker removed',
        () => !existsSync(path.join(stateDir, DRAIN_MARKER_FILE)),
      );
      expect(
        core.captured
          .slice(capturedBefore)
          .filter((call) => call.verb === 'manual-pause')
          .map((call) => JSON.parse(call.body)),
      ).toEqual([{ paused: false, via: 'worker_start' }]);
      const claimsBefore = core.captured.filter((call) => call.verb === 'claims').length;
      await until(
        'a claim after the restart',
        () => core.captured.filter((call) => call.verb === 'claims').length > claimsBefore,
      );
      // A token survives a restart (rotated only by deleting the file).
      expect(readFileSync(path.join(stateDir, UI_TOKEN_FILE), 'utf8').trim()).toBe(token);
      // An owner's pause is not a drain's: it survives the next start, untouched — and a Drain
      // pressed **after** it is no drain's pause either (review of PR #30: Pause → Drain → restart
      // once cleared the owner's hold), so it writes no marker and asks the core nothing.
      const port2 = portOf(second.worker.uiAddress());
      const owner = { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${PUBLISHED}` };
      await request(port2, {
        method: 'POST',
        path: '/api/local/pause',
        headers: owner,
        body: { paused: true },
      });
      const pausesAtHold = core.captured.filter((call) => call.verb === 'manual-pause').length;
      const drainedWhilePaused = await request(port2, {
        method: 'POST',
        path: '/api/local/drain',
        headers: owner,
        body: {},
      });
      expect(drainedWhilePaused.status).toBe(202);
      expect(workerLocalStateSchema.parse(JSON.parse(drainedWhilePaused.text)).draining).toBe(true);
      expect(core.captured.filter((call) => call.verb === 'manual-pause')).toHaveLength(
        pausesAtHold,
      );
      expect(existsSync(path.join(stateDir, DRAIN_MARKER_FILE))).toBe(false);
    } finally {
      await second.worker.stop();
    }
    const resumesBefore = core.captured.filter(
      (call) => call.verb === 'manual-pause' && JSON.parse(call.body).paused === false,
    ).length;
    const third = await start({ stateDir, core });
    try {
      await until('the handshake', () => third.worker.state().connection === 'connected');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        core.captured.filter(
          (call) => call.verb === 'manual-pause' && JSON.parse(call.body).paused === false,
        ),
      ).toHaveLength(resumesBefore);
      expect(third.worker.localState().manually_paused_at).not.toBeNull();
      const claims = core.captured.filter((call) => call.verb === 'claims').length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(core.captured.filter((call) => call.verb === 'claims').length).toBe(claims);
    } finally {
      await third.worker.stop();
    }
    expect(pausesBefore).toBeGreaterThan(0);
  });

  it('audits /internal/drain as worker_internal_drain and the page’s Drain as worker_ui_drain (TD-031 amendment)', async () => {
    const stateDir = stateDirWithCredential();
    const core = fakeCore({});
    const { worker, internal } = await start({ stateDir, core });
    try {
      await until('a claim', () => core.captured.some((call) => call.verb === 'claims'));
      const response = await fetch(`${internal}/internal/drain`, { method: 'POST' });
      expect(response.status).toBe(202);
      expect(
        core.captured
          .filter((call) => call.verb === 'manual-pause')
          .map((call) => JSON.parse(call.body)),
      ).toEqual([{ paused: true, via: 'worker_internal_drain' }]);
      expect(existsSync(path.join(stateDir, DRAIN_MARKER_FILE))).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it('opens no port and makes no token with APP_WORKER_UI=disabled', async () => {
    const stateDir = stateDirWithCredential();
    const core = fakeCore({});
    const { worker } = await start({ stateDir, core, ui: false });
    try {
      expect(worker.uiAddress()).toBeNull();
      expect(existsSync(path.join(stateDir, UI_TOKEN_FILE))).toBe(false);
    } finally {
      await worker.stop();
    }
  });

  it('reads APP_WORKER_UI and APP_WORKER_UI_PORT, refusing a value it does not know', () => {
    const base = {
      APP_CORE_URL: 'https://core.example.test',
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      APP_LAUNCHER_URL: 'http://launcher:7780',
      APP_LAUNCHER_TOKEN: 'FAKE-launcher-token-0000000000000000',
      APP_WORKSPACE_CONTROL_ROOT: '/run/agentic/ctl',
    };
    expect(loadRemoteWorkerConfig(base).ui).toEqual({
      enabled: true,
      host: '0.0.0.0',
      listenPort: 7357,
      publishedPort: 7357,
      // TD-031's no-bearer amendment: no token unless asked for.
      auth: 'none',
    });
    expect(loadRemoteWorkerConfig({ ...base, APP_WORKER_UI_AUTH: 'token' }).ui?.auth).toBe('token');
    expect(() => loadRemoteWorkerConfig({ ...base, APP_WORKER_UI_AUTH: 'cookie' })).toThrow(
      /APP_WORKER_UI_AUTH must be none or token/,
    );
    expect(
      loadRemoteWorkerConfig({ ...base, APP_WORKER_UI: 'disabled', APP_WORKER_UI_PORT: '8123' }).ui,
    ).toMatchObject({ enabled: false, publishedPort: 8123, listenPort: 7357 });
    expect(() => loadRemoteWorkerConfig({ ...base, APP_WORKER_UI: 'on' })).toThrow(
      /APP_WORKER_UI must be enabled or disabled/,
    );
    expect(() => loadRemoteWorkerConfig({ ...base, APP_WORKER_UI_PORT: '0' })).toThrow(
      /APP_WORKER_UI_PORT must be a TCP port/,
    );
  });

  // ── The first-run wizard (WP-294) ─────────────────────────────────────────────────────────────

  const SIGN_IN_FIXTURE = JSON.parse(
    readFileSync(
      path.join(process.cwd(), 'test/fixtures/claude-cli/setup-token.transcript.json'),
      'utf8',
    ),
  ) as { readonly good_code: string; readonly token: string };
  const FAKE_CLAUDE = path.join(process.cwd(), 'test/fixtures/claude-cli/fake-claude.mjs');
  /** The fake `claude` replaying V-WM10's transcript, as a real child process (`claude-sign-in.test.ts`). */
  const fakeClaude: ClaudeCliLauncher = {
    setupToken: (env) => {
      const child = spawn(process.execPath, [FAKE_CLAUDE, 'setup-token'], {
        env: { ...env },
        cwd: env.HOME,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      return {
        child,
        kill: () => {
          try {
            process.kill(-(child.pid as number), 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        },
      };
    },
    run: (args, env, timeoutMs) =>
      runBounded(process.execPath, [FAKE_CLAUDE, ...args], env, timeoutMs),
  };
  /** A wait that yields to timers, so a polling loop never starves the test's own. */
  const yielding = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5)));
  const RELEASE_BODY = {
    protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [1, WORKER_PROTOCOL_VERSION] },
    digests: {
      platform: DIGEST,
      platform_launcher: DIGEST,
      platform_runtime: DIGEST,
      platform_egress: DIGEST,
    },
  };
  /** The platforms on this "machine": each origin answers version and release; anything else, nothing. */
  const probe = (origins: readonly string[]) => {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const fetch: CoreFetch = async (url, init) => {
      asked.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      const at = new URL(url);
      if (!origins.includes(at.origin)) throw new TypeError('fetch failed');
      const body =
        at.pathname === '/api/version'
          ? { version: '0.4.0', commit: null, built_at: null }
          : RELEASE_BODY;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    return { fetch, asked };
  };
  const ORIGIN = { origin: `http://127.0.0.1:${PUBLISHED}` };
  const post = (port: number, verb: string, body: unknown, headers: Record<string, string> = {}) =>
    request(port, {
      method: 'POST',
      path: `/api/local/${verb}`,
      headers: { ...ORIGIN, ...headers },
      body,
    });
  const localState = async (port: number, headers: Record<string, string> = {}) =>
    workerLocalStateSchema.parse(
      JSON.parse((await request(port, { path: '/api/local/state', headers })).text),
    );

  it('serves the page and says the launcher does not answer while it is down, before any setup (backlog 980)', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    const core = fakeCore({});
    const probed = probe([]);
    let up = false;
    const { worker } = await start({
      stateDir,
      core,
      auth: 'none',
      coreUrl: null,
      claudeToken: null,
      probeFetch: probed.fetch,
      sleep: yielding,
      health: async () => {
        if (!up) throw new Error('the launcher control plane could not be reached');
        return { images: { run: DIGEST, egress: DIGEST } };
      },
    });
    try {
      const port = portOf(worker.uiAddress());
      await until('the page says so', () => worker.localState().launcher === 'unreachable');
      expect(await localState(port)).toMatchObject({
        connection: 'needs_platform',
        launcher: 'unreachable',
      });
      // The wizard is not blocked by it: it is still asked for a platform, and nothing calls a core.
      expect(core.captured).toEqual([]);
      up = true;
      await until('the page says it answers', () => worker.localState().launcher === 'ok');
      expect((await localState(port)).launcher).toBe('ok');
    } finally {
      await worker.stop();
    }
  });

  it('starts with no platform, no Claude token and no credential: serves the page, calls no core, claims nothing (WP-294 (1))', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    const core = fakeCore({});
    const probed = probe([]);
    const { worker, lines } = await start({
      stateDir,
      core,
      auth: 'none',
      coreUrl: null,
      claudeToken: null,
      probeFetch: probed.fetch,
      sleep: yielding,
    });
    try {
      const port = portOf(worker.uiAddress());
      // The default auth mode: no token file, the plain address logged, no Authorization needed.
      expect(existsSync(path.join(stateDir, UI_TOKEN_FILE))).toBe(false);
      expect(
        lines.some((line) => line.includes(`this worker's page: http://127.0.0.1:${PUBLISHED}`)),
      ).toBe(true);
      const page = await localState(port);
      expect(page).toMatchObject({ connection: 'needs_platform', core_url: null, worker_id: null });
      expect(page.setup).toMatchObject({
        core_source: null,
        claude_source: null,
        device: null,
        auth: 'none',
      });
      await until('the candidates were probed', () => probed.asked.length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // No core call and no claim at all; the probes went only to this machine, with no credential.
      expect(core.captured).toEqual([]);
      for (const asked of probed.asked) {
        expect(new URL(asked.url).hostname).toBe('host.docker.internal');
        expect(asked.headers.authorization).toBeUndefined();
      }
      // The Claude step's actions refuse nothing here, but no platform is set: a code is refused.
      expect((await post(port, 'claude/code', { code: 'x' })).status).toBe(409);
      // A code is only the characters Claude's page shows: a line break or a control character
      // would answer the CLI's next prompt, so it is refused before anything (review of PR #42).
      for (const code of ['abc\rdef', 'abc\ndef', 'abc def', 'ab\u0003c']) {
        const refused = await post(port, 'claude/code', { code });
        expect(`${JSON.stringify(code)} ${refused.status}`).toBe(`${JSON.stringify(code)} 400`);
        expect(refused.text).not.toContain(code);
      }
    } finally {
      await worker.stop();
    }
  });

  it('answers 409 for a value that comes from the environment, and shows it as such (WP-294 (1))', async () => {
    const stateDir = stateDirWithCredential();
    const core = fakeCore({});
    const { worker } = await start({ stateDir, core, auth: 'none', sleep: yielding });
    try {
      const port = portOf(worker.uiAddress());
      await until('connected', () => worker.state().connection === 'connected');
      const page = await localState(port);
      expect(page.setup).toMatchObject({
        core_source: 'environment',
        claude_source: 'environment',
      });
      for (const [verb, body] of [
        ['core', { url: null }],
        ['core', { url: 'https://other.example.test' }],
        ['claude/sign-in', { action: 'start' }],
        ['claude/token', { token: SIGN_IN_FIXTURE.token }],
        ['claude/sign-out', {}],
      ] as const) {
        const answer = await post(port, verb, body);
        expect(`${verb} ${answer.status} ${JSON.parse(answer.text).error?.code}`).toBe(
          `${verb} 409 set_in_environment`,
        );
      }
    } finally {
      await worker.stop();
    }
  });

  it('walks platform → Claude → approval → the room by itself, with no restart, and no secret anywhere (WP-294 (3)–(5))', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    let approval: 'pending' | 'expire' | 'approve' = 'pending';
    const core = fakeCore({
      deviceToken: () => {
        if (approval === 'expire') {
          approval = 'pending';
          return { status: 400, body: { error: 'expired_token' } };
        }
        if (approval === 'approve') {
          return { status: 200, body: { worker_id: WORKER_ID, credential: WORKER_CREDENTIAL } };
        }
        return null;
      },
    });
    const probed = probe(['http://host.docker.internal:8080', 'https://core.example.test']);
    // The token check waits for the test, so what the worker answers while it runs is measured.
    let releaseCheck: () => void = () => undefined;
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    let checksStarted = 0;
    const gatedClaude: ClaudeCliLauncher = {
      setupToken: fakeClaude.setupToken,
      run: async (args, env, timeoutMs) => {
        checksStarted += 1;
        await checkGate;
        return fakeClaude.run(args, env, timeoutMs);
      },
    };
    const { worker, lines, internal } = await start({
      stateDir,
      core,
      auth: 'none',
      coreUrl: null,
      claudeToken: null,
      claudeCli: gatedClaude,
      probeFetch: probed.fetch,
      sleep: yielding,
    });
    /** `/internal/state`'s `idle` — what an update's drain waits for. */
    const internalIdle = async (): Promise<unknown> =>
      ((await (await fetch(`${internal}/internal/state`)).json()) as { idle?: unknown }).idle;
    const answers: string[] = [];
    const ask = async (verb: string, body: unknown) => {
      const answer = await post(port, verb, body);
      answers.push(answer.text);
      return answer;
    };
    const port = portOf(worker.uiAddress());
    const read = async () => {
      const text = (await request(port, { path: '/api/local/state' })).text;
      answers.push(text);
      return workerLocalStateSchema.parse(JSON.parse(text));
    };
    try {
      // (a) The platform running on this machine is offered; a typed one is checked by the worker.
      await until('a candidate', () => worker.localState().setup.candidates.length === 1);
      expect(worker.localState().setup.candidates[0]).toEqual({
        url: 'http://host.docker.internal:8080',
        version: '0.4.0',
      });
      const checked = await ask('core/check', { url: 'https://core.example.test/whatever' });
      expect(JSON.parse(checked.text)).toEqual({
        url: 'https://core.example.test',
        host: 'core.example.test',
        version: '0.4.0',
        protocol_fit: 'fits',
      });
      const refused = await ask('core/check', { url: 'http://core.example.test' });
      expect(`${refused.status} ${JSON.parse(refused.text).error.code}`).toBe(
        '422 address_refused',
      );
      const chosen = await ask('core', { url: 'https://core.example.test' });
      expect(chosen.status).toBe(200);
      expect(readFileSync(path.join(stateDir, 'core-url'), 'utf8')).toBe(
        'https://core.example.test\n',
      );
      await until('the Claude step', () => worker.localState().connection === 'needs_claude');
      // A second platform is refused while one is set: change platform first.
      expect((await ask('core', { url: 'https://core.example.test' })).status).toBe(409);
      expect(core.captured).toEqual([]);

      // (b) Claude's own sign-in, through the fake CLI; a malformed token is refused without echo.
      const malformed = await ask('claude/token', { token: 'sk-ant-WRONG-planted-value' });
      expect(malformed.status).toBe(400);
      expect(malformed.text).not.toContain('planted-value');
      expect((await ask('claude/sign-in', { action: 'start' })).status).toBe(200);
      await until(
        'the paste prompt',
        () => worker.localState().setup.sign_in.phase === 'waiting_for_code',
      );
      expect(new URL((await read()).setup.sign_in.url as string).hostname).toBe('claude.com');
      // A sign-in half done is not idle: an update's drain waits rather than restart the worker.
      expect(await internalIdle()).toBe(false);
      expect((await ask('claude/code', { code: SIGN_IN_FIXTURE.good_code })).status).toBe(200);
      await until('the token check', () => checksStarted === 1);
      expect(await internalIdle()).toBe(false);
      // A second paste while the sign-in's own check runs is refused, and says why.
      const second = await ask('claude/token', { token: SIGN_IN_FIXTURE.token });
      expect(`${second.status} ${JSON.parse(second.text).error.code}`).toBe(
        '409 token_check_running',
      );
      releaseCheck();
      await until('the approval step', () => worker.localState().connection === 'logging_in');
      expect(checksStarted).toBe(1);
      expect(await internalIdle()).toBe(true);
      const tokenFile = path.join(stateDir, 'claude-token');
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(tokenFile, 'utf8')).toBe(`${SIGN_IN_FIXTURE.token}\n`);
      expect(worker.localState().setup.claude_source).toBe('file');

      // (c) The code, prefilled on the core's own origin, with its expiry; a new one on expiry.
      await until('a code', () => worker.localState().setup.device !== null);
      const first = (await read()).setup.device;
      expect(first?.approve_url).toBe(
        `https://core.example.test/workers/approve?code=${first?.user_code}`,
      );
      expect(Date.parse(first?.expires_at ?? '')).toBeGreaterThan(Date.now() + 500_000);
      approval = 'expire';
      await until('a new code', () => {
        const device = worker.localState().setup.device;
        return device !== null && device.user_code !== first?.user_code;
      });
      approval = 'approve';
      await until('the room', () => worker.localState().connection === 'connected');
      expect(readFileSync(path.join(stateDir, 'credential'), 'utf8')).toBe(
        `${WORKER_CREDENTIAL}\nhttps://core.example.test\n`,
      );
      const room = await read();
      expect(room.setup.device).toBeNull();
      expect(room.worker_name).toBe('alice-laptop');

      // Planted values: the Claude token, the pasted code and the credential appear in no log
      // line, no log tail and no /api/local answer; the token and the code in no request to the
      // core (the credential rides its `Authorization`, as it must).
      const local = [...lines, ...answers, ...room.logs].join('\n');
      for (const planted of [SIGN_IN_FIXTURE.token, SIGN_IN_FIXTURE.good_code, WORKER_CREDENTIAL]) {
        expect(local).not.toContain(planted);
      }
      const toCore = core.captured
        .map((call) => `${JSON.stringify(call.headers)} ${call.body}`)
        .join('\n');
      for (const planted of [SIGN_IN_FIXTURE.token, SIGN_IN_FIXTURE.good_code]) {
        expect(toCore).not.toContain(planted);
      }
      // The run's Claude token is the one the wizard stored: no core request carries it either way.
      expect(core.captured.some((call) => call.verb === 'handshake')).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it('while draining refuses a new Claude sign-in 409 draining, finishes the one running, and takes a paste (BACKLOG 1054)', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    const core = fakeCore({});
    // The token check waits for the test, so the drain's wait for it is measured.
    let releaseCheck: () => void = () => undefined;
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    let checksStarted = 0;
    let signInsSpawned = 0;
    const gatedClaude: ClaudeCliLauncher = {
      setupToken: (env) => {
        signInsSpawned += 1;
        return fakeClaude.setupToken(env);
      },
      run: async (args, env, timeoutMs) => {
        checksStarted += 1;
        await checkGate;
        return fakeClaude.run(args, env, timeoutMs);
      },
    };
    const { worker, internal } = await start({
      stateDir,
      core,
      auth: 'none',
      claudeToken: null,
      claudeCli: gatedClaude,
      sleep: yielding,
    });
    const internalState = async () =>
      (await (await fetch(`${internal}/internal/state`)).json()) as {
        draining: boolean;
        idle: boolean;
      };
    const port = portOf(worker.uiAddress());
    const startSignIn = async () => {
      const answer = await post(port, 'claude/sign-in', { action: 'start' });
      return `${answer.status} ${answer.status === 200 ? '' : JSON.parse(answer.text).error.code}`;
    };
    try {
      await until('the Claude step', () => worker.localState().connection === 'needs_claude');
      // The process's start identity is one value for the life of the process (BACKLOG 1053).
      const before = await localState(port);
      expect(Date.parse(before.started_at)).toBeLessThanOrEqual(Date.parse(before.server_time));

      // A sign-in started before the drain …
      expect(await startSignIn()).toBe('200 ');
      await until(
        'the paste prompt',
        () => worker.localState().setup.sign_in.phase === 'waiting_for_code',
      );
      expect(signInsSpawned).toBe(1);
      expect((await fetch(`${internal}/internal/drain`, { method: 'POST' })).status).toBe(202);
      expect(await internalState()).toMatchObject({ draining: true, idle: false });
      // … is not replaced by a new one: starting is refused, and says why …
      expect(await startSignIn()).toBe('409 draining');
      expect(worker.localState().setup.sign_in.phase).toBe('waiting_for_code');
      // … while its code is still taken, and the drain waits for its check.
      expect((await post(port, 'claude/code', { code: SIGN_IN_FIXTURE.good_code })).status).toBe(
        200,
      );
      await until('the token check', () => checksStarted === 1);
      expect((await internalState()).idle).toBe(false);
      releaseCheck();
      await until('the sign-in stored', () => worker.localState().setup.claude_source === 'file');
      await until('idle again', () => worker.state().idle);
      expect(readFileSync(path.join(stateDir, 'claude-token'), 'utf8')).toBe(
        `${SIGN_IN_FIXTURE.token}\n`,
      );

      // Still draining: a new sign-in is refused and spawns nothing; a pasted token is taken.
      expect(worker.state().draining).toBe(true);
      expect(await startSignIn()).toBe('409 draining');
      expect(signInsSpawned).toBe(1);
      expect((await post(port, 'claude/token', { token: SIGN_IN_FIXTURE.token })).status).toBe(200);
      await until('the paste checked', () => checksStarted === 2 && worker.state().idle);
      expect(worker.localState().setup.sign_in.failure).toBeNull();
      expect((await localState(port)).started_at).toBe(before.started_at);
    } finally {
      await worker.stop();
    }
  });

  it('Change platform: idle only; deletes the credential and, under none, the Claude sign-in; 409 with an environment token (WP-294 (3), (6))', async () => {
    for (const auth of ['none', 'token'] as const) {
      const stateDir = stateDirWithCredential();
      writeFileSync(path.join(stateDir, 'core-url'), 'https://core.example.test\n', {
        mode: 0o600,
      });
      writeFileSync(path.join(stateDir, 'claude-token'), `${SIGN_IN_FIXTURE.token}\n`, {
        mode: 0o600,
      });
      const core = fakeCore({});
      const { worker } = await start({
        stateDir,
        core,
        auth,
        coreUrl: null,
        claudeToken: null,
        probeFetch: probe([]).fetch,
        sleep: yielding,
      });
      try {
        const port = portOf(worker.uiAddress());
        const token =
          auth === 'token' ? readFileSync(path.join(stateDir, UI_TOKEN_FILE), 'utf8').trim() : null;
        const bearer: Record<string, string> =
          token === null ? {} : { authorization: `Bearer ${token}` };
        await until('connected', () => worker.state().connection === 'connected');
        expect((await localState(port, bearer)).setup).toMatchObject({
          core_source: 'file',
          claude_source: 'file',
        });
        const changed = await post(port, 'core', { url: null }, bearer);
        expect(changed.status).toBe(200);
        expect(existsSync(path.join(stateDir, 'credential'))).toBe(false);
        expect(existsSync(path.join(stateDir, 'core-url'))).toBe(false);
        // Repointing never carries the developer's Claude sign-in under none (no-bearer §3).
        expect(existsSync(path.join(stateDir, 'claude-token')), auth).toBe(auth === 'token');
        await until('the platform step', () => worker.state().connection === 'needs_platform');
        expect(worker.localState().setup.claude_source).toBe(auth === 'token' ? 'file' : null);
      } finally {
        await worker.stop();
      }
    }
    // Under none, an environment token cannot be dropped by a repoint: refused.
    const stateDir = stateDirWithCredential();
    writeFileSync(path.join(stateDir, 'core-url'), 'https://core.example.test\n');
    const { worker } = await start({
      stateDir,
      core: fakeCore({}),
      auth: 'none',
      coreUrl: null,
      sleep: yielding,
    });
    try {
      const port = portOf(worker.uiAddress());
      const refused = await post(port, 'core', { url: null });
      expect(`${refused.status} ${JSON.parse(refused.text).error.code}`).toBe(
        '409 set_in_environment',
      );
      expect(existsSync(path.join(stateDir, 'credential'))).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it('ignores a credential recorded for another core’s origin: it asks this core for a code (WP-294 (3))', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    writeFileSync(
      path.join(stateDir, 'credential'),
      `${WORKER_CREDENTIAL}\nhttps://other.example.test\n`,
    );
    const core = fakeCore({});
    const { worker } = await start({ stateDir, core, sleep: yielding });
    try {
      await until('a code', () => worker.localState().setup.device !== null);
      expect(core.captured.map((call) => call.verb)).not.toContain('handshake');
      expect(core.captured[0]?.verb).toBe('device');
    } finally {
      await worker.stop();
    }
  });

  it('a run Claude refuses returns the page to the sign-in step and stops claiming (WP-294 (6))', async () => {
    const stateDir = stateDirWithCredential();
    const refusing = readFileSync(
      path.join(process.cwd(), 'test/fixtures/claude/authentication-failed.script.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as runnerAdapters.FakeCliScript[number]);
    const core = fakeCore({ claims: [runPackage(), runPackage()] });
    const { worker } = await start({ stateDir, core, script: () => refusing, sleep: yielding });
    try {
      await until('the sign-in step', () => worker.state().connection === 'needs_claude');
      expect(worker.localState().setup.claude_rejected).toBe(true);
      await until('the run ended', () => worker.sessions.size === 0);
      const claims = core.captured.filter((call) => call.verb === 'claims').length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(core.captured.filter((call) => call.verb === 'claims').length).toBe(claims);
      expect(worker.history).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });

  it('core unreachable: the class, the address and Retrying in N s; Try now asks again at once (WP-294 (6))', async () => {
    const stateDir = stateDirWithCredential();
    const core = fakeCore({
      handshake: (n) =>
        n === 1 ? { status: 503, body: { error: { code: 'down', message: 'x' } } } : null,
    });
    // A long wait between tries: only Try now ends it.
    const { worker } = await start({
      stateDir,
      core,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(ms, 60_000))),
      auth: 'none',
    });
    try {
      const port = portOf(worker.uiAddress());
      await until('unreachable', () => worker.state().connection === 'core_unreachable');
      const page = await localState(port);
      expect(page.core_url).toBe('https://core.example.test');
      expect(page.setup.unreachable?.failure).toBe('no_answer');
      expect(Date.parse(page.setup.unreachable?.retry_at ?? '')).toBeGreaterThan(
        Date.now() - 1_000,
      );
      expect((await post(port, 'retry', {})).status).toBe(200);
      await until('connected', () => worker.state().connection === 'connected');
      expect((await post(port, 'retry', {})).status).toBe(409);
    } finally {
      await worker.stop();
    }
  });

  it('connected but its launcher is not answering: the page says so, and Try now asks the launcher again (S-22.19, R-L3)', async () => {
    const stateDir = stateDirWithCredential();
    const core = fakeCore({});
    let up = false;
    let probes = 0;
    // A long wait between re-probes (backlog 980's backoff): only Try now asks the launcher again.
    const { worker } = await start({
      stateDir,
      core,
      auth: 'none',
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(ms, 60_000))),
      health: async () => {
        probes += 1;
        if (!up) throw new Error('connect ECONNREFUSED launcher:7780');
        return { images: { run: DIGEST, egress: DIGEST } };
      },
    });
    try {
      const port = portOf(worker.uiAddress());
      await until('connected', () => worker.state().connection === 'connected');
      await until('the launcher refused', () =>
        worker.localState().claim_blockers.includes('launcher_unreachable'),
      );
      expect((await localState(port)).claim_blockers).toEqual(['launcher_unreachable']);
      // A connected worker whose launcher is down: Try now asks it again (not `409 connected`).
      const before = probes;
      const answered = await post(port, 'retry', {});
      expect(answered.status).toBe(200);
      expect(probes).toBeGreaterThan(before);
      expect(workerLocalStateSchema.parse(JSON.parse(answered.text)).claim_blockers).toEqual([
        'launcher_unreachable',
      ]);
      up = true;
      await until('the launcher answered', () => worker.localState().claim_blockers.length === 0);
      // Nothing left to ask again: a connected worker's Try now is refused, as before.
      expect((await post(port, 'retry', {})).status).toBe(409);
    } finally {
      await worker.stop();
    }
  });

  it('revoked: Connect again deletes the credential and starts a new device flow without a restart (WP-294 (6))', async () => {
    const stateDir = stateDirWithCredential();
    const core = fakeCore({
      handshake: (n) =>
        n === 1
          ? { status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } }
          : null,
    });
    const { worker } = await start({ stateDir, core, auth: 'none', sleep: yielding });
    try {
      const port = portOf(worker.uiAddress());
      await until('revoked', () => worker.state().connection === 'revoked');
      expect((await post(port, 'connect-again', {})).status).toBe(200);
      expect(existsSync(path.join(stateDir, 'credential'))).toBe(false);
      await until('a code', () => worker.localState().setup.device !== null);
      expect(worker.state().connection).toBe('logging_in');
      expect((await post(port, 'connect-again', {})).status).toBe(409);
    } finally {
      await worker.stop();
    }
  });

  it.each(['none', 'token'] as const)(
    'holds the boundary under APP_WORKER_UI_AUTH=%s: Host 421, Origin, JSON and Sec-Fetch-Site 403, no CORS, no cookie, no secret (WP-294 (6))',
    async (auth) => {
      const stateDir = mkdtempSync(path.join(scratch, 'state-'));
      const core = fakeCore({});
      const { worker } = await start({
        stateDir,
        core,
        auth,
        coreUrl: null,
        claudeToken: null,
        probeFetch: probe(['https://core.example.test']).fetch,
        sleep: yielding,
      });
      try {
        const port = portOf(worker.uiAddress());
        const token =
          auth === 'token' ? readFileSync(path.join(stateDir, UI_TOKEN_FILE), 'utf8').trim() : null;
        expect(token === null).toBe(auth === 'none');
        const bearer: Record<string, string> =
          token === null ? {} : { authorization: `Bearer ${token}` };
        const answers: { status: number; headers: http.IncomingHttpHeaders; text: string }[] = [];
        const ask = async (input: Parameters<typeof request>[1]) => {
          const answer = await request(port, input);
          answers.push(answer);
          return answer;
        };
        // Without the bearer: 401 under token only.
        expect((await ask({ path: '/api/local/state' })).status).toBe(auth === 'token' ? 401 : 200);
        expect(
          (
            await ask({
              path: '/api/local/state',
              host: `evil.example.test:${PUBLISHED}`,
              headers: bearer,
            })
          ).status,
        ).toBe(421);
        const writes: readonly [string, unknown][] = [
          ['core/check', { url: 'https://core.example.test' }],
          ['core', { url: 'https://core.example.test' }],
          ['claude/token', { token: SIGN_IN_FIXTURE.token }],
          ['claude/code', { code: SIGN_IN_FIXTURE.good_code }],
          ['claude/sign-in', { action: 'start' }],
          ['claude/sign-out', {}],
          ['connect-again', {}],
          ['retry', {}],
        ];
        for (const [verb, body] of writes) {
          const path_ = `/api/local/${verb}`;
          for (const headers of [
            {} as Record<string, string>,
            { origin: 'https://evil.example.test' },
            { ...ORIGIN, 'content-type': 'text/plain' },
            { ...ORIGIN, 'sec-fetch-site': 'cross-site' },
            { ...ORIGIN, 'sec-fetch-site': 'same-site' },
          ]) {
            const refused = await ask({
              method: 'POST',
              path: path_,
              headers: { ...bearer, ...headers },
              body,
            });
            expect(refused.status, `${verb} ${JSON.stringify(headers)}`).toBe(403);
          }
        }
        expect(existsSync(path.join(stateDir, 'core-url'))).toBe(false);
        // No refused write started a sign-in or restarted anything.
        expect(worker.localState().setup.sign_in.phase).toBe('idle');
        expect(worker.localState().connection).toBe('needs_platform');
        // Accepted from the page itself: same-origin, JSON, the exact Origin.
        const accepted = await ask({
          method: 'POST',
          path: '/api/local/core',
          headers: { ...bearer, ...ORIGIN, 'sec-fetch-site': 'same-origin' },
          body: { url: 'https://core.example.test' },
        });
        expect(accepted.status).toBe(200);
        await until('the Claude step', () => worker.state().connection === 'needs_claude');
        // The token write is accepted (and checked in the background); nothing answers it back.
        const pasted = await ask({
          method: 'POST',
          path: '/api/local/claude/token',
          headers: { ...bearer, ...ORIGIN },
          body: { token: SIGN_IN_FIXTURE.token },
        });
        expect(pasted.status).toBe(200);
        for (const answer of answers) {
          expect(answer.headers['access-control-allow-origin']).toBeUndefined();
          expect(answer.headers['set-cookie']).toBeUndefined();
          expect(answer.text).not.toContain(SIGN_IN_FIXTURE.token);
          expect(answer.text).not.toContain(SIGN_IN_FIXTURE.good_code);
          if (token !== null) expect(answer.text).not.toContain(token);
        }
      } finally {
        await worker.stop();
      }
    },
  );
});
