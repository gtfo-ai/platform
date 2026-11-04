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
import { createRemoteRuns, type RemoteRuns } from '@platform/application';
import {
  type DomainEvent,
  domainEventSchemasByType,
  type Id,
  runPackageSchema,
  WORKER_API_PREFIX,
  WORKER_PATHS,
  WORKER_PROTOCOL_VERSION,
  workerFinishResponseSchema,
  workerHandshakeResponseSchema,
  workerHeartbeatResponseSchema,
  workerLateCostResponseSchema,
  workerLeaseLostBodySchema,
  workerSpawnResponseSchema,
  workerUpgradeRequiredBodySchema,
} from '@platform/contracts';
import { DEFAULT_WIP_LIMITS } from '@platform/domain';
import { launcher as launcherAdapters } from '@platform/infrastructure';
import { PLATFORM_SKILLS } from '@platform/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../apps/server/src/app.js';
import type { Auth } from '../../../apps/server/src/auth/better-auth.js';
import { loadServerConfig } from '../../../apps/server/src/config.js';
import { createLogger } from '../../../apps/server/src/logging.js';
import { createMetrics } from '../../../apps/server/src/metrics.js';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  createMemoryWorkerStore,
  type MemoryWorkerStore,
} from '../../../apps/server/src/queries/worker-store-memory.js';
import { SseHub } from '../../../apps/server/src/sse/hub.js';
import { workerReleaseOf } from '../../../apps/server/src/workers/release.js';
import {
  hashSecret,
  mintDeviceCodes,
  mintWorkerCredential,
  runTokens,
} from '../../../apps/server/src/workers/secrets.js';
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
  readonly alice: { workerId: Id; credential: string };
  readonly bob: { workerId: Id; credential: string };
  readonly runId: Id;
}

let opened: App | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const world = async (options: { readonly release?: boolean } = {}): Promise<World> => {
  const store = createMemoryWorkerStore();
  store.addUser({ id: ALICE, email: 'alice@example.test', name: null });
  store.addUser({ id: BOB, email: 'bob@example.test', name: null });
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
          memberOf: (projectId) => projectId === PROJECT,
        };
      },
    },
  });
  await harness.publish([ticketMatched('ACME-1', 1)]);
  const remote = createRemoteRuns({
    unitOfWork: harness.memory,
    store: harness.store,
    eventStore: harness.memory.store,
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
        mint: async ({ scope }) => ({
          kind: 'minted',
          credential: {
            username: 'oauth2',
            password: RUN_CREDENTIAL,
            scope,
            expiresAt: '2026-06-02T09:00:00.000Z',
            source: 'minted',
            revoke: async () => {},
          },
        }),
      },
      skills: PLATFORM_SKILLS,
      modelEgressHosts: ['api.anthropic.com'],
      runRegistryHosts: [],
      credentialTtlSeconds: 86_400,
      clock: { now: () => harness.clock.epochMs, setTimer: () => () => {} },
    }),
    credentials: { revoke: async () => {} },
    tokens: runTokens,
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
  const release = workerReleaseOf(options.release === false ? null : DIGESTS);
  // The production composition (`buildApp`): the protocol check is registered before the device
  // flow and the protocol's verbs, exactly as a process that serves the API registers them.
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
      broadcast: harness.memory.broadcast,
      release: () => release,
      holds: { claimMs: 30, heartbeatMs: 30, claimPollMs: 10 },
    },
  });
  opened = app;
  return {
    app,
    harness,
    store,
    remote,
    alice: await registerWorker(store, ALICE),
    bob: await registerWorker(store, BOB),
    runId: harness.store.offerRows()[0]?.runId as Id,
  };
};

const url = (verb: string, runId?: string): string =>
  `${WORKER_API_PREFIX}/${verb.replace(':id', runId ?? '00000000-0000-4000-8000-000000000000')}`;

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
});

/** The verbs WP-281 serves: two authenticated by the worker credential, five by a run token. */
const WORKER_VERBS = [WORKER_PATHS.handshake, WORKER_PATHS.claims] as const;
const RUN_VERBS = [
  WORKER_PATHS.heartbeat,
  WORKER_PATHS.runRelease,
  WORKER_PATHS.spawn,
  WORKER_PATHS.finish,
  WORKER_PATHS.lateCost,
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
          accepted: [WORKER_PROTOCOL_VERSION],
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
    const w = await world();
    const pkg = await claimAsAlice(w);
    const wrongWorker = `wkr_${'a'.repeat(26)}_${'b'.repeat(43)}`;
    for (const verb of WORKER_VERBS) {
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
    const otherRun = '00000000-0000-4000-8000-0000000282ff';
    for (const verb of RUN_VERBS) {
      for (const [runId, headers] of [
        [w.runId, PROTOCOL],
        [w.runId, bearer(w.alice.credential)],
        [w.runId, bearer('x'.repeat(43))],
        [otherRun, bearer(pkg.runToken)],
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
      protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [WORKER_PROTOCOL_VERSION] },
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
    for (const verb of WORKER_VERBS) {
      const response = await post(w, verb, '', w.alice.credential, bodies(1)[verb]);
      expect(`${verb} ${response.statusCode} ${response.json().error?.code}`).toBe(
        `${verb} 503 digests_unresolved`,
      );
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
