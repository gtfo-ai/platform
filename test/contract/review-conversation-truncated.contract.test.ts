/**
 * **A reply on the page after `max_pages` is not posted again** — WP-209 (c), backlog 577, through
 * the **real GitLab adapter** in replay and the real `runConversationReplies` duty (contract tier,
 * because the application unit tier may not import the adapter).
 *
 * `test/fixtures/http/gitlab/discussions-paged.json` is a merge request with two pages of
 * discussions: a person's general note on the first and, on the second, the reply the platform
 * already posted to it (its marker, the binding's account). The duty runs with an executor that
 * records no idempotency, so what stops a second post is the duty's own marker search.
 *
 * - `max_pages: 2` (the control): the search sees the reply and nothing is posted.
 * - `max_pages: 1`: the adapter refuses the cut list (`invalid_response`), the duty fails, and
 *   nothing is posted — the job's retry, and its exhaustion's escalation, are the next step.
 *
 * The canary (PROGRESS, WP-209): the adapter answering the cut list instead of refusing it, and
 * the second case posts the reply a second time.
 */
import {
  createMemoryPipelineStore,
  exactSecretRedactor,
  MemoryEventing,
  type PipelineIntegrations,
  runConversationReplies,
  type StoredTask,
  silentLogger,
  staticPipelineIntegrations,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { GITLAB_HOST, GITLAB_PROJECT } from './support/integrations/gitlab-fixtures.js';
import {
  GITLAB_INTEGRATION_ID,
  gitlabReplayContext,
} from './support/integrations/gitlab-harness.js';

const PROJECT = '00000000-0000-4000-8000-0000000020a1' as Id;
const NOTES = '00000000-0000-4000-8000-0000000020a2' as Id;
// The marker on the fixture's second page is built from these two ids and reply index 0.
const TASK = '00000000-0000-4000-8000-0000000020a3' as Id;
const RUN = '00000000-0000-4000-8000-0000000020a4' as Id;
const AT = '2026-06-01T09:00:00.000Z';
const MR = {
  provider: 'gitlab',
  project_path: GITLAB_PROJECT,
  iid: 31,
  url: `${GITLAB_HOST}/acme/api/-/merge_requests/31`,
  branch: 'agentic/ACME-31',
  head_sha: null,
};

const world = async (maxPages: number) => {
  const { port, replay } = gitlabReplayContext({ config: { max_pages: maxPages } });
  const integrations: PipelineIntegrations = {
    executor: {
      execute: async (request: { perform: () => Promise<unknown> }) => ({
        status: 'ok' as const,
        result: await request.perform(),
      }),
    } as unknown as PipelineIntegrations['executor'],
    git: {
      port,
      ref: { integrationId: GITLAB_INTEGRATION_ID, provider: 'gitlab', type: 'git', host: null },
      project: GITLAB_PROJECT,
      redactor: exactSecretRedactor([]),
    },
    taskManagement: null,
    communication: null,
  };
  const memory = new MemoryEventing();
  const store = createMemoryPipelineStore();
  await memory.transaction(async (scope) => {
    await store.tasks.insert(scope.tx, {
      task: {
        id: TASK,
        projectId: PROJECT,
        ticket: { provider: 'fake-jira', key: 'ACME-31', url: 'https://jira.example.test/ACME-31' },
        template: 'feature',
        mode: 'normal',
        state: 'active',
        currentStage: 'code_review',
        stageAttempts: { implementation: 2 },
        iterationCounters: {},
        limits: {},
        sequence: 1,
      },
      template: FEATURE_TEMPLATE,
      priorityRank: 2,
      createdAt: AT,
      branch: MR.branch,
      mr: MR,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      ticketSnapshot: null,
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
      pipelineDial: null,
      qaStage: false,
      ticketSnapshotAt: null,
      ticketSignalAt: null,
      version: 1,
    } as unknown as StoredTask);
    await store.artifacts.insert(scope.tx, {
      id: NOTES,
      taskId: TASK,
      type: 'ImplementationNotes',
      version: 1,
      markdown: null,
      data: {
        summary: 'Added the VAT line.',
        deviations_from_plan: [],
        tests_added: [],
        commands_run: [],
        known_gaps: [],
        followup_tickets: [],
        mr: { url: MR.url, iid: MR.iid },
        thread_replies: [
          {
            thread_id: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee01',
            kind: 'fixed',
            reply: 'Added the VAT line.',
          },
        ],
      },
      schemaVersion: '1',
      producedByRunId: RUN,
      createdAt: AT as never,
      redactionCount: 0,
    });
  });
  const run = () =>
    runConversationReplies(
      {
        unitOfWork: memory,
        store,
        logger: silentLogger,
        integrations: staticPipelineIntegrations(integrations),
      },
      {
        duty: 'conversation_replies',
        project_id: PROJECT,
        task_id: TASK,
        cause_event_id: '00000000-0000-4000-9000-0000000020a1',
        artifact_id: NOTES,
      },
    );
  const posts = () =>
    replay.requests.filter((request) => !request.key.startsWith('GET ')).map((r) => r.key);
  return { run, replay, posts };
};

describe('a reply already on page max_pages + 1 (WP-209 (c), backlog 577)', () => {
  it('is found by its marker when max_pages reaches its page, and is not posted again', async () => {
    const { run, replay, posts } = await world(2);
    await run();
    expect(
      replay.requests.map((request) => request.key),
      'both pages were read',
    ).toContain('GET /projects/acme%2Fapi/merge_requests/31/discussions?page=2&per_page=100');
    expect(posts()).toEqual([]);
  });

  it('is not posted again when max_pages stops before its page: the cut read is refused', async () => {
    const { run, replay, posts } = await world(1);
    let caught: unknown;
    try {
      await run();
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code, 'the truncation, typed').toBe(
      'invalid_response',
    );
    expect(String((caught as Error).message)).toContain('max_pages (1)');
    expect(replay.requests.map((request) => request.key)).toEqual([
      'GET /projects/acme%2Fapi/merge_requests/31/discussions?page=1&per_page=100',
    ]);
    expect(posts(), 'nothing is posted on an unknown read').toEqual([]);
  });
});
