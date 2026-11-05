/**
 * **The worker protocol's contract, over every verb WP-281 serves** — through the real routes, the
 * real application commands and the real run-package builder, on the in-memory stores.
 *
 * What it holds, per verb (the plan row's criterion 6):
 *
 * - **426 first.** No `X-Worker-Protocol`, an unaccepted one, or a malformed one is `426
 *   upgrade_required` with TD-031 §9's body — before authentication and before body validation —
 *   on every verb under `/api/worker/v1/`, the device flow's two included (backlog 712).
 * - **401, census style.** Every authenticated verb refuses a request with no credential, a wrong
 *   one and — for a run verb — another run's token, with `401 unauthenticated`; a revoked worker's
 *   credential and its run token too (TD-031 §7: a worker treats it as `lease_lost`).
 * - **Schema.** Every answer parses with its `@platform/contracts` schema — the run package with
 *   `runPackageSchema`'s refinements (no secret in an environment, one run, the bound) — and every
 *   answer carries `Cache-Control: no-store`.
 * - **409 lease_lost.** A stale epoch on each fenced verb answers the envelope
 *   `workerLeaseLostBodySchema` names.
 * - **Idempotent replay.** A repeated handshake, release, spawn, finish and late cost answers what
 *   the first did and writes nothing more.
 *
 * The store-level guarantees the routes rest on (the claim's eligibility in its statement, backlog
 * 714's re-check under concurrency) are PostgreSQL's and are asserted in
 * `test/integration/pipeline/remote-claim.integration.test.ts`.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import http from 'node:http';
import {
  cancelRunCommand,
  createRemoteRunCalls,
  createRemoteRuns,
  exactSecretRedactor,
  FAKE_DEPLOY_KEY,
  IntegrationError,
  MAX_RUN_START_ATTEMPTS,
  type RemoteRunCalls,
  type RemoteRuns,
  RUN_START_RETRY_MS,
  sshString,
  workerLeaseOwner,
} from '@platform/application';
import {
  ACCEPTED_WORKER_PROTOCOLS,
  type DomainEvent,
  domainEventSchemasByType,
  type Id,
  type JsonObject,
  runPackageSchema,
  type UserRole,
  WORKER_API_PREFIX,
  WORKER_PATHS,
  WORKER_PROTOCOL_VERSION,
  workerApprovalResponseSchema,
  workerClaimScopeResponseSchema,
  workerClaimScopeSetResponseSchema,
  workerFinishResponseSchema,
  workerHandshakeResponseSchema,
  workerHeartbeatResponseSchema,
  workerLateCostResponseSchema,
  workerLeaseLostBodySchema,
  workerManualPauseResponseSchema,
  workerOffersResponseSchema,
  workerReleaseResponseSchema,
  workerRunCancelResponseSchema,
  workerSettingsSchema,
  workerSpawnResponseSchema,
  workerSshSignResponseSchema,
  workerToolCallResponseSchema,
  workerTranscriptResponseSchema,
  workerUpgradeRequiredBodySchema,
} from '@platform/contracts';
import { DEFAULT_WIP_LIMITS, isActiveRunStatus } from '@platform/domain';
import { launcher as launcherAdapters } from '@platform/infrastructure';
import { PLATFORM_SKILLS } from '@platform/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../apps/server/src/app.js';
import type { Auth } from '../../../apps/server/src/auth/better-auth.js';
import { runCommandIdFor } from '../../../apps/server/src/commands.js';
import { loadServerConfig } from '../../../apps/server/src/config.js';
import { createLogger } from '../../../apps/server/src/logging.js';
import { createMetrics } from '../../../apps/server/src/metrics.js';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  createMemoryWorkerStore,
  type MemoryWorkerStore,
} from '../../../apps/server/src/queries/worker-store-memory.js';
import { memoryAttemptRecords } from '../../../apps/server/src/routes/idempotency-memory.js';
import type { WorkerRunCancelPort } from '../../../apps/server/src/routes/worker/owner-verbs.js';
import { SseHub } from '../../../apps/server/src/sse/hub.js';
import { readWorkerComposeTemplate } from '../../../apps/server/src/workers/compose.js';
import { workerReleaseOf } from '../../../apps/server/src/workers/release.js';
import {
  hashSecret,
  mintDeviceCodes,
  mintWorkerCredential,
  runTokens,
} from '../../../apps/server/src/workers/secrets.js';
import { createMemoryRemoteRunCallStore } from '../../../packages/application/src/testing/memory-remote-run-calls.js';
// The application tier's own harness — the stage job ends at the offer, as on a core with no
// launcher — read from source, as `@platform/application` does not publish its test doubles.
import {
  createPipelineHarness,
  type PipelineHarness,
} from '../../../packages/application/src/testing/pipeline-harness.js';
import { createTestRunPlanSealer } from '../../../packages/application/src/testing/run-plans.js';

const PROJECT = '00000000-0000-4000-8000-0000000282b1';
const ALICE = '00000000-0000-4000-8000-0000000282a1';
const BOB = '00000000-0000-4000-8000-0000000282a2';
const DIGESTS = {
  platform: `sha256:${'1'.repeat(64)}`,
  platform_launcher: `sha256:${'2'.repeat(64)}`,
  platform_runtime: `sha256:${'3'.repeat(64)}`,
  platform_egress: `sha256:${'4'.repeat(64)}`,
};
const HELD = [DIGESTS.platform_runtime, DIGESTS.platform_egress];
/** Shaped past a provider's real token pattern (rule 93): a hyphen after FAKE. */
const RUN_CREDENTIAL = 'FAKE-run-credential-0281';
const PROTOCOL = { 'x-worker-protocol': String(WORKER_PROTOCOL_VERSION) };

const ticketMatched = (key: string, seq: number): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: `00000000-0000-4000-9000-0000002820${String(seq).padStart(2, '0')}`,
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: seq,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

/** A worker approved through the store's own device flow; answers its id and credential. */
const registerWorker = async (
  store: MemoryWorkerStore,
  userId: string,
): Promise<{ workerId: Id; credential: string }> => {
  const now = new Date();
  const { deviceCode, userCode } = mintDeviceCodes();
  await store.createDeviceCode(
    {
      id: crypto.randomUUID(),
      deviceCodeHash: hashSecret(deviceCode),
      userCodeHash: hashSecret(userCode),
      clientAddress: '192.0.2.10',
      userAgent: 'agentic-worker/1 (FAKE)',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
      intervalSeconds: 5,
    },
    now,
  );
  await store.decideDeviceCode({
    userCodeHash: hashSecret(userCode),
    decision: 'approve',
    name: `laptop-${userId.slice(-2)}`,
    confirmedStale: false,
    actorUserId: userId,
    now,
    auditParams: {},
  });
  const minted = mintWorkerCredential();
  const polled = await store.pollDeviceCode({
    deviceCodeHash: hashSecret(deviceCode),
    now,
    mint: { workerId: minted.workerId, credentialHash: minted.credentialHash },
  });
  if (polled.outcome !== 'issued') throw new Error(`the device flow answered ${polled.outcome}`);
  return { workerId: minted.workerId as Id, credential: minted.credential };
};

type App = Awaited<ReturnType<typeof buildApp>>;

interface World {
  readonly app: App;
  readonly harness: PipelineHarness;
  readonly store: MemoryWorkerStore;
  readonly remote: RemoteRuns;
  readonly runCalls: RemoteRunCalls | null;
  readonly runCallStore: ReturnType<typeof createMemoryRemoteRunCallStore>;
  readonly alice: { workerId: Id; credential: string };
  readonly bob: { workerId: Id; credential: string };
  readonly runId: Id;
  /** The worker's cancel's records (WP-292): the audit rows and the roles its guard reads. */
  readonly cancel: {
    readonly actions: {
      userId: string;
      action: string;
      params: JsonObject;
      taskId?: string | null;
    }[];
    readonly projectRoles: Map<string, UserRole | null>;
  };
  /** The `worker.take_offer` rows a pick wrote (WP-293). */
  readonly takes: readonly { workerId: string; runId: string; taskId: string }[];
}

let opened: App | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** A project secret only the core's rebuilt redactor knows (rule 93: a hyphen after FAKE). */
const PROJECT_SECRET = 'FAKE-project-secret-0282-cccccccccccc';

/** The display block the world's packager adds (WP-292). */
const DISPLAY = { projectKey: 'ACME', ticketKey: 'ACME-1', title: 'Fix the login page' } as const;

const world = async (
  options: {
    readonly release?: boolean;
    readonly tickets?: number;
    /** What the git credential minter does instead of minting (TD-031's 2026-11-05 amendment). */
    readonly mintFails?: () => Error;
    readonly onMint?: (at: number) => void;
    /** Awaited inside the mint, after the claim committed and before the package is answered. */
    readonly beforeMint?: () => Promise<void>;
    /** `false`: the process composed no run-scoped calls (WP-282). */
    readonly runCalls?: boolean;
    /** A remote run's transcript bound (backlog 754); absent, the shipped one. */
    readonly maxTranscriptEntries?: number;
  } = {},
): Promise<World> => {
  const store = createMemoryWorkerStore();
  store.addUser({ id: ALICE, email: 'alice@example.test', name: null });
  store.addUser({ id: BOB, email: 'bob@example.test', name: null });
  // WP-293: the project both may take runs of — what a claim scope may name.
  store.addProject({ id: PROJECT, key: 'ACME', name: 'Acme storefront' }, [ALICE, BOB]);
  const takes: { workerId: string; runId: string; taskId: string }[] = [];
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runsAgents: false,
    settings: { wip: { ...DEFAULT_WIP_LIMITS, maxParallelTasks: 10, maxParallelRuns: 10 } },
    remoteWorkers: {
      // The worker store is the one source both halves read — the routes' authentication and the
      // claim's eligibility — as PostgreSQL's one `workers` table is.
      remoteWorkers: (workerId) => {
        const row = store.worker(workerId);
        if (row === null) return undefined;
        return {
          userId: row.userId as Id,
          usable: row.state === 'active' && store.userMayAct(row.userId),
          pausedUntil: row.pausedUntil === null ? null : (row.pausedUntil.toISOString() as never),
          manuallyPaused: row.manuallyPausedAt !== null,
          memberOf: (projectId) => projectId === PROJECT,
          // WP-293: the claim scope, from the same row.
          claimProjectIds: row.claimProjects === null ? null : row.claimProjects.map((p) => p.id),
        };
      },
    },
  });
  for (let index = 1; index <= (options.tickets ?? 1); index += 1) {
    await harness.publish([ticketMatched(`ACME-${index}`, index)]);
  }
  const remote = createRemoteRuns({
    unitOfWork: harness.memory,
    store: harness.store,
    context: harness.commands.context,
    runPlans: createTestRunPlanSealer(),
    packager: launcherAdapters.createRemoteRunPackager({
      projects: {
        forRun: async () => ({
          repoUrl: 'https://git.example.test/acme/web.git',
          defaultBranch: 'main',
          projectPath: 'acme/web',
          gitHost: 'git.example.test',
          branchPatterns: ['agentic/*'],
          containerEnv: {},
        }),
      },
      credentials: {
        mint: async ({ scope }) => {
          options.onMint?.(harness.clock.epochMs);
          await options.beforeMint?.();
          const failure = options.mintFails?.();
          if (failure !== undefined) throw failure;
          return {
            kind: 'minted',
            credential: {
              username: 'oauth2',
              password: RUN_CREDENTIAL,
              scope,
              expiresAt: '2026-06-02T09:00:00.000Z',
              source: 'minted',
              revoke: async () => {},
            },
          };
        },
      },
      skills: PLATFORM_SKILLS,
      modelEgressHosts: ['api.anthropic.com'],
      runRegistryHosts: [],
      remoteRunCredential: async () => 'deny',
      // WP-292: the local page's names for the run — sent to a protocol-2 worker only.
      display: async () => DISPLAY,
      credentialTtlSeconds: 86_400,
      clock: { now: () => harness.clock.epochMs, setTimer: () => () => {} },
    }),
    credentials: { revoke: async () => {} },
    tokens: runTokens,
    // WP-293: a pick's `worker.take_offer` row, recorded here.
    takeAudit: {
      record: async (_tx, entry) => {
        takes.push({ ...entry });
      },
    },
    settle: async (request) => harness.runtime.executor.settle(request),
    lateCost: {
      record: async (scope, spend) => ({
        recorded: await harness.store.runs.recordCost(scope.tx, {
          runId: spend.runId,
          sessionId: spend.sessionId,
          numTurns: spend.numTurns,
          usage: spend.usage,
          cost: spend.cost,
          wallMs: spend.wallMs,
        }),
        charge: null,
      }),
    },
  });
  // WP-282: the run-scoped calls besides the claim, over the harness's run rows and stored plans.
  const runCallStore = createMemoryRemoteRunCallStore({
    fenceHolds: async (tx, input) => {
      const settlement = await harness.store.runs.lockSettlement(tx, input.runId);
      return (
        settlement !== null &&
        isActiveRunStatus(settlement.status) &&
        settlement.leaseEpoch === input.epoch &&
        settlement.leaseOwner === workerLeaseOwner(input.workerId)
      );
    },
  });
  const refuse = async (): Promise<never> => {
    throw new Error('not composed in this test');
  };
  const runCalls =
    options.runCalls === false
      ? null
      : createRemoteRunCalls({
          unitOfWork: harness.memory,
          store: runCallStore,
          pipeline: harness.store,
          runPlans: createTestRunPlanSealer(),
          redactors: {
            forRun: async () =>
              exactSecretRedactor([{ name: 'project_secret', value: PROJECT_SECRET }]),
          },
          tools: {
            askHuman: refuse,
            notifyHuman: refuse,
            reportProgress: refuse,
            getConversation: refuse,
            getTaskContext: async (input) => ({ include: input.include, note: PROJECT_SECRET }),
            kbSearch: async (input) => ({ hits: [{ path: 'a.md', excerpt: input.query }] }),
            addTicketComment: refuse,
            openMergeRequest: refuse,
            updateMrDescription: refuse,
            createFollowupTicket: refuse,
          },
          approvals: {
            requestApproval: async () => ({
              decision: 'deny',
              reason: 'unattended: denied',
              questionId: null,
            }),
          },
          deployKeys: {
            forRun: async () => launcherAdapters.createDeployKeyOracle(FAKE_DEPLOY_KEY),
            remoteRunCredential: async () => 'allow',
          },
          maxSignatures: 2,
          ...(options.maxTranscriptEntries === undefined
            ? {}
            : { maxTranscriptEntries: options.maxTranscriptEntries }),
        });
  // WP-284: the shipped template, rendered for this core — the compose bundle digest is its own.
  const release = workerReleaseOf(options.release === false ? null : DIGESTS, {
    template: readWorkerComposeTemplate()?.text ?? null,
    repository: 'ghcr.io/acme',
    coreUrl: 'https://core.example.test',
  });
  // The production composition (`buildApp`): the protocol check is registered before the device
  // flow and the protocol's verbs, exactly as a process that serves the API registers them.
  // WP-292: the worker's cancel, over the harness's own command — the task page's `cancelRun`.
  const actions: World['cancel']['actions'] = [];
  const attempts = new Map<string, { bodyDigest: string | null; params: JsonObject }>();
  const projectRoles = new Map<string, UserRole | null>([
    [ALICE, 'member'],
    [BOB, 'member'],
  ]);
  const runCancel: WorkerRunCancelPort = {
    cancelRun: async (input) =>
      cancelRunCommand(harness.humanCommands, {
        runId: input.runId as Id,
        userId: input.userId as Id,
        ...(input.idempotencyKey === null
          ? {}
          : { commandId: runCommandIdFor(input.userId, 'run.cancel', input.idempotencyKey) }),
      }),
    runProjectId: async () => PROJECT,
    runPosition: async (runId) => {
      const run = await harness.store.runs.load({} as never, runId as Id);
      if (run === null) return null;
      const task = await harness.store.tasks.load({} as never, run.taskId);
      return task === null
        ? null
        : { status: run.status, taskId: run.taskId, taskState: task.task.state };
    },
    projectRole: async (_projectId, userId) => projectRoles.get(userId) ?? null,
    userRole: async () => 'viewer',
    ...memoryAttemptRecords(attempts),
    recordAction: async (input) => {
      actions.push({ ...input });
      const key = input.params.idempotency_key;
      const digest = input.params.body_digest;
      if (typeof key === 'string') {
        attempts.set(`${input.userId}|${input.action}|${key}`, {
          bodyDigest: typeof digest === 'string' ? digest : null,
          params: input.params,
        });
      }
    },
  };
  const app = await buildApp({
    config: loadServerConfig({
      DATABASE_URL: 'postgres://app:app@db:5432/app',
      APP_SECRET_KEY: 'x'.repeat(40),
      APP_BASE_URL: 'https://core.example.test',
    }),
    logger: createLogger({ level: 'silent', format: 'json', role: 'all' }),
    metrics: createMetrics({ defaultMetrics: false }),
    database: {} as Database,
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response('{}', { status: 200 }),
    } as unknown as Auth,
    hub: new SseHub({
      bufferSize: 4,
      maxQueuedFrames: 8,
      maxTopicsPerConnection: 4,
      maxBufferedTopics: 8,
      retryMs: 1_000,
      pingIntervalMs: 0,
      maxConnections: 2,
      shutdownDrainMs: 100,
    }),
    webhooks: null,
    knowledge: null,
    onboarding: null,
    shadow: null,
    shadowGate: null,
    organisationCredentials: null,
    projectSettings: {
      forProject: async () => {
        throw new Error('this test reads no project settings');
      },
    },
    historyBootstrap: null,
    historyBootstrapGate: null,
    rediscoveryGate: null,
    commands: null,
    asks: { commands: null, queries: { listAsks: async () => [], taskAudit: async () => [] } },
    breakdown: null,
    setupState: { firstSignInPending: async () => true },
    version: { version: '0.0.0-test', commit: null, builtAt: null },
    readiness: async () => ({ status: 'ok', checks: {} }),
    isShuttingDown: () => false,
    workers: store,
    // The harness's clock is the database's here: `runs.ended_at`, which a run token's fifteen
    // minutes after the end are counted from, is stamped by it.
    workersNow: () => new Date(harness.clock.epochMs),
    workerProtocol: {
      remoteRuns: remote,
      runCalls,
      runCancel,
      broadcast: harness.memory.broadcast,
      release: () => release,
      unresolved: () =>
        release === null
          ? 'ghcr.io/acme/platform-runtime:sha-feedc0d could not be resolved to a digest: answered 404'
          : null,
      holds: { claimMs: 30, heartbeatMs: 30, claimPollMs: 10 },
      // WP-293: the offers' names, the package's display block for every task.
      offerDisplays: async (taskIds) => new Map(taskIds.map((taskId) => [taskId, DISPLAY])),
    },
  });
  opened = app;
  return {
    app,
    harness,
    store,
    remote,
    runCalls,
    runCallStore,
    alice: await registerWorker(store, ALICE),
    bob: await registerWorker(store, BOB),
    runId: harness.store.offerRows()[0]?.runId as Id,
    cancel: { actions, projectRoles },
    takes,
  };
};

/** Waits (bounded) for `check` — a structural signal, never a fixed margin. */
const waitUntil = async (check: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting');
};

const url = (verb: string, runId?: string, tool = 'get_task_context'): string =>
  `${WORKER_API_PREFIX}/${verb
    .replace(':id', runId ?? '00000000-0000-4000-8000-000000000000')
    .replace(':name', tool)}`;

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}`, ...PROTOCOL });

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 0,
};

/** A valid body for each verb — the census sends it with every credential case. */
const bodies = (epoch: number) => ({
  [WORKER_PATHS.handshake]: { image_digests: HELD, commit: null },
  [WORKER_PATHS.claims]: { free_slots: 1, image_digests: HELD, paused: false },
  [WORKER_PATHS.pause]: {
    until: new Date(Date.now() + 3_600_000).toISOString(),
    reason: 'usage_limited',
    estimated: false,
  },
  [WORKER_PATHS.updateReport]: {
    from: DIGESTS,
    to: { ...DIGESTS, platform: `sha256:${'9'.repeat(64)}` },
    result: 'succeeded',
    detail: null,
  },
  [WORKER_PATHS.heartbeat]: { epoch, acks: [] },
  [WORKER_PATHS.runRelease]: { epoch, reason: 'image_missing' },
  [WORKER_PATHS.spawn]: { epoch },
  [WORKER_PATHS.finish]: {
    epoch,
    stop_reason: null,
    outcome: {
      kind: 'ran',
      status: 'completed',
      terminal_reason: 'success',
      session_id: null,
      num_turns: 2,
      usage: USAGE,
      model_usage: [],
      cost: { usd: 0.02, is_estimate: false, price_list_id: null },
      wall_ms: 1_000,
      structured_output: null,
      error: null,
      redaction_count: 0,
    },
  },
  [WORKER_PATHS.lateCost]: {
    epoch,
    session_id: null,
    num_turns: 2,
    wall_ms: 1_000,
    cost: { usd: 0.4, is_estimate: false, price_list_id: null },
    usage: USAGE,
    model_usage: [],
  },
  [WORKER_PATHS.transcript]: {
    epoch,
    entries: [{ seq: 0, event: transcriptEntry(0, 'hello') }],
  },
  [WORKER_PATHS.tool]: { epoch, tool_use_id: 'toolu_census', input: { include: ['ticket'] } },
  [WORKER_PATHS.approvals]: {
    epoch,
    tool_use_id: 'toolu_approval',
    tool_name: 'WebFetch',
    detail: 'fetch https://example.test/',
    input: { url: 'https://example.test/' },
    reason: 'ask list',
  },
  [WORKER_PATHS.session]: { epoch, session_id: 'sess-1', from_line: 0, lines: ['{"a":1}'] },
  // WP-292: the owner verbs (protocol 2).
  [WORKER_PATHS.manualPause]: { paused: true, via: 'worker_ui' },
  [WORKER_PATHS.runCancel]: { reason: 'leaving for the day' },
  [WORKER_PATHS.sshSign]: {
    epoch,
    key_blob: deployKeyBlob().toString('base64'),
    data: userauth().toString('base64'),
    flags: 0,
  },
});

/** One assistant transcript entry of the world's run, dated now. */
function transcriptEntry(seq: number, text: string, runId?: string) {
  return {
    run_id: runId ?? '00000000-0000-4000-8000-000000000000',
    seq,
    created_at: new Date().toISOString(),
    redaction_count: 0,
    kind: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text }],
  };
}

/** The deploy key's public key blob, from its `ssh-ed25519 AAAA…` line. */
function deployKeyBlob(): Buffer {
  return Buffer.from(FAKE_DEPLOY_KEY.publicKey.split(' ')[1] ?? '', 'base64');
}

/** A synthetic RFC 4252 §7 user-authentication request for user `git` with the deploy key. */
function userauth(user = 'git'): Buffer {
  return Buffer.concat([
    sshString(Buffer.alloc(32, 7)),
    Buffer.from([50]),
    sshString(user),
    sshString('ssh-connection'),
    sshString('publickey'),
    Buffer.from([1]),
    sshString('ssh-ed25519'),
    sshString(deployKeyBlob()),
  ]);
}

/** The verbs WP-281 serves: two authenticated by the worker credential, five by a run token. */
const WORKER_VERBS = [
  WORKER_PATHS.handshake,
  WORKER_PATHS.claims,
  WORKER_PATHS.pause,
  // WP-287 (4): the updater's report.
  WORKER_PATHS.updateReport,
] as const;
/** WP-292's owner verbs: the same authentication as their neighbours, at protocol 2 only. */
const OWNER_WORKER_VERBS = [WORKER_PATHS.manualPause] as const;
const OWNER_RUN_VERBS = [WORKER_PATHS.runCancel] as const;
const RUN_VERBS = [
  WORKER_PATHS.heartbeat,
  WORKER_PATHS.runRelease,
  WORKER_PATHS.spawn,
  WORKER_PATHS.finish,
  WORKER_PATHS.lateCost,
  // WP-282: the run-scoped calls besides the claim.
  WORKER_PATHS.transcript,
  WORKER_PATHS.tool,
  WORKER_PATHS.approvals,
  WORKER_PATHS.session,
  WORKER_PATHS.sshSign,
] as const;

/** Claims the world's offer as Alice; answers the package. */
const claimAsAlice = async (w: World) => {
  const response = await w.app.inject({
    method: 'POST',
    url: url(WORKER_PATHS.claims),
    headers: bearer(w.alice.credential),
    payload: bodies(1)[WORKER_PATHS.claims],
  });
  expect(response.statusCode).toBe(200);
  return runPackageSchema.parse(response.json());
};

const post = (w: World, verb: string, runId: string, secret: string, payload: object) =>
  w.app.inject({ method: 'POST', url: url(verb, runId), headers: bearer(secret), payload });

describe('the worker protocol (WP-281): 426 before anything else, on every verb (backlog 712)', () => {
  it.each([
    ['no header', {}],
    ['an unaccepted protocol', { 'x-worker-protocol': String(WORKER_PROTOCOL_VERSION + 1) }],
    ['a malformed protocol', { 'x-worker-protocol': '01' }],
  ] as const)(
    'answers 426 with TD-031 §9’s body for %s — device flow included',
    async (_name, headers) => {
      const w = await world();
      for (const verb of [
        WORKER_PATHS.device,
        WORKER_PATHS.deviceToken,
        ...WORKER_VERBS,
        ...RUN_VERBS,
        ...OWNER_WORKER_VERBS,
        ...OWNER_RUN_VERBS,
      ]) {
        const response = await w.app.inject({
          method: 'POST',
          url: url(verb, w.runId),
          // A valid credential and a malformed body: the protocol check comes before both.
          headers: { ...headers, authorization: `Bearer ${w.alice.credential}` },
          payload: { not: 'a valid body' },
        });
        expect(`${verb} ${response.statusCode}`).toBe(`${verb} 426`);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = workerUpgradeRequiredBodySchema.parse(response.json());
        expect(body).toMatchObject({
          error: { code: 'upgrade_required' },
          accepted: [...ACCEPTED_WORKER_PROTOCOLS],
          compose_url: 'https://core.example.test/api/worker/v1/compose.yml',
          digests: DIGESTS,
        });
      }
    },
  );

  it('still answers 426 while the core cannot name its digests (digests: null)', async () => {
    const w = await world({ release: false });
    const response = await w.app.inject({ method: 'POST', url: url(WORKER_PATHS.handshake) });
    expect(response.statusCode).toBe(426);
    expect(workerUpgradeRequiredBodySchema.parse(response.json()).digests).toBeNull();
  });

  it('serves the device flow with the header, as it served it before WP-281', async () => {
    const w = await world();
    const response = await w.app.inject({
      method: 'POST',
      url: url(WORKER_PATHS.device),
      headers: PROTOCOL,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('the worker protocol (WP-281): 401 on every authenticated verb (census)', () => {
  it('refuses no credential, a wrong one, a credential of the wrong kind and another run’s token', async () => {
    const w = await world({ tickets: 2 });
    const pkg = await claimAsAlice(w);
    // A second **claimed** run, so a token is checked against that run's own stored hash.
    const bobs = runPackageSchema.parse(
      (
        await post(w, WORKER_PATHS.claims, '', w.bob.credential, bodies(1)[WORKER_PATHS.claims])
      ).json(),
    );
    expect(bobs.runId).not.toBe(pkg.runId);
    const wrongWorker = `wkr_${'a'.repeat(26)}_${'b'.repeat(43)}`;
    for (const verb of [...WORKER_VERBS, ...OWNER_WORKER_VERBS]) {
      for (const headers of [PROTOCOL, bearer(wrongWorker), bearer(pkg.runToken)]) {
        const response = await w.app.inject({
          method: 'POST',
          url: url(verb),
          headers,
          payload: bodies(1)[verb],
        });
        expect(`${verb} ${response.statusCode} ${response.json().error?.code}`).toBe(
          `${verb} 401 unauthenticated`,
        );
        expect(response.headers['cache-control']).toBe('no-store');
      }
    }
    for (const verb of [...RUN_VERBS, ...OWNER_RUN_VERBS]) {
      for (const [runId, headers] of [
        [w.runId, PROTOCOL],
        [w.runId, bearer(w.alice.credential)],
        [w.runId, bearer('x'.repeat(43))],
        [bobs.runId, bearer(pkg.runToken)],
        [pkg.runId, bearer(bobs.runToken)],
      ] as const) {
        const response = await w.app.inject({
          method: 'POST',
          url: url(verb, runId),
          headers,
          payload: bodies(1)[verb],
        });
        expect(`${verb} ${response.statusCode} ${response.json().error?.code}`).toBe(
          `${verb} 401 unauthenticated`,
        );
      }
    }
  });

  it('refuses a revoked worker’s credential and its run token (TD-031 §7)', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const revoked = await w.store.revokeWorker({
      workerId: w.alice.workerId,
      ownerUserId: null,
      actorUserId: ALICE,
      now: new Date(),
    });
    expect(revoked.status).toBe('revoked');
    const handshake = await post(w, WORKER_PATHS.handshake, w.runId, w.alice.credential, {
      image_digests: HELD,
      commit: null,
    });
    expect(handshake.statusCode).toBe(401);
    const beat = await post(w, WORKER_PATHS.heartbeat, w.runId, pkg.runToken, {
      epoch: 1,
      acks: [],
    });
    expect(`${beat.statusCode} ${beat.json().error?.code}`).toBe('401 unauthenticated');
  });
});

describe('a mint failure after a remote claim (TD-031’s 2026-11-05 amendment, backlog 740)', () => {
  it('is a start failure: an always-unavailable minter is asked 3 times, 30 s apart, then the task needs a human — no release', async () => {
    const mints: number[] = [];
    const w = await world({
      mintFails: () => new IntegrationError('unavailable', 'fake-git', 'the provider answered 503'),
      onMint: (at) => mints.push(at),
    });
    for (let attempt = 1; attempt <= MAX_RUN_START_ATTEMPTS + 1; attempt += 1) {
      const response = await post(
        w,
        WORKER_PATHS.claims,
        '',
        w.alice.credential,
        bodies(1)[WORKER_PATHS.claims],
      );
      expect(response.statusCode).toBe(204);
      w.harness.clock.advance(RUN_START_RETRY_MS);
      await w.harness.drain();
    }
    expect(mints).toHaveLength(MAX_RUN_START_ATTEMPTS);
    for (let index = 1; index < mints.length; index += 1) {
      expect((mints[index] ?? 0) - (mints[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        RUN_START_RETRY_MS,
      );
    }
    expect(w.harness.types().filter((type) => type === 'run.failed')).toHaveLength(
      MAX_RUN_START_ATTEMPTS,
    );
    expect(w.harness.types()).not.toContain('run.offer.released');
    const [first] = w.harness.store.offerRows();
    const task = await w.harness.store.tasks.load({} as never, first?.taskId as Id);
    expect(task?.task.state).toBe('needs_human');
  });

  it('escalates a forbidden mint on its first attempt', async () => {
    const mints: number[] = [];
    const w = await world({
      mintFails: () => new IntegrationError('forbidden', 'fake-git', 'the token may not mint'),
      onMint: (at) => mints.push(at),
    });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await post(w, WORKER_PATHS.claims, '', w.alice.credential, bodies(1)[WORKER_PATHS.claims]);
      w.harness.clock.advance(RUN_START_RETRY_MS);
      await w.harness.drain();
    }
    expect(mints).toHaveLength(1);
    const [first] = w.harness.store.offerRows();
    const task = await w.harness.store.tasks.load({} as never, first?.taskId as Id);
    expect(task?.task.state).toBe('needs_human');
  });
});

describe('the worker protocol (WP-281): every verb’s answer, its schema and its replay', () => {
  it('handshake: the range, the digests, the settings and the server time — and the contact recorded', async () => {
    const w = await world();
    const first = await post(w, WORKER_PATHS.handshake, '', w.alice.credential, {
      image_digests: HELD,
      commit: null,
    });
    expect(first.statusCode).toBe(200);
    const body = workerHandshakeResponseSchema.parse(first.json());
    expect(body).toMatchObject({
      protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [...ACCEPTED_WORKER_PROTOCOLS] },
      digests: DIGESTS,
      worker: { id: w.alice.workerId, paused_until: null },
    });
    expect(body.compose_bundle_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(w.store.worker(w.alice.workerId)).toMatchObject({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      imageDigests: HELD,
    });
    expect(w.store.worker(w.alice.workerId)?.lastSeenAt).not.toBeNull();
    const again = await post(w, WORKER_PATHS.handshake, '', w.alice.credential, {
      image_digests: HELD,
      commit: null,
    });
    expect(workerHandshakeResponseSchema.parse(again.json()).compose_bundle_digest).toBe(
      body.compose_bundle_digest,
    );
  });

  it('handshake and claims answer 503 digests_unresolved while the core cannot name its images', async () => {
    const w = await world({ release: false });
    // `pause` and `update-report` name no core image, so neither is refused for want of one.
    for (const verb of [WORKER_PATHS.handshake, WORKER_PATHS.claims] as const) {
      const response = await post(w, verb, '', w.alice.credential, bodies(1)[verb]);
      expect(`${verb} ${response.statusCode} ${response.json().error?.code}`).toBe(
        `${verb} 503 digests_unresolved`,
      );
    }
    // An update report names its own digests: it is recorded whatever the core can name.
    const report = await post(
      w,
      WORKER_PATHS.updateReport,
      '',
      w.alice.credential,
      bodies(1)[WORKER_PATHS.updateReport],
    );
    expect(report.statusCode).toBe(204);
  });

  it('release: the digests and the protocol range, no compose file; public — no credential is 200, no contact — and still 426 without the protocol header (WP-284, WP-294)', async () => {
    const w = await world();
    const response = await w.app.inject({
      method: 'GET',
      url: url(WORKER_PATHS.release),
      headers: bearer(w.alice.credential),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(workerReleaseResponseSchema.parse(response.json())).toEqual({
      protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [...ACCEPTED_WORKER_PROTOCOLS] },
      digests: DIGESTS,
    });
    // TD-031's first-run amendment §6: a wizard with no credential checks an address with it.
    const before = w.store.worker(w.alice.workerId)?.lastSeenAt ?? null;
    const anonymous = await w.app.inject({
      method: 'GET',
      url: url(WORKER_PATHS.release),
      headers: PROTOCOL,
    });
    expect(anonymous.statusCode).toBe(200);
    expect(workerReleaseResponseSchema.parse(anonymous.json()).digests).toEqual(DIGESTS);
    // A credential, if presented, is ignored: no contact is recorded for it.
    expect(w.store.worker(w.alice.workerId)?.lastSeenAt ?? null).toEqual(before);
    const unknown = await w.app.inject({
      method: 'GET',
      url: url(WORKER_PATHS.release),
      headers: { ...PROTOCOL, authorization: 'Bearer wkr_not_a_real_credential' },
    });
    expect(unknown.statusCode).toBe(200);
    const noProtocol = await w.app.inject({
      method: 'GET',
      url: url(WORKER_PATHS.release),
      headers: { authorization: `Bearer ${w.alice.credential}` },
    });
    expect(noProtocol.statusCode).toBe(426);
  });

  it('compose.yml: public and outside the protocol check — the template pinned to this core’s digests, whose SHA-256 is the handshake’s compose_bundle_digest (WP-284 (6), backlog 743, 760)', async () => {
    const w = await world();
    // No credential and no protocol header: a person's first-install download (TD-031's
    // 2026-11-05 amendment).
    const response = await w.app.inject({ method: 'GET', url: url(WORKER_PATHS.composeFile) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/yaml; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    const file = response.body;
    expect(file).toContain(`ghcr.io/acme/platform@${DIGESTS.platform}`);
    expect(file).toContain(`ghcr.io/acme/platform-launcher@${DIGESTS.platform_launcher}`);
    expect(file).toContain(`ghcr.io/acme/platform-runtime@${DIGESTS.platform_runtime}`);
    expect(file).toContain(`ghcr.io/acme/platform-egress@${DIGESTS.platform_egress}`);
    expect(file).toContain('${APP_CORE_URL:-https://core.example.test}');
    // A credential, if presented, is ignored: the same bytes, no contact recorded.
    const before = w.store.worker(w.alice.workerId)?.lastSeenAt ?? null;
    const credentialed = await w.app.inject({
      method: 'GET',
      url: url(WORKER_PATHS.composeFile),
      headers: bearer(w.alice.credential),
    });
    expect(credentialed.body).toBe(file);
    expect(w.store.worker(w.alice.workerId)?.lastSeenAt ?? null).toEqual(before);
    const handshake = await post(w, WORKER_PATHS.handshake, '', w.alice.credential, {
      image_digests: HELD,
      commit: null,
    });
    expect(workerHandshakeResponseSchema.parse(handshake.json()).compose_bundle_digest).toBe(
      createHash('sha256').update(file, 'utf8').digest('hex'),
    );
    // Only GET skips the check: any other method on the path, and every other verb, is still 426.
    const posted = await w.app.inject({ method: 'POST', url: url(WORKER_PATHS.composeFile) });
    expect(posted.statusCode).toBe(426);
    const release = await w.app.inject({ method: 'GET', url: url(WORKER_PATHS.release) });
    expect(release.statusCode).toBe(426);
  });

  it('release and compose.yml answer 503 digests_unresolved naming the image (WP-284)', async () => {
    const w = await world({ release: false });
    for (const verb of [WORKER_PATHS.release, WORKER_PATHS.composeFile]) {
      const response = await w.app.inject({
        method: 'GET',
        url: url(verb),
        // compose.yml takes no header at all (TD-031's 2026-11-05 amendment); release is public but
        // keeps the protocol check (the first-run amendment §6).
        headers: verb === WORKER_PATHS.release ? PROTOCOL : {},
      });
      expect(`${verb} ${response.statusCode} ${response.json().error?.code}`).toBe(
        `${verb} 503 digests_unresolved`,
      );
      expect(response.json().error?.message).toContain('ghcr.io/acme/platform-runtime');
    }
  });

  it('claims: a package that runPackageSchema admits — no secret value, the minted credential, the run token — then 204 when nothing is left', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    expect(pkg).toMatchObject({
      runId: w.runId,
      epoch: 1,
      images: { run: DIGESTS.platform_runtime, egress: DIGESTS.platform_egress },
      credential: { password: RUN_CREDENTIAL, source: 'minted', host: 'git.example.test' },
      limits: { leaseTtlMs: 600_000 },
    });
    expect(pkg.run.secretEnvNames).toEqual([]);
    expect(pkg.runToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The run token is stored only as its hash.
    const holder = await w.harness.memory.transaction(async (scope) =>
      w.harness.store.offers.runTokenHolder(scope.tx, w.runId),
    );
    expect(holder?.tokenHash).toBe(hashSecret(pkg.runToken));
    expect(JSON.stringify(w.harness.store.offerRows())).not.toContain(pkg.runToken);

    const nothing = await post(
      w,
      WORKER_PATHS.claims,
      '',
      w.bob.credential,
      bodies(1)[WORKER_PATHS.claims],
    );
    expect(nothing.statusCode).toBe(204);
    expect(nothing.body).toBe('');
    // A paused worker is answered 204 at once, holding nothing.
    const paused = await post(w, WORKER_PATHS.claims, '', w.bob.credential, {
      ...bodies(1)[WORKER_PATHS.claims],
      paused: true,
    });
    expect(paused.statusCode).toBe(204);
  });

  it('heartbeat: renews, delivers a recorded cancel, and is lease_lost for a stale epoch', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const held = await post(w, WORKER_PATHS.heartbeat, w.runId, pkg.runToken, {
      epoch: 1,
      acks: [],
    });
    expect(held.statusCode).toBe(200);
    expect(workerHeartbeatResponseSchema.parse(held.json())).toMatchObject({
      commands: [],
      approvals: [],
    });
    const commandId = '00000000-0000-4000-8000-0000000282c1';
    await w.harness.memory.transaction(async (scope) =>
      w.harness.store.runCommands.insert(scope.tx, {
        id: commandId as Id,
        runId: w.runId,
        taskId: w.harness.store.offerRows()[0]?.taskId as Id,
        actorUserId: null,
        instruction: { kind: 'cancel' },
      }),
    );
    const delivered = await post(w, WORKER_PATHS.heartbeat, w.runId, pkg.runToken, {
      epoch: 1,
      acks: [],
    });
    expect(workerHeartbeatResponseSchema.parse(delivered.json()).commands).toEqual([
      { id: commandId, kind: 'cancel', payload: {} },
    ]);
    const stale = await post(w, WORKER_PATHS.heartbeat, w.runId, pkg.runToken, {
      epoch: 2,
      acks: [],
    });
    expect(stale.statusCode).toBe(409);
    expect(workerLeaseLostBodySchema.parse(stale.json()).error.code).toBe('lease_lost');
  });

  it('release: 204, replayed 204 writing nothing; lease_lost for a stale epoch; run_started after spawn', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const stale = await post(w, WORKER_PATHS.runRelease, w.runId, pkg.runToken, {
      epoch: 2,
      reason: 'image_missing',
    });
    expect(workerLeaseLostBodySchema.parse(stale.json()).error.code).toBe('lease_lost');
    for (const _ of [1, 2]) {
      const response = await post(w, WORKER_PATHS.runRelease, w.runId, pkg.runToken, {
        epoch: 1,
        reason: 'image_missing',
      });
      expect(response.statusCode).toBe(204);
    }
    expect(w.harness.types().filter((type) => type === 'run.offer.released')).toHaveLength(1);
    expect(w.harness.store.offerRows()[0]?.state).toBe('open');

    const again = await claimAsAlice(w);
    expect(again.epoch).toBe(2);
    expect(
      (await post(w, WORKER_PATHS.spawn, w.runId, again.runToken, { epoch: 2 })).statusCode,
    ).toBe(200);
    const started = await post(w, WORKER_PATHS.runRelease, w.runId, again.runToken, {
      epoch: 2,
      reason: 'shutdown',
    });
    expect(`${started.statusCode} ${started.json().error?.code}`).toBe('409 run_started');
  });

  it('spawn: the marker’s instant, replayed unchanged; lease_lost for a stale epoch', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const stale = await post(w, WORKER_PATHS.spawn, w.runId, pkg.runToken, { epoch: 2 });
    expect(workerLeaseLostBodySchema.parse(stale.json()).error.code).toBe('lease_lost');
    const first = workerSpawnResponseSchema.parse(
      (await post(w, WORKER_PATHS.spawn, w.runId, pkg.runToken, { epoch: 1 })).json(),
    );
    w.harness.clock.advance(1_000);
    const again = workerSpawnResponseSchema.parse(
      (await post(w, WORKER_PATHS.spawn, w.runId, pkg.runToken, { epoch: 1 })).json(),
    );
    expect(again).toEqual(first);
    expect(w.harness.types().filter((type) => type === 'run.started')).toHaveLength(1);
  });

  it('finish: settled, then already_settled with the same ending; lease_lost for a stale epoch; a bad stop reason is a 400', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    await post(w, WORKER_PATHS.spawn, w.runId, pkg.runToken, { epoch: 1 });
    const body = bodies(1)[WORKER_PATHS.finish];
    const stale = await post(w, WORKER_PATHS.finish, w.runId, pkg.runToken, { ...body, epoch: 2 });
    expect(workerLeaseLostBodySchema.parse(stale.json()).error.code).toBe('lease_lost');
    const invalid = await post(w, WORKER_PATHS.finish, w.runId, pkg.runToken, {
      ...body,
      stop_reason: 'felt_like_it',
    });
    expect(invalid.statusCode).toBe(400);
    const first = workerFinishResponseSchema.parse(
      (await post(w, WORKER_PATHS.finish, w.runId, pkg.runToken, body)).json(),
    );
    expect(first.outcome).toBe('settled');
    const eventsAfter = w.harness.types().length;
    const again = workerFinishResponseSchema.parse(
      (await post(w, WORKER_PATHS.finish, w.runId, pkg.runToken, body)).json(),
    );
    expect(again).toEqual({ ...first, outcome: 'already_settled' });
    expect(w.harness.types()).toHaveLength(eventsAfter);
  });

  it('late-cost: run_live while live; recorded once another writer ended the run, and a replay records nothing', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const body = bodies(1)[WORKER_PATHS.lateCost];
    const live = await post(w, WORKER_PATHS.lateCost, w.runId, pkg.runToken, body);
    expect(`${live.statusCode} ${live.json().error?.code}`).toBe('409 run_live');
    // A cancel ended in place (no fence): the worker learns of it and reports what it burned.
    await w.harness.memory.transaction(async (scope) =>
      w.harness.store.runs.finish(scope.tx, {
        runId: w.runId,
        status: 'cancelled',
        terminalReason: 'cancelled',
        sessionId: null,
        numTurns: 0,
        usage: USAGE,
        cost: null,
        wallMs: 0,
      }),
    );
    const stale = await post(w, WORKER_PATHS.lateCost, w.runId, pkg.runToken, {
      ...body,
      epoch: 2,
    });
    expect(workerLeaseLostBodySchema.parse(stale.json()).error.code).toBe('lease_lost');
    const first = await post(w, WORKER_PATHS.lateCost, w.runId, pkg.runToken, body);
    expect(workerLateCostResponseSchema.parse(first.json())).toEqual({ recorded: true });
    const again = await post(w, WORKER_PATHS.lateCost, w.runId, pkg.runToken, body);
    expect(workerLateCostResponseSchema.parse(again.json())).toEqual({ recorded: false });
  });
});

describe('the worker protocol (WP-282): the run-scoped calls besides the claim', () => {
  it('transcript: 200 with the stored count, the planted secret re-redacted, an undecodable entry refused by seq; 413 past 256 KiB; 400 past the largest seq; lease_lost for a stale epoch', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const response = await post(w, WORKER_PATHS.transcript, w.runId, pkg.runToken, {
      epoch: 1,
      entries: [
        { seq: 0, event: transcriptEntry(0, `token ${PROJECT_SECRET} here`, w.runId) },
        { seq: 1, event: { kind: 'assistant' } },
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(workerTranscriptResponseSchema.parse(response.json())).toEqual({
      stored: 2,
      refused_seqs: [1],
    });
    const rows = w.runCallStore.transcriptRows(w.runId);
    expect(JSON.stringify(rows)).not.toContain(PROJECT_SECRET);
    expect(rows.map((row) => (row.kind === 'system' ? row.subtype : row.kind))).toEqual([
      'assistant',
      'ingest_refused',
    ]);
    const big = await post(w, WORKER_PATHS.transcript, w.runId, pkg.runToken, {
      epoch: 1,
      entries: [{ seq: 2, event: transcriptEntry(2, 'x'.repeat(300 * 1024), w.runId) }],
    });
    expect(big.statusCode).toBe(413);
    const seq = await post(w, WORKER_PATHS.transcript, w.runId, pkg.runToken, {
      epoch: 1,
      entries: [{ seq: 2 ** 31, event: transcriptEntry(2, 'x', w.runId) }],
    });
    expect(`${seq.statusCode} ${seq.json().error?.code}`).toBe('400 seq_out_of_range');
    const stale = await post(w, WORKER_PATHS.transcript, w.runId, pkg.runToken, {
      ...bodies(2)[WORKER_PATHS.transcript],
    });
    expect(workerLeaseLostBodySchema.parse(stale.json()).error.code).toBe('lease_lost');
  });

  it('transcript: 409 transcript_full for a batch past the run’s bound, storing nothing of it (backlog 754)', async () => {
    const w = await world({ maxTranscriptEntries: 1 });
    const pkg = await claimAsAlice(w);
    const full = await post(w, WORKER_PATHS.transcript, w.runId, pkg.runToken, {
      epoch: 1,
      entries: [
        { seq: 0, event: transcriptEntry(0, 'one', w.runId) },
        { seq: 1, event: transcriptEntry(1, 'two', w.runId) },
      ],
    });
    expect(`${full.statusCode} ${full.json().error?.code}`).toBe('409 transcript_full');
    expect(w.runCallStore.transcriptRows(w.runId)).toHaveLength(0);
  });

  it('tools/:name: a granted tool answered and redacted; a tool the role was not given is 403; an unknown name is 400; lease_lost for a stale epoch', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    expect(pkg.run.platformTools).toContain('get_task_context');
    const answered = await w.app.inject({
      method: 'POST',
      url: url(WORKER_PATHS.tool, w.runId, 'get_task_context'),
      headers: bearer(pkg.runToken),
      payload: bodies(1)[WORKER_PATHS.tool],
    });
    expect(answered.statusCode).toBe(200);
    const body = workerToolCallResponseSchema.parse(answered.json());
    expect(body.is_error).toBe(false);
    expect(JSON.stringify(body)).not.toContain(PROJECT_SECRET);
    expect(pkg.run.platformTools).not.toContain('open_mr');
    const notGranted = await w.app.inject({
      method: 'POST',
      url: url(WORKER_PATHS.tool, w.runId, 'open_mr'),
      headers: bearer(pkg.runToken),
      payload: { epoch: 1, tool_use_id: 'toolu_x', input: { title: 't', description: 'd' } },
    });
    expect(`${notGranted.statusCode} ${notGranted.json().error?.code}`).toBe(
      '403 tool_not_granted',
    );
    const unknown = await w.app.inject({
      method: 'POST',
      url: url(WORKER_PATHS.tool, w.runId, 'rm_rf'),
      headers: bearer(pkg.runToken),
      payload: bodies(1)[WORKER_PATHS.tool],
    });
    expect(unknown.statusCode).toBe(400);
    const stale = await w.app.inject({
      method: 'POST',
      url: url(WORKER_PATHS.tool, w.runId, 'get_task_context'),
      headers: bearer(pkg.runToken),
      payload: bodies(2)[WORKER_PATHS.tool],
    });
    expect(workerLeaseLostBodySchema.parse(stale.json()).error.code).toBe('lease_lost');
  });

  it('approvals: the id, the same id for a repeat, and the decision on the next heartbeat — once', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const opened = workerApprovalResponseSchema.parse(
      (
        await post(
          w,
          WORKER_PATHS.approvals,
          w.runId,
          pkg.runToken,
          bodies(1)[WORKER_PATHS.approvals],
        )
      ).json(),
    );
    const again = workerApprovalResponseSchema.parse(
      (
        await post(
          w,
          WORKER_PATHS.approvals,
          w.runId,
          pkg.runToken,
          bodies(1)[WORKER_PATHS.approvals],
        )
      ).json(),
    );
    expect(again).toEqual(opened);
    // The decision is written after the open's commit; the held heartbeat is woken by it.
    let approvals: unknown[] = [];
    for (let attempt = 0; attempt < 50 && approvals.length === 0; attempt += 1) {
      const beat = await post(w, WORKER_PATHS.heartbeat, w.runId, pkg.runToken, {
        epoch: 1,
        acks: [],
      });
      approvals = workerHeartbeatResponseSchema.parse(beat.json()).approvals;
    }
    expect(approvals).toEqual([
      {
        approval_id: opened.approval_id,
        decision: 'deny',
        reason: 'unattended: denied',
        question_id: null,
      },
    ]);
    const next = await post(w, WORKER_PATHS.heartbeat, w.runId, pkg.runToken, {
      epoch: 1,
      acks: [],
    });
    expect(workerHeartbeatResponseSchema.parse(next.json()).approvals).toEqual([]);
  });

  it('session: 204, stored redacted once per position; lease_lost for a stale epoch', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    for (const _ of [1, 2]) {
      const response = await post(w, WORKER_PATHS.session, w.runId, pkg.runToken, {
        epoch: 1,
        session_id: 'sess-1',
        from_line: 0,
        lines: ['{"a":1}', `{"t":"${PROJECT_SECRET}"}`],
      });
      expect(response.statusCode).toBe(204);
    }
    const rows = w.runCallStore.sessionRows(w.runId);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(PROJECT_SECRET);
    const stale = await post(w, WORKER_PATHS.session, w.runId, pkg.runToken, {
      ...bodies(2)[WORKER_PATHS.session],
    });
    expect(workerLeaseLostBodySchema.parse(stale.json()).error.code).toBe('lease_lost');
  });

  it('ssh-sign: a signature the deploy key’s public key verifies, null for what the oracle refuses and past the cap', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const signed = workerSshSignResponseSchema.parse(
      (
        await post(w, WORKER_PATHS.sshSign, w.runId, pkg.runToken, bodies(1)[WORKER_PATHS.sshSign])
      ).json(),
    );
    expect(signed.signature).not.toBeNull();
    // The SSH signature blob: string "ssh-ed25519", string <64-byte signature> (RFC 8709 § 6).
    const blob = Buffer.from(signed.signature ?? '', 'base64');
    const signature = blob.subarray(blob.length - 64);
    const raw = deployKeyBlob().subarray(deployKeyBlob().length - 32);
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, userauth(), publicKey, signature)).toBe(true);
    // Another user is not a git login: refused, and not counted.
    const other = await post(w, WORKER_PATHS.sshSign, w.runId, pkg.runToken, {
      ...bodies(1)[WORKER_PATHS.sshSign],
      data: userauth('root').toString('base64'),
    });
    expect(workerSshSignResponseSchema.parse(other.json()).signature).toBeNull();
    expect(w.runCallStore.signatures(w.runId)).toBe(1);
    // The world's cap is two.
    await post(w, WORKER_PATHS.sshSign, w.runId, pkg.runToken, bodies(1)[WORKER_PATHS.sshSign]);
    const capped = await post(
      w,
      WORKER_PATHS.sshSign,
      w.runId,
      pkg.runToken,
      bodies(1)[WORKER_PATHS.sshSign],
    );
    expect(workerSshSignResponseSchema.parse(capped.json()).signature).toBeNull();
    expect(w.runCallStore.signatures(w.runId)).toBe(2);
  });

  it('ssh-sign: refuses a stale epoch and a sign after the terminal write (TD-031’s 2026-11-04 amendment)', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const stale = await post(w, WORKER_PATHS.sshSign, w.runId, pkg.runToken, {
      ...bodies(2)[WORKER_PATHS.sshSign],
    });
    expect(workerLeaseLostBodySchema.parse(stale.json()).error.code).toBe('lease_lost');
    await post(w, WORKER_PATHS.spawn, w.runId, pkg.runToken, { epoch: 1 });
    const finished = await post(
      w,
      WORKER_PATHS.finish,
      w.runId,
      pkg.runToken,
      bodies(1)[WORKER_PATHS.finish],
    );
    expect(finished.statusCode).toBe(200);
    const late = await post(
      w,
      WORKER_PATHS.sshSign,
      w.runId,
      pkg.runToken,
      bodies(1)[WORKER_PATHS.sshSign],
    );
    expect(`${late.statusCode} ${late.json().error?.code}`).toBe('409 lease_lost');
    expect(w.runCallStore.signatures(w.runId)).toBe(0);
  });

  it('answers an authenticated call 503 by name in a process that composed none', async () => {
    const w = await world({ runCalls: false });
    const pkg = await claimAsAlice(w);
    for (const verb of [
      WORKER_PATHS.transcript,
      WORKER_PATHS.tool,
      WORKER_PATHS.approvals,
      WORKER_PATHS.session,
      WORKER_PATHS.sshSign,
    ]) {
      const response = await post(w, verb, w.runId, pkg.runToken, bodies(1)[verb]);
      expect(`${verb} ${response.statusCode} ${response.json().error?.code}`).toBe(
        `${verb} 503 worker_protocol_unavailable`,
      );
    }
  });
});

/**
 * WP-285 (TD-031 decision 11): `POST pause` stores a usage limit's pause; the claim refuses the
 * worker until it ends, and then takes it back by itself. A person's hold is another column.
 */
describe('the worker protocol (WP-285): a usage limit’s pause', () => {
  it('stores the pause, refuses the claim until it ends and then claims, and never touches the owner’s hold', async () => {
    const w = await world();
    const now = w.harness.clock.epochMs;
    const until = new Date(now + 60 * 60_000).toISOString();
    const paused = await post(w, WORKER_PATHS.pause, '', w.alice.credential, {
      until,
      reason: 'usage_limited',
      estimated: true,
    });
    expect(paused.statusCode).toBe(204);
    expect(w.store.worker(w.alice.workerId)).toMatchObject({
      pausedReason: 'usage_limited',
      pausedUntilEstimated: true,
      manuallyPausedAt: null,
    });
    expect(w.store.worker(w.alice.workerId)?.pausedUntil?.toISOString()).toBe(until);
    // Not a person's act: no audit row.
    expect(
      w.store.audit.filter(
        (row) => row.action === 'worker.pause' || row.action === 'worker.resume',
      ),
    ).toEqual([]);
    // The claim's eligibility leaves the paused worker out until the pause ends …
    const claim = (at: number) =>
      w.remote.claim({
        workerId: w.alice.workerId,
        heldImageDigests: HELD,
        images: { run: DIGESTS.platform_runtime, egress: DIGESTS.platform_egress },
        now: new Date(at).toISOString() as never,
      });
    expect((await claim(now + 60 * 60_000 - 1)).kind).not.toBe('claimed');
    // … and takes it back by itself once it has.
    expect((await claim(now + 60 * 60_000 + 1)).kind).toBe('claimed');
    // A repeat stores the same.
    const again = await post(w, WORKER_PATHS.pause, '', w.alice.credential, {
      until,
      reason: 'usage_limited',
    });
    expect(again.statusCode).toBe(204);
    expect(w.store.worker(w.alice.workerId)?.pausedUntilEstimated).toBe(false);
  });

  /**
   * TD-031's 2026-11-05 amendment: a usage limit excludes nobody from the re-offer. The limited
   * worker's own pause keeps it off until the reset; another worker may take the re-offer at once,
   * and on a single-worker core the same worker takes it back after its pause ends.
   */
  const limitAndReoffer = async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    await post(w, WORKER_PATHS.spawn, w.runId, pkg.runToken, { epoch: 1 });
    const reset = w.harness.clock.epochMs + 60 * 60_000;
    // As a worker does: its pause before the finish of the run its limit ended.
    expect(
      (
        await post(w, WORKER_PATHS.pause, '', w.alice.credential, {
          until: new Date(reset).toISOString(),
          reason: 'usage_limited',
        })
      ).statusCode,
    ).toBe(204);
    const body = bodies(1)[WORKER_PATHS.finish];
    const finished = await post(w, WORKER_PATHS.finish, w.runId, pkg.runToken, {
      ...body,
      outcome: { ...body.outcome, status: 'failed', terminal_reason: 'rate_limited' },
    });
    expect(finished.statusCode).toBe(200);
    await w.harness.drain();
    const reoffer = w.harness.store.offerRows().find((row) => row.state === 'open');
    expect(reoffer, 'the stage is offered once more').toBeDefined();
    expect(reoffer?.runId).not.toBe(w.runId);
    const claim = (workerId: Id, at: number) =>
      w.remote.claim({
        workerId,
        heldImageDigests: HELD,
        images: { run: DIGESTS.platform_runtime, egress: DIGESTS.platform_egress },
        now: new Date(at).toISOString() as never,
      });
    return { w, reset, reoffer, claim };
  };

  it('a single worker: limited, its stage re-offered excluding nobody, and it claims it back once its pause ends', async () => {
    const { w, reset, reoffer, claim } = await limitAndReoffer();
    expect((await claim(w.alice.workerId, reset - 1)).kind).not.toBe('claimed');
    const back = await claim(w.alice.workerId, reset + 1);
    expect(back.kind).toBe('claimed');
    expect(back.kind === 'claimed' ? back.package.runId : null).toBe(reoffer?.runId);
  });

  it('another worker takes the re-offer at once, while the limited one waits out its pause', async () => {
    const { w, reoffer, claim } = await limitAndReoffer();
    const now = w.harness.clock.epochMs;
    expect((await claim(w.alice.workerId, now)).kind).not.toBe('claimed');
    const other = await claim(w.bob.workerId, now);
    expect(other.kind).toBe('claimed');
    expect(other.kind === 'claimed' ? other.package.runId : null).toBe(reoffer?.runId);
  });

  it('refuses a pause past eight days, and a reason it does not know', async () => {
    const w = await world();
    const far = await post(w, WORKER_PATHS.pause, '', w.alice.credential, {
      until: new Date(Date.now() + 9 * 86_400_000).toISOString(),
      reason: 'usage_limited',
    });
    expect(`${far.statusCode} ${far.json().error?.code}`).toBe('400 pause_too_long');
    const unknown = await post(w, WORKER_PATHS.pause, '', w.alice.credential, {
      until: new Date(Date.now() + 3_600_000).toISOString(),
      reason: 'tired',
    });
    expect(unknown.statusCode).toBe(400);
    expect(w.store.worker(w.alice.workerId)?.pausedUntil).toBeNull();
  });
});

describe('the worker protocol (WP-292): protocol 2, the owner’s pause and the local page’s cancel', () => {
  const V1 = { 'x-worker-protocol': '1' };
  const asV1 = (secret: string) => ({ authorization: `Bearer ${secret}`, ...V1 });
  /** The version-1 shapes, strict: what a version-1 worker parses with (TD-031's amendment §5). */

  it('refuses a version-1 worker at the protocol check since protocol 3 (accepted [2, 3], WP-293)', async () => {
    const w = await world();
    for (const verb of [WORKER_PATHS.handshake, WORKER_PATHS.claims] as const) {
      const response = await w.app.inject({
        method: 'POST',
        url: url(verb),
        headers: asV1(w.alice.credential),
        payload: bodies(1)[verb],
      });
      expect(`${verb} ${response.statusCode}`).toBe(`${verb} 426`);
      expect(workerUpgradeRequiredBodySchema.parse(response.json()).accepted).toEqual([2, 3]);
    }
  });

  it('answers a version-2 worker the display block and its manual pause', async () => {
    const w = await world();
    const handshake = await post(w, WORKER_PATHS.handshake, '', w.alice.credential, {
      image_digests: HELD,
      commit: null,
    });
    expect(
      workerHandshakeResponseSchema.parse(handshake.json()).worker.manually_paused_at,
    ).toBeNull();
    const pkg = await claimAsAlice(w);
    expect(pkg.display).toEqual(DISPLAY);
  });

  it('refuses both owner verbs at protocol 1 with 426, before the credential is read', async () => {
    const w = await world();
    for (const [verb, runId] of [
      [WORKER_PATHS.manualPause, undefined],
      [WORKER_PATHS.runCancel, w.runId],
    ] as const) {
      const response = await w.app.inject({
        method: 'POST',
        url: url(verb, runId),
        headers: { ...V1, 'idempotency-key': 'k-426' },
        payload: bodies(1)[verb],
      });
      expect(`${verb} ${response.statusCode}`).toBe(`${verb} 426`);
      // Since protocol 3 the generic check refuses version 1 first; the verbs' own gate at 2 is
      // unreachable while the accepted range is [2, 3], and stays for the range it was written for.
      const body = workerUpgradeRequiredBodySchema.parse(response.json());
      expect(body.error.message).toContain('worker protocol 1');
    }
  });

  it('update-report: 204 and one worker.update row under the worker’s user per report; the newest is the worker’s last update; a bad body is 400 (WP-287 (4))', async () => {
    const w = await world();
    const report = (body: object) =>
      post(w, WORKER_PATHS.updateReport, '', w.alice.credential, body);
    const newer = { ...DIGESTS, platform: `sha256:${'9'.repeat(64)}` };
    expect((await w.store.listWorkers(null)).every((row) => row.lastUpdate === null)).toBe(true);
    const succeeded = await report({ from: DIGESTS, to: newer, result: 'succeeded', detail: null });
    expect(succeeded.statusCode).toBe(204);
    expect(succeeded.headers['cache-control']).toBe('no-store');
    const refused = await report({
      from: newer,
      to: DIGESTS,
      result: 'failed',
      detail: 'a downgrade is refused',
    });
    expect(refused.statusCode).toBe(204);
    expect(w.store.audit.filter((row) => row.action === 'worker.update')).toEqual([
      {
        userId: ALICE,
        action: 'worker.update',
        params: {
          worker_id: w.alice.workerId,
          result: 'succeeded',
          from: DIGESTS,
          to: newer,
          detail: null,
        },
      },
      {
        userId: ALICE,
        action: 'worker.update',
        params: {
          worker_id: w.alice.workerId,
          result: 'failed',
          from: newer,
          to: DIGESTS,
          detail: 'a downgrade is refused',
        },
      },
    ]);
    const alice = (await w.store.listWorkers(null)).find((row) => row.id === w.alice.workerId);
    expect(alice?.lastUpdate).toMatchObject({
      result: 'failed',
      from: newer,
      to: DIGESTS,
      detail: 'a downgrade is refused',
    });
    const bob = (await w.store.listWorkers(null)).find((row) => row.id === w.bob.workerId);
    expect(bob?.lastUpdate).toBeNull();
    for (const bad of [
      { from: DIGESTS, to: newer, result: 'applied', detail: null },
      { from: DIGESTS, to: { ...newer, platform: 'latest' }, result: 'succeeded', detail: null },
      { from: DIGESTS, to: newer, result: 'succeeded', detail: 'x'.repeat(4_097) },
      { from: DIGESTS, to: newer, result: 'succeeded', detail: null, extra: true },
    ]) {
      expect((await report(bad)).statusCode).toBe(400);
    }
    expect(w.store.audit.filter((row) => row.action === 'worker.update')).toHaveLength(2);
  });

  it('manual-pause: a state assertion — one audit row per change, the claim answered 204 while held', async () => {
    const w = await world();
    const pause = (paused: boolean) =>
      post(w, WORKER_PATHS.manualPause, '', w.alice.credential, { paused, via: 'worker_ui' });
    const first = await pause(true);
    expect(first.statusCode).toBe(200);
    const held = workerManualPauseResponseSchema.parse(first.json());
    expect(held.performed).toBe(true);
    expect(held.manually_paused_at).not.toBeNull();
    // Idempotent replay: the same state, nothing written.
    const again = workerManualPauseResponseSchema.parse((await pause(true)).json());
    expect(again).toEqual({ manually_paused_at: held.manually_paused_at, performed: false });
    expect(w.store.audit.filter((row) => row.action === 'worker.pause')).toEqual([
      {
        userId: ALICE,
        action: 'worker.pause',
        params: { worker_id: w.alice.workerId, via: 'worker_ui' },
      },
    ]);
    // The handshake now says so, and a claim is answered at once with nothing.
    const handshake = await post(w, WORKER_PATHS.handshake, '', w.alice.credential, {
      image_digests: HELD,
      commit: null,
    });
    expect(workerHandshakeResponseSchema.parse(handshake.json()).worker.manually_paused_at).toBe(
      held.manually_paused_at,
    );
    const refused = await post(
      w,
      WORKER_PATHS.claims,
      '',
      w.alice.credential,
      bodies(1)[WORKER_PATHS.claims],
    );
    expect(refused.statusCode).toBe(204);
    expect(w.harness.store.offerRows()[0]?.state).toBe('open');
    // The claim's own eligibility leaves a held worker out too (the store's, not only the route's).
    expect(
      (
        await w.remote.claim({
          workerId: w.alice.workerId,
          heldImageDigests: HELD,
          images: { run: DIGESTS.platform_runtime, egress: DIGESTS.platform_egress },
          now: new Date(w.harness.clock.epochMs).toISOString() as never,
        })
      ).kind,
    ).not.toBe('claimed');
    const resumed = workerManualPauseResponseSchema.parse((await pause(false)).json());
    expect(resumed).toEqual({ manually_paused_at: null, performed: true });
    expect(w.store.audit.filter((row) => row.action === 'worker.resume')).toHaveLength(1);
    const claimed = await post(
      w,
      WORKER_PATHS.claims,
      '',
      w.alice.credential,
      bodies(1)[WORKER_PATHS.claims],
    );
    expect(claimed.statusCode).toBe(200);
  });

  it('runs/:id/cancel: the task page’s cancel as the worker’s user — 202, the task paused, one audit row, delivered on the heartbeat', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const cancel = (key: string | null) =>
      w.app.inject({
        method: 'POST',
        url: url(WORKER_PATHS.runCancel, pkg.runId),
        headers: { ...bearer(pkg.runToken), ...(key === null ? {} : { 'idempotency-key': key }) },
        payload: { reason: 'leaving for the day' },
      });
    expect((await cancel(null)).statusCode).toBe(400);
    expect(w.cancel.actions).toEqual([]);
    const first = await cancel('local-cancel-1');
    expect(first.statusCode).toBe(202);
    const answer = workerRunCancelResponseSchema.parse(first.json());
    expect(answer).toMatchObject({ run_id: pkg.runId, task_state: 'paused', performed: true });
    expect(answer.command_id).not.toBeNull();
    expect(w.cancel.actions).toHaveLength(1);
    expect(w.cancel.actions[0]).toMatchObject({
      userId: ALICE,
      action: 'run.cancel',
      taskId: pkg.run.taskId,
      params: {
        run_id: pkg.runId,
        via: 'worker_ui',
        worker_id: w.alice.workerId,
        command_id: answer.command_id,
      },
    });
    // Idempotent replay: the first attempt's answer, nothing performed, no second row.
    const replay = await cancel('local-cancel-1');
    expect(replay.statusCode).toBe(202);
    expect(workerRunCancelResponseSchema.parse(replay.json())).toMatchObject({
      performed: false,
      command_id: answer.command_id,
    });
    expect(w.cancel.actions).toHaveLength(1);
    // The worker's own heartbeat delivers the stop.
    const beat = await post(w, WORKER_PATHS.heartbeat, pkg.runId, pkg.runToken, {
      epoch: pkg.epoch,
      acks: [],
    });
    expect(beat.statusCode).toBe(200);
    expect(workerHeartbeatResponseSchema.parse(beat.json()).commands).toEqual([
      expect.objectContaining({ id: answer.command_id, kind: 'cancel' }),
    ]);
  });

  it('runs/:id/cancel: a user below run.cancel is 403, and the run continues', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    w.cancel.projectRoles.set(ALICE, 'viewer');
    const response = await w.app.inject({
      method: 'POST',
      url: url(WORKER_PATHS.runCancel, pkg.runId),
      headers: { ...bearer(pkg.runToken), 'idempotency-key': 'local-cancel-403' },
      payload: {},
    });
    expect(`${response.statusCode} ${response.json().error?.code}`).toBe('403 forbidden');
    expect(w.cancel.actions).toEqual([]);
    expect(w.harness.store.runCommandRows()).toEqual([]);
    const run = await w.harness.store.runs.load({} as never, pkg.runId as Id);
    expect(run?.status).toBe('starting');
    // The control that it was the role: as a member the same request is accepted.
    w.cancel.projectRoles.set(ALICE, 'member');
    const accepted = await w.app.inject({
      method: 'POST',
      url: url(WORKER_PATHS.runCancel, pkg.runId),
      headers: { ...bearer(pkg.runToken), 'idempotency-key': 'local-cancel-403' },
      payload: {},
    });
    expect(accepted.statusCode).toBe(202);
  });
});

describe('the worker protocol (WP-293): protocol 3, the claim scope and take this one', () => {
  const V2 = { 'x-worker-protocol': '2' };
  /** A foreign project: nobody here may take its runs. */
  const ELSEWHERE = '00000000-0000-4000-8000-0000000293e1';
  /** The four new verbs, each with its method and a valid body. */
  const PICK_VERBS = (runId: string) =>
    [
      { method: 'GET', verb: WORKER_PATHS.claimScope, path: url(WORKER_PATHS.claimScope) },
      {
        method: 'PUT',
        verb: WORKER_PATHS.claimScope,
        path: url(WORKER_PATHS.claimScope),
        payload: { claim_project_ids: [] },
      },
      { method: 'GET', verb: WORKER_PATHS.offers, path: url(WORKER_PATHS.offers) },
      {
        method: 'POST',
        verb: WORKER_PATHS.offerClaim,
        path: url(WORKER_PATHS.offerClaim, runId),
        payload: { image_digests: HELD },
      },
    ] as const;
  const call = (
    w: World,
    entry: ReturnType<typeof PICK_VERBS>[number],
    headers: Record<string, string>,
  ) =>
    w.app.inject({
      method: entry.method,
      url: entry.path,
      headers,
      ...('payload' in entry ? { payload: entry.payload } : {}),
    });
  const setScope = (w: World, ids: readonly string[] | null, secret = w.alice.credential) =>
    w.app.inject({
      method: 'PUT',
      url: url(WORKER_PATHS.claimScope),
      headers: bearer(secret),
      payload: { claim_project_ids: ids },
    });
  /** The list is computed against the digests the worker last reported (its handshake's). */
  const offersOf = async (w: World, secret = w.alice.credential) => {
    await post(w, WORKER_PATHS.handshake, '', secret, { image_digests: HELD, commit: null });
    const response = await w.app.inject({
      method: 'GET',
      url: url(WORKER_PATHS.offers),
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(200);
    return workerOffersResponseSchema.parse(response.json()).offers;
  };
  const pick = (w: World, runId: string, secret = w.alice.credential) =>
    w.app.inject({
      method: 'POST',
      url: url(WORKER_PATHS.offerClaim, runId),
      headers: bearer(secret),
      payload: { image_digests: HELD },
    });

  it('protocol 3 is current and accepts [2, 3]; a version-2 handshake carries no claim_project_ids', async () => {
    expect(WORKER_PROTOCOL_VERSION).toBe(3);
    expect([...ACCEPTED_WORKER_PROTOCOLS]).toEqual([2, 3]);
    const w = await world();
    // The version-2 shape, strict: what a version-2 worker parses with.
    const v2Settings = workerSettingsSchema.omit({ claim_project_ids: true });
    const v2 = await w.app.inject({
      method: 'POST',
      url: url(WORKER_PATHS.handshake),
      headers: { authorization: `Bearer ${w.alice.credential}`, ...V2 },
      payload: bodies(1)[WORKER_PATHS.handshake],
    });
    expect(v2.statusCode).toBe(200);
    const v2Worker = v2.json().worker;
    expect(v2Settings.safeParse(v2Worker).success).toBe(true);
    expect(Object.hasOwn(v2Worker, 'claim_project_ids')).toBe(false);
    expect(Object.hasOwn(v2Worker, 'manually_paused_at')).toBe(true);
    const v3 = await post(w, WORKER_PATHS.handshake, '', w.alice.credential, {
      image_digests: HELD,
      commit: null,
    });
    expect(workerHandshakeResponseSchema.parse(v3.json()).worker.claim_project_ids).toBeNull();
    await setScope(w, []);
    const after = await post(w, WORKER_PATHS.handshake, '', w.alice.credential, {
      image_digests: HELD,
      commit: null,
    });
    expect(workerHandshakeResponseSchema.parse(after.json()).worker.claim_project_ids).toEqual([]);
  });

  it('refuses all four verbs at protocol 2 with 426, before the credential is read', async () => {
    const w = await world();
    for (const entry of PICK_VERBS(w.runId)) {
      const response = await call(w, entry, { ...V2 });
      expect(`${entry.method} ${entry.verb} ${response.statusCode}`).toBe(
        `${entry.method} ${entry.verb} 426`,
      );
      expect(response.headers['cache-control']).toBe('no-store');
      const body = workerUpgradeRequiredBodySchema.parse(response.json());
      expect(body.error.message).toContain('protocol 3');
    }
  });

  it('refuses no credential, a wrong one, a run token, a revoked worker and a disabled user with 401', async () => {
    const w = await world();
    const pkg = await claimAsAlice(w);
    const wrongWorker = `wkr_${'a'.repeat(26)}_${'b'.repeat(43)}`;
    for (const entry of PICK_VERBS(w.runId)) {
      for (const headers of [PROTOCOL, bearer(wrongWorker), bearer(pkg.runToken)]) {
        const response = await call(w, entry, headers);
        expect(`${entry.method} ${entry.verb} ${response.statusCode}`).toBe(
          `${entry.method} ${entry.verb} 401`,
        );
      }
    }
    w.store.setUserMayAct(BOB, false);
    for (const entry of PICK_VERBS(w.runId)) {
      expect((await call(w, entry, bearer(w.bob.credential))).statusCode).toBe(401);
    }
    await w.store.revokeWorker({
      workerId: w.alice.workerId,
      ownerUserId: null,
      actorUserId: ALICE,
      now: new Date(),
    });
    for (const entry of PICK_VERBS(w.runId)) {
      expect((await call(w, entry, bearer(w.alice.credential))).statusCode).toBe(401);
    }
  });

  it('claim-scope: the projects it may name; a state assertion with one audit row per change, 422 for a project the user may not run', async () => {
    const w = await world();
    const read = await w.app.inject({
      method: 'GET',
      url: url(WORKER_PATHS.claimScope),
      headers: bearer(w.alice.credential),
    });
    expect(read.statusCode).toBe(200);
    expect(workerClaimScopeResponseSchema.parse(read.json())).toEqual({
      claim_project_ids: null,
      projects: [{ id: PROJECT, key: 'ACME', name: 'Acme storefront' }],
    });
    const audits = () => w.store.audit.filter((row) => row.action === 'worker.claim_scope');
    // The stored value already: nothing written.
    expect(workerClaimScopeSetResponseSchema.parse((await setScope(w, null)).json())).toEqual({
      claim_project_ids: null,
      performed: false,
    });
    expect(audits()).toHaveLength(0);
    const named = workerClaimScopeSetResponseSchema.parse(
      (await setScope(w, [PROJECT, PROJECT])).json(),
    );
    expect(named).toEqual({ claim_project_ids: [PROJECT], performed: true });
    expect(audits()).toEqual([
      {
        userId: ALICE,
        action: 'worker.claim_scope',
        params: { worker_id: w.alice.workerId, project_ids: [PROJECT], via: 'worker_ui' },
      },
    ]);
    expect((await setScope(w, [PROJECT])).json()).toMatchObject({ performed: false });
    expect(audits()).toHaveLength(1);
    const refused = await setScope(w, [PROJECT, ELSEWHERE]);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('project_not_eligible');
    expect(refused.json().error.message).toContain(ELSEWHERE);
    expect(audits()).toHaveLength(1);
    expect(w.store.worker(w.alice.workerId)?.claimProjects).toEqual([{ id: PROJECT, key: 'ACME' }]);
    expect((await setScope(w, [])).json()).toEqual({ claim_project_ids: [], performed: true });
    expect(audits()).toHaveLength(2);
    // Bob's worker is his own: Alice's scope is not his.
    expect(w.store.worker(w.bob.workerId)?.claimProjects).toBeNull();
  });

  it('a pick-only worker claims nothing by itself, lists the offer, takes it — one audit row — and a second take is 409', async () => {
    const w = await world();
    expect((await setScope(w, [])).statusCode).toBe(200);
    const automatic = await post(w, WORKER_PATHS.claims, '', w.alice.credential, {
      free_slots: 1,
      image_digests: HELD,
      paused: false,
    });
    expect(automatic.statusCode).toBe(204);
    const listed = await offersOf(w);
    expect(listed).toEqual([
      expect.objectContaining({
        run_id: w.runId,
        kind: 'stage',
        project_key: DISPLAY.projectKey,
        ticket_key: DISPLAY.ticketKey,
        title: DISPLAY.title,
        automatic: false,
      }),
    ]);
    // Bob's scope is every project: the same offer is his automatic take.
    expect((await offersOf(w, w.bob.credential))[0]?.automatic).toBe(true);
    const taken = await pick(w, w.runId);
    expect(taken.statusCode).toBe(200);
    expect(taken.headers['cache-control']).toBe('no-store');
    const pkg = runPackageSchema.parse(taken.json());
    expect(pkg.runId).toBe(w.runId);
    expect(pkg.display).toEqual(DISPLAY);
    expect(w.takes).toEqual([
      { workerId: w.alice.workerId, runId: w.runId, taskId: pkg.run.taskId },
    ]);
    // Taken: neither listed nor claimable again, by anybody — and the one refusal names no reason.
    expect(await offersOf(w)).toEqual([]);
    expect(await offersOf(w, w.bob.credential)).toEqual([]);
    for (const secret of [w.alice.credential, w.bob.credential]) {
      const again = await pick(w, w.runId, secret);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('offer_not_claimable');
    }
    expect((await pick(w, '00000000-0000-4000-8000-0000000293ff')).statusCode).toBe(409);
    expect(w.takes).toHaveLength(1);
  });

  it('a take is refused while the worker is held by its owner, and admitted again once resumed', async () => {
    const w = await world();
    await post(w, WORKER_PATHS.manualPause, '', w.alice.credential, {
      paused: true,
      via: 'worker_ui',
    });
    expect(await offersOf(w)).toEqual([]);
    expect((await pick(w, w.runId)).statusCode).toBe(409);
    expect(w.takes).toHaveLength(0);
    await post(w, WORKER_PATHS.manualPause, '', w.alice.credential, {
      paused: false,
      via: 'worker_ui',
    });
    expect((await pick(w, w.runId)).statusCode).toBe(200);
    expect(w.takes).toHaveLength(1);
  });

  it('a scope naming the project still claims it automatically; the offers answer 503 while the core cannot name its images', async () => {
    const w = await world();
    await setScope(w, [PROJECT]);
    expect((await offersOf(w))[0]?.automatic).toBe(true);
    const pkg = await claimAsAlice(w);
    expect(pkg.runId).toBe(w.runId);
    const blind = await world({ release: false });
    const response = await blind.app.inject({
      method: 'GET',
      url: url(WORKER_PATHS.offers),
      headers: bearer(blind.alice.credential),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('digests_unresolved');
  });

  it('releases a package whose worker went away before the answer, rather than sending it nowhere (BACKLOG 960)', async () => {
    let hangUp: (() => void) | null = null;
    let armed = true;
    const w = await world({
      beforeMint: async () => {
        if (!armed) return;
        armed = false;
        // The claim has committed; the worker calls its request off now (a Pause, a Take).
        hangUp?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    });
    await post(w, WORKER_PATHS.handshake, '', w.alice.credential, {
      image_digests: HELD,
      commit: null,
    });
    const address = await w.app.listen({ port: 0, host: '127.0.0.1' });
    const outcome = await new Promise<string>((resolve) => {
      const request = http.request(
        `${address}${url(WORKER_PATHS.offerClaim, w.runId)}`,
        {
          method: 'POST',
          headers: { ...bearer(w.alice.credential), 'content-type': 'application/json' },
        },
        (response) => resolve(`answered ${response.statusCode}`),
      );
      request.on('error', () => resolve('gone'));
      hangUp = () => request.destroy();
      request.end(JSON.stringify({ image_digests: HELD }));
    });
    expect(outcome).toBe('gone');
    // The claim was undone — the offer open, the run created again, nobody excluded …
    await waitUntil(() => w.harness.types().includes('run.offer.released'));
    const offer = w.harness.store.offerRows().find((row) => row.runId === w.runId);
    expect(offer?.state).toBe('open');
    // … so the same worker takes it at once, and this time receives it.
    const again = await pick(w, w.runId);
    expect(again.statusCode).toBe(200);
    expect(runPackageSchema.parse(again.json()).runId).toBe(w.runId);
    expect(w.harness.types().filter((type) => type === 'run.offer.released')).toHaveLength(1);
  });
});
