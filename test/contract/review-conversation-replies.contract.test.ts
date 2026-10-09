/**
 * **A reply to a person's general note lands in a different discussion, and the platform still posts
 * it once** — WP-179 criterion (8), over the **fake git provider at its default**
 * (`individualNoteReplies: 'new_note'`, its divergence 31, the GitLab adapter's fallback; contract
 * tier, because the application unit tier may not import `@platform/integrations`).
 *
 * The fake answers a reply to an individual note with a **new** general note — its own discussion,
 * a new id — whose body keeps the reply at the start. The duty is driven twice through an executor
 * that **records no idempotency** (a pass-through), which is the replay the executor cannot cover:
 * the adapter's fallback is a POST and then a read, so a failure after the POST leaves no answer to
 * replay. What stops the second post is the duty's own check, which finds the reply **by the marker
 * its body opens with, across every discussion** — never by the discussion it asked for, nor by the
 * id the call returned.
 *
 * The canary (recorded in PROGRESS under WP-179): with `runConversationReplies`' check narrowed to
 * the target discussion — what matching by the returned id amounts to — the second pass posts the
 * reply again and the count below is 2.
 */
import {
  conversationReplyNoteMarker,
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
import { createFakeGitProvider, FAKE_GIT_PROVIDER_ID } from '@platform/integrations';
import { describe, expect, it } from 'vitest';

const PROJECT = '00000000-0000-4000-8000-0000000017c1' as Id;
const INTEGRATION = '00000000-0000-4000-8000-0000000017c2' as Id;
const TASK = '00000000-0000-4000-8000-0000000017c3' as Id;
const RUN = '00000000-0000-4000-8000-0000000017c4' as Id;
const NOTES = '00000000-0000-4000-8000-0000000017c5' as Id;
const REPO = 'acme/api';
const AT = '2026-06-01T09:00:00.000Z';

const world = async () => {
  const fake = createFakeGitProvider({
    integrationId: INTEGRATION,
    projects: [{ path: REPO, defaultBranch: 'main' }],
  });
  const opened = await fake.openMergeRequest({
    project: REPO,
    branch: 'agentic/ACME-1',
    target: 'main',
    title: 'Draft: totals',
    description: '',
    draft: true,
    labels: [],
    reviewers: [],
    remove_source_branch: true,
  });
  const asked = fake.addGeneralNote({
    project: REPO,
    iid: opened.ref.iid,
    authorId: 'person-1',
    text: 'Please also add the VAT line.',
  });
  const integrations: PipelineIntegrations = {
    executor: {
      execute: async (request: { perform: () => Promise<unknown> }) => ({
        status: 'ok' as const,
        result: await request.perform(),
      }),
    } as unknown as PipelineIntegrations['executor'],
    git: {
      port: fake,
      ref: { integrationId: INTEGRATION, provider: FAKE_GIT_PROVIDER_ID, type: 'git', host: null },
      project: REPO,
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
        ticket: { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
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
      branch: 'agentic/ACME-1',
      mr: opened.ref,
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
        mr: { url: opened.ref.url, iid: opened.ref.iid },
        thread_replies: [{ thread_id: asked.id, kind: 'fixed', reply: 'Added the VAT line.' }],
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
        cause_event_id: '00000000-0000-4000-9000-0000000017c1',
        artifact_id: NOTES,
      },
    );
  return { fake, ref: opened.ref, asked, run };
};

describe('a reply to a general note, at the fake’s default (WP-179 criterion 8)', () => {
  it('lands in a new discussion, and a replay with no idempotency record posts it once', async () => {
    const { fake, ref, asked, run } = await world();
    await run();
    await run();

    const marker = conversationReplyNoteMarker(TASK, RUN, 0);
    const listed = await fake.listDiscussions(ref);
    const replies = listed.flatMap((discussion) =>
      discussion.notes
        .filter((note) => note.body.startsWith(marker))
        .map((note) => ({ discussion: discussion.id, body: note.body })),
    );
    expect(replies).toHaveLength(1);
    // It is not in the discussion it answered: the fallback made one of its own.
    expect(replies[0]?.discussion).not.toBe(asked.id);
    expect(listed.find((discussion) => discussion.id === asked.id)?.notes).toHaveLength(1);
  });
});
