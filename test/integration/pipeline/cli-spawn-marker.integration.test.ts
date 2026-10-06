/**
 * The CLI spawn marker is **committed** when the run shim is sent its `spawn` frame — WP-150
 * criterion (2), ruling (b), against a real PostgreSQL 18.
 *
 * The unit tiers hold the rule ("no CLI without the marker") over the in-memory store, which has no
 * transactions (its divergence 11). What only a database can show is the commit order: the marker is
 * written in **its own** transaction by the process holding the run, and that transaction has
 * committed before the frame that starts a CLI leaves the runner. So the production pieces are
 * composed — `recordCliSpawn` over `PostgresUnitOfWork`, `createClaudeRunner` over the real
 * `createRunletSpawn`, a raw runlet server standing in for the shim — and the marker is read from a
 * **second connection** at the moment between `hello.ok` and the send (a hook wrapped around the
 * marker's own), and again when the `spawn` frame arrives. Its negative half: before `hello.ok` the
 * second connection reads null, so the marker is the handshake's and not the insert's.
 */
import {
  INITIAL_TASK_VERSION,
  type PipelineStore,
  type RunStartHooks,
  recordCliSpawn,
  type StoredTask,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { RUNLET_PROTOCOL_VERSION } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES } from '@platform/domain';
import { eventing, pipeline, runlet, runner } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

const NOW = '2026-10-06T09:00:00.000Z' as IsoDateTime;
const TOKEN = 'run-token-wp150-integration-0000';

let database: MigratedDatabase;
let projectId: Id;
let store: PipelineStore;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8150-${counter.toString(16).padStart(12, '0')}` as Id;
};

beforeAll(async () => {
  database = await createMigratedDatabase('cli-spawn-marker');
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('cli-spawn-marker') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as Id;
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

/** A committed task with one `running` run and no marker. */
const liveRun = async (): Promise<Id> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    const taskId = nextId();
    const stored: StoredTask = {
      task: {
        id: taskId,
        projectId,
        ticket: {
          provider: 'fake-jira',
          key: `ACME-${counter}`,
          url: `https://jira.example.test/browse/ACME-${counter}`,
        },
        template: 'feature',
        mode: 'normal',
        state: 'active',
        currentStage: 'implementation' as Slug,
        stageAttempts: { implementation: 1 },
        iterationCounters: {},
        limits: {
          code_review: 3,
          business_review: 2,
          ci_fix: 3,
          human_rounds: 3,
          refinement_questions: 2,
          architecture_revisions: 2,
          rebase: 2,
          rebase_rechecks: 10,
          dependency_policy: 2,
        },
        sequence: 1,
      },
      template: FEATURE_TEMPLATE,
      pipelineDial: null,
      priorityRank: 2,
      createdAt: NOW,
      branch: null,
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      ticketSnapshot: null,
      ticketSnapshotAt: null,
      ticketSignalAt: null,
      reviewSubject: null,
      historySample: null,
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      reviewThreads: null,
      readyHeadSha: null,
      ciHeadSha: null,
      ciExcusedPaths: [],
      requestedByUserId: null,
      version: INITIAL_TASK_VERSION,
    } as unknown as StoredTask;
    await store.tasks.insert(tx, stored);
    const runId = nextId();
    await store.runs.insert(tx, {
      id: runId,
      taskId,
      projectId,
      stage: 'implementation' as Slug,
      role: 'developer',
      mode: 'normal',
      attempt: 1,
      model: 'claude-opus-5',
      effort: 'high',
      promptVersion: 'test@1',
      systemPrompt: null,
      userPrompt: null,
      redactionCount: 0,
      contextPack: null,
      settings: null,
      reserveUsd: 15,
      promptsWithheld: null,
      providerMode: 'api',
      status: 'running',
      terminalReason: null,
      sessionId: null,
      numTurns: 0,
      usage: null,
      cost: null,
      wallMs: 0,
      createdAt: NOW,
      startedAt: NOW,
    });
    await client.query('commit');
    return runId;
  } finally {
    await client.end();
  }
};

/** The marker as **another connection** sees it — only a committed write is visible there. */
const committedMarker = async (runId: Id): Promise<string | null> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    const { rows } = await client.query<{ marker: Date | null }>(
      'select cli_spawn_requested_at as marker from runs where id = $1',
      [runId],
    );
    return rows[0]?.marker?.toISOString() ?? null;
  } finally {
    await client.end();
  }
};

describe('the CLI spawn marker, against PostgreSQL (WP-150)', () => {
  it('is committed, seen from a second connection, when the spawn frame is sent', async () => {
    const runId = await liveRun();
    const pool = createTestPool(database.connectionString, { max: 2 });
    const volume = await runlet.createControlVolume();
    const server = await runlet.createRawServer(volume.controlSocketPath);
    try {
      const record = recordCliSpawn({
        unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
        runs: store.runs,
        now: () => NOW,
        runId,
      });
      const seen: { atSend?: string | null; framesAtSend?: readonly string[] } = {};
      let peerFrames: () => readonly string[] = () => [];
      // The hook between `hello.ok` and the send: the marker's own write, then the second
      // connection's read, before control returns to the gate that sends the frame.
      const hooks: RunStartHooks = {
        beforeCliSpawn: async () => {
          const written = await record.hooks.beforeCliSpawn();
          seen.atSend = await committedMarker(runId);
          seen.framesAtSend = peerFrames();
          return written;
        },
      };
      const transport = runlet.createRunletSpawn({
        socketPath: volume.controlSocketPath,
        token: TOKEN,
        clock: runner.systemClock,
      });
      const claude = runner.createClaudeRunner({
        sink: runner.recordingSink(),
        approvals: runner.scriptedApprovals(),
        tools: runner.recordingTools(),
        clock: runner.systemClock,
        injectedSecretRedactorFor: () => runner.injectedSecretRedactorFixture(),
        spawnClaudeCodeProcess: transport,
      });
      const handle = claude.start(runner.runSpecFixture({ runId, artifactType: null }), hooks);
      const peer = await server.peer();
      peerFrames = () => peer.received.map((decoded) => decoded.frame.type);
      await peer.next('hello');
      // Before the handshake the run has no marker: it is the handshake's, not the insert's.
      expect(await committedMarker(runId)).toBeNull();

      peer.send({ type: 'hello.ok', protocol: RUNLET_PROTOCOL_VERSION });
      await peer.next('spawn');
      expect(seen.atSend).toBe(NOW);
      // The read happened before the frame left the runner.
      expect(seen.framesAtSend).toEqual(['hello']);
      expect(record.requested()).toBe(true);

      // The shim goes away; the run had asked for its CLI, so it is a crash the caps hold.
      peer.close();
      const outcome = await handle.outcome;
      expect(outcome.terminalReason).toBe('crash');
      expect(outcome.costUnmeasured).toBe(true);
    } finally {
      await server.close();
      await volume.cleanup();
      await pool.end();
    }
  });

  it('refuses the marker, on a committed row, for a run another writer ended first', async () => {
    const runId = await liveRun();
    const pool = createTestPool(database.connectionString, { max: 2 });
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    try {
      await unitOfWork.transaction(async (scope) =>
        store.runs.finish(scope.tx, {
          runId,
          status: 'cancelled',
          terminalReason: 'cancelled',
          sessionId: null,
          numTurns: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            cache_read_tokens: 0,
          },
          cost: null,
          wallMs: 0,
        }),
      );
      const record = recordCliSpawn({ unitOfWork, runs: store.runs, now: () => NOW, runId });
      expect(await record.hooks.beforeCliSpawn()).toBe(false);
      expect(record.requested()).toBe(false);
      expect(await committedMarker(runId)).toBeNull();
    } finally {
      await pool.end();
    }
  });
});
