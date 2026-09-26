/**
 * WP-17's two composition criteria, against a running `apps/server` instance — and WP-57's first:
 *
 *  - **`GET /api/runs/:id/context-pack` serves the pack this repository's own planner produced** —
 *    for every run, equal to the record `run.started` carried, read back out of the rows the
 *    production `RunRepository.insert` wrote (PROGRESS backlog 31);
 *
 *  - **a stage run writes a `ContextPackRecord` that is not zeroed** — read back out of the
 *    `run.started` event the instance appended, not out of the planner's return value;
 *  - **`kb_search` is callable from a run** — through the `PlatformToolPort` that instance composed
 *    for itself, reached the only way a run can reach it.
 *
 * ## Why this cannot pass for the wrong reason
 *
 * The pack is built by the **production** assembler over the **production** PostgreSQL knowledge
 * store on the instance's own pool; nothing here supplies either. The vault is seeded with the same
 * `FIXTURE_VAULT` every other retrieval tier measures (standing rule 5 — one corpus, one parser),
 * through the same `PostgresKnowledgeStore` the indexer writes with. And the negative half is
 * anchored by a positive one: the run whose record we assert is the run whose `RunSpec` we read the
 * prompt out of, and that prompt is required to contain the vault's own text inside a data block.
 *
 * The fake Claude runner does not call platform tools (divergence 6 of its register), so
 * `StartPipelineOptions.kbSearchQuery` makes the harness call `kb_search` from inside `start` with
 * the context the real runner would build. What is a double is the model; what is production is the
 * port, the store, the pool and the composition.
 */
import type { Transaction } from '@platform/application';
import {
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_PROJECT_KEY,
  FIXTURE_VAULT,
  vaultRelativePath,
} from '@platform/application';
import { type ContextPackRecord, contextPackRecordSchema, type Id } from '@platform/contracts';
import { parseKbDocument, readDataBlocks } from '@platform/domain';
import { knowledge } from '@platform/infrastructure';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** Indexes the fixture vault into the instance's database, for the instance's project. */
const seedVault = async (pipeline: PipelineE2E): Promise<void> => {
  const client = new pg.Client({ connectionString: pipeline.database.connectionString });
  await client.connect();
  try {
    const documents = FIXTURE_VAULT.flatMap((document) => {
      const parsed = parseKbDocument({
        path: document.path,
        vaultRelativePath: vaultRelativePath(document.path, FIXTURE_KNOWLEDGE_DIR),
        source: document.source,
        projectKey: FIXTURE_PROJECT_KEY,
      });
      return parsed.status === 'ok'
        ? [{ document: parsed.document, blobSha: document.contentHash }]
        : [];
    });
    expect(documents.length).toBeGreaterThan(10);
    await new knowledge.PostgresKnowledgeStore(client).write(
      { adapter: 'postgres', client } as unknown as Transaction,
      {
        projectId: pipeline.projectId as Id,
        commitSha: 'f1c7ea4',
        documents,
        removedPaths: [],
        refused: [],
      },
    );
  } finally {
    await client.end();
  }
};

interface StartedPack {
  readonly runId: string;
  readonly pack: ContextPackRecord;
}

const runStartedPacks = async (pipeline: PipelineE2E): Promise<StartedPack[]> => {
  const client = new pg.Client({ connectionString: pipeline.database.connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{
      payload: { run_id: string; context_pack: ContextPackRecord };
    }>("select payload from events where type = 'run.started' order by position");
    return rows.map((row) => ({ runId: row.payload.run_id, pack: row.payload.context_pack }));
  } finally {
    await client.end();
  }
};

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

describe('the context pack a composed instance builds', () => {
  it('is written to run.started, is not zeroed, and reaches the prompt as delimited data', async () => {
    harness = await startPipeline({
      label: 'context-pack',
      scenarios: featureScenarios,
      tickets: TICKETS,
      kbSearchQuery: 'session service fixture rollback',
    });
    await seedVault(harness);

    await harness.publish([
      inboundEvent('ticket.matched', {
        project_id: harness.projectId,
        ticket: {
          provider: 'fake-task-management',
          key: 'ACME-1',
          url: 'https://tickets.example.test/browse/ACME-1',
        },
        rule: 'label:agentic',
        priority: 'High',
        issue_type: 'Story',
        epic: null,
        links: [],
      }),
    ]);
    // BD-007: the platform never merges, so the feature template stops here. Five agent stages
    // have run by then, which is what makes "every run's pack" a set rather than one sample.
    await harness.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    // 1. the record — the thing WP-15 wrote as five zeroes.
    const started = await runStartedPacks(harness);
    const packs = started.map((entry) => entry.pack);
    expect(packs.length).toBeGreaterThan(0);
    const first = packs[0] as ContextPackRecord;
    expect(first.budget_tokens).toBe(12_000);
    expect(first.tier0.length).toBeGreaterThan(0);
    expect(first.total_tokens).toBeGreaterThan(0);
    expect(packs.every((pack) => pack.budget_tokens > 0)).toBe(true);

    // 1b. the audit — WP-57, criterion 1. `GET /api/runs/:id/context-pack` serves, for every run,
    // exactly the record this instance's own planner built and `run.started` carried: read back
    // out of `run_context_pack` and the run row, which the production `RunRepository.insert`
    // wrote in the transaction that created the run. Never a seeded table (standing rule 82).
    const client = await signIn(harness.instance.baseUrl);
    for (const { runId, pack } of started) {
      const served = await client.json<ContextPackRecord>(`/api/runs/${runId}/context-pack`);
      expect(served.status, JSON.stringify(served.body)).toBe(200);
      expect(contextPackRecordSchema.parse(served.body)).toEqual(pack);
    }
    // Not vacuous: at least one served pack names documents, so the rows were written and read.
    expect(packs.some((pack) => pack.tier0.length + pack.tier1.length > 0)).toBe(true);
    const counted = new pg.Client({ connectionString: harness.database.connectionString });
    await counted.connect();
    try {
      const { rows } = await counted.query<{ count: string }>(
        'select count(*) from run_context_pack',
      );
      expect(Number(rows[0]?.count)).toBe(
        packs.reduce((total, pack) => total + pack.tier0.length + pack.tier1.length, 0),
      );
    } finally {
      await counted.end();
    }

    // 2. the prompt — every document inside the delimiter, nothing left in the platform's voice.
    const specs = harness.specs.filter((spec) => spec.contextPack.length > 0);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      const reading = readDataBlocks(spec.userPrompt);
      expect(reading.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(reading.unterminated).toBe(0);
      expect(reading.blocks.length).toBeGreaterThanOrEqual(spec.contextPack.length);
      // The vault's own words are in a block and not in the prose around it.
      const bodies = reading.blocks.map((block) => block.body).join('\n');
      expect(bodies).toContain('The session service owns authentication');
      expect(reading.platformVoice.join('\n')).not.toContain(
        'The session service owns authentication',
      );
    }
    // Each run draws its own nonce: a marker that repeated across runs would be one an attacker
    // could learn from a leaked prompt and reuse in a knowledge page.
    const nonces = specs.map((spec) => readDataBlocks(spec.userPrompt).nonce);
    expect(new Set(nonces).size).toBe(nonces.length);

    // 3. `kb_search`, through the port this instance composed.
    const searches = await harness.kbSearches();
    expect(searches.length).toBeGreaterThan(0);
    for (const call of searches) {
      const payload = call.result as { status: string; hits: readonly { path: string }[] };
      expect(payload.status).toBe('ok');
      expect(payload.hits.length).toBeGreaterThan(0);
    }
  }, 240_000);
});
