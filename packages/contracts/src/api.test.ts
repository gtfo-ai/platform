import { describe, expect, it } from 'vitest';
import {
  answerQuestionRequestSchema,
  apiErrorSchema,
  auditEntrySchema,
  createProjectRequestSchema,
  createTaskRequestSchema,
  decideApprovalRequestSchema,
  effectiveConfigResponseSchema,
  eventsQuerySchema,
  integrationsResponseSchema,
  kbHealthResponseSchema,
  listTasksQuerySchema,
  orgAuditQuerySchema,
  orgAuditResponseSchema,
  orgUsersResponseSchema,
  paginationQuerySchema,
  projectBindingsResponseSchema,
  projectsResponseSchema,
  putKbDocRequestSchema,
  putProjectBindingsRequestSchema,
  readinessResponseSchema,
  runMessagesQuerySchema,
  sseFrameSchema,
  sseTopicSchema,
  startDiscoveryResponseSchema,
  startShadowRunsRequestSchema,
  steerRunRequestSchema,
  tasksResponseSchema,
  updateProjectConfigRequestSchema,
  updateSubscriptionsRequestSchema,
  webhookDeliverySchema,
} from './api.js';

const uuid = (n: number) => `0199aa11-2b3c-7d4e-8f90-${String(n).padStart(12, '0')}`;
const AT = '2026-09-09T10:15:30Z';

describe('request DTOs', () => {
  it('rejects an unknown key on a command body', () => {
    expect(
      answerQuestionRequestSchema.safeParse({ answer: 'billing', anwser: 'typo' }).success,
    ).toBe(false);
    expect(decideApprovalRequestSchema.safeParse({ decision: 'maybe' }).success).toBe(false);
  });

  it('keeps a steer message bounded so a paste cannot blow up the session', () => {
    expect(steerRunRequestSchema.safeParse({ message: 'x' }).success).toBe(true);
    expect(steerRunRequestSchema.safeParse({ message: '' }).success).toBe(false);
    expect(steerRunRequestSchema.safeParse({ message: 'x'.repeat(10_001) }).success).toBe(false);
  });

  it('caps a shadow batch and requires at least one ticket', () => {
    expect(
      startShadowRunsRequestSchema.safeParse({ ticket_keys: [], budget_usd: 10 }).success,
    ).toBe(false);
    expect(
      startShadowRunsRequestSchema.safeParse({
        ticket_keys: Array.from({ length: 51 }, (_, i) => `PROJ-${i}`),
        budget_usd: 10,
      }).success,
    ).toBe(false);
  });

  it('coerces numeric query parameters from their string form', () => {
    expect(paginationQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
    expect(paginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('narrows a task listing to values the state machine knows', () => {
    expect(listTasksQuerySchema.safeParse({ state: 'waiting_answers' }).success).toBe(true);
    expect(listTasksQuerySchema.safeParse({ state: 'thinking' }).success).toBe(false);
  });

  it('accepts the documented run-message paging parameters', () => {
    expect(runMessagesQuerySchema.parse({ after: '120', limit: '50', partials: '0' })).toEqual({
      after: 120,
      limit: 50,
      partials: '0',
    });
    expect(runMessagesQuerySchema.safeParse({ partials: 'false' }).success).toBe(false);
  });

  it('takes a ticket key, not a whole ticket, to start a task by hand', () => {
    expect(createTaskRequestSchema.parse({ ticket_key: 'PROJ-123' })).toEqual({
      ticket_key: 'PROJ-123',
    });
    expect(createTaskRequestSchema.safeParse({ ticket_key: '' }).success).toBe(false);
  });

  it('writes a knowledge document by path and content only', () => {
    expect(
      putKbDocRequestSchema.parse({ path: 'technical/overview.md', content: '# Overview' }),
    ).toBeTruthy();
    expect(
      putKbDocRequestSchema.safeParse({
        path: 'technical/overview.md',
        content: '',
        commit_sha: 'abc1234',
      }).success,
    ).toBe(false);
  });
});

describe('response DTOs', () => {
  it('describes an error with a machine-readable code', () => {
    expect(apiErrorSchema.parse({ error: { code: 'not_found', message: 'no such task' } })).toEqual(
      {
        error: { code: 'not_found', message: 'no such task' },
      },
    );
    expect(apiErrorSchema.safeParse({ error: { code: 'NotFound', message: 'x' } }).success).toBe(
      false,
    );
  });

  it('reports the effective config with a source per key (technical/12)', () => {
    const response = {
      config: { version: 1 as const, policies: { autonomy: 'supervised' as const } },
      sources: { 'policies.autonomy': 'repo' as const, version: 'default' as const },
      hash: 'sha256:abc',
      computed_at: AT,
      // WP-37: what the wizard is offered for `policies.risk_classes`, which is **not** what the
      // project has — the field above is empty and this one is not, which is the whole shape of
      // "proposed, not applied" (product/18:52).
      risk_class_proposal: {
        source: 'discovery' as const,
        classes: { payments: { paths: ['src/billing/**'], require: ['plan_approval'] } },
        not_expressible: [
          { name: 'public_api', paths: ['**/api/**'], reason: 'no checklist mechanism (Q83)' },
        ],
      },
    };
    expect(effectiveConfigResponseSchema.parse(response)).toEqual(response);
    // A requirement this build cannot act on is refused **by name**, here as everywhere else
    // (PROGRESS backlog 73 (d)): the offer a screen renders goes through the same schema.
    expect(
      effectiveConfigResponseSchema.safeParse({
        ...response,
        risk_class_proposal: {
          ...response.risk_class_proposal,
          classes: { payments: { paths: ['src/billing/**'], require: ['checklist:payments'] } },
        },
      }).success,
    ).toBe(false);
    expect(
      effectiveConfigResponseSchema.safeParse({ ...response, sources: { x: 'guess' } }).success,
    ).toBe(false);
  });

  it('records a webhook delivery as opaque, untrusted data (BD-022)', () => {
    const delivery = {
      provider: 'gitlab',
      delivery_id: 'del_1',
      integration_id: uuid(1),
      received_at: AT,
      headers: { 'x-gitlab-token': '[REDACTED sha256:ab12cd]' },
      payload: { object_kind: 'merge_request', nested: { arrays: [1, 'two', null] } },
    };
    expect(webhookDeliverySchema.parse(delivery)).toEqual(delivery);
  });
});

describe('SSE contract (TD-014)', () => {
  it.each([
    ['org', true],
    [`task:${uuid(1)}`, true],
    [`run:${uuid(2)}`, true],
    [`project:${uuid(3)}`, true],
    ['task:123', false],
    ['everything', false],
  ])('validates topic %s', (topic, expected) => {
    expect(sseTopicSchema.safeParse(topic).success).toBe(expected);
  });

  it('carries a per-topic sequence on replayable frames and none on control frames', () => {
    const control = {
      frame: 'control' as const,
      topic: 'org',
      type: 'ping' as const,
      detail: null,
    };
    expect(sseFrameSchema.parse(control)).toEqual(control);
    expect(sseFrameSchema.safeParse({ ...control, seq: 1 }).success).toBe(false);
  });

  it('rejects a control event outside the documented set', () => {
    expect(
      sseFrameSchema.safeParse({ frame: 'control', topic: 'org', type: 'goodbye' }).success,
    ).toBe(false);
  });

  it('wraps a transcript entry for the run topic', () => {
    const frame = {
      frame: 'transcript' as const,
      topic: `run:${uuid(2)}`,
      seq: 7,
      data: {
        run_id: uuid(2),
        seq: 7,
        created_at: AT,
        parent_tool_use_id: null,
        redaction_count: 0,
        kind: 'steer' as const,
        message: 'use the existing helper',
        author_user_id: uuid(4),
      },
    };
    expect(sseFrameSchema.parse(frame)).toEqual(frame);
  });

  it('subscribes and unsubscribes by topic on an existing connection', () => {
    expect(
      updateSubscriptionsRequestSchema.parse({ connection_id: 'c1', add: ['org'] }),
    ).toBeTruthy();
    expect(
      updateSubscriptionsRequestSchema.safeParse({ connection_id: 'c1', add: ['whatever'] })
        .success,
    ).toBe(false);
  });

  it('takes topics as one comma-separated query parameter', () => {
    expect(eventsQuerySchema.parse({ topics: `org,task:${uuid(1)}` })).toBeTruthy();
    expect(eventsQuerySchema.safeParse({ topics: '' }).success).toBe(false);
  });

  it('accepts a connection id and resume cursors on the events query', () => {
    expect(
      eventsQuerySchema.parse({
        topics: 'org',
        connection_id: 'c1',
        last_event_id: `org:4,task:${uuid(1)}:9`,
      }),
    ).toBeTruthy();
    expect(eventsQuerySchema.safeParse({ topics: 'org', connection_id: '' }).success).toBe(false);
    expect(eventsQuerySchema.safeParse({ topics: 'org', cursor: 'x' }).success).toBe(false);
  });

  it('lets a connection-level control frame omit the topic and a topic-level one carry it', () => {
    // ping and shutdown are about the socket; reset is about one topic's cursor (technical/08).
    expect(sseFrameSchema.parse({ frame: 'control', type: 'shutdown' })).toEqual({
      frame: 'control',
      type: 'shutdown',
    });
    expect(
      sseFrameSchema.parse({ frame: 'control', topic: 'org', type: 'reset', detail: 'gap' }),
    ).toBeTruthy();
    // A topic is still validated when present.
    expect(
      sseFrameSchema.safeParse({ frame: 'control', topic: 'nope', type: 'reset' }).success,
    ).toBe(false);
  });
});

describe('org DTOs', () => {
  it('lists users and rejects an unknown status', () => {
    const user = {
      id: uuid(1),
      email: 'ada@example.test',
      name: 'Ada',
      role: 'maintainer' as const,
      status: 'active' as const,
    };
    expect(orgUsersResponseSchema.parse({ items: [user] })).toBeTruthy();
    expect(
      orgUsersResponseSchema.safeParse({ items: [{ ...user, status: 'banned' }] }).success,
    ).toBe(false);
  });

  it('pages the audit log and keeps the diff opaque', () => {
    const entry = {
      id: uuid(2),
      entity_type: 'project',
      entity_id: uuid(3),
      user_id: null,
      diff: { autonomy: 'changed' },
      created_at: AT,
    };
    expect(orgAuditResponseSchema.parse({ items: [entry], next_cursor: null })).toBeTruthy();
    expect(auditEntrySchema.safeParse({ ...entry, unexpected: 1 }).success).toBe(false);
    expect(orgAuditQuerySchema.parse({ limit: 10, entity_type: 'project' })).toEqual({
      limit: 10,
      entity_type: 'project',
    });
  });
});

/**
 * The four envelopes WP-15h part 2 published.
 *
 * Three of them were composed in `apps/web/src/api/endpoints.ts` while nothing served the routes
 * (Q45), so the cases that matter are the ones that would catch a shape that drifted while it was
 * being moved: which of them carries `next_cursor`, and that all four stay strict.
 */
describe('the list envelopes and the KB health report', () => {
  const project = {
    id: uuid(10),
    key: 'api',
    name: 'API',
    repo_url: 'https://git.example.test/acme/api.git',
    default_branch: 'main',
    agentic_dir: '.agentic',
    knowledge_dir: '.agentic/knowledge',
    autonomy_level: 'supervised' as const,
    readiness_level: 2,
    status: 'active' as const,
    created_at: AT,
    updated_at: AT,
    open_tasks: 3,
    spent_usd_30d: 12.5,
  };

  it('lists projects without a cursor, because the client does not page them', () => {
    expect(projectsResponseSchema.parse({ items: [project] })).toBeTruthy();
    // The absence of `next_cursor` is the contract, not an oversight: adding one here would make
    // the client's "render every project" true of one page only.
    expect(projectsResponseSchema.safeParse({ items: [project], next_cursor: null }).success).toBe(
      false,
    );
    expect(
      projectsResponseSchema.safeParse({ items: [{ ...project, open_tasks: -1 }] }).success,
    ).toBe(false);
  });

  it('lists integrations without a cursor and keeps the config opaque', () => {
    const integration = {
      id: uuid(11),
      type: 'git' as const,
      provider: 'gitlab',
      name: 'acme gitlab',
      config: { base_url: 'https://gitlab.example.test' },
      health: { status: 'unknown' as const, checked_at: null, detail: null },
    };
    expect(integrationsResponseSchema.parse({ items: [integration] })).toBeTruthy();
    expect(
      integrationsResponseSchema.safeParse({
        items: [{ ...integration, health: { status: 'fine', checked_at: null, detail: null } }],
      }).success,
    ).toBe(false);
    expect(
      integrationsResponseSchema.safeParse({ items: [integration], next_cursor: null }).success,
    ).toBe(false);
  });

  it('pages tasks, because a project accumulates them without bound', () => {
    const task = {
      id: uuid(12),
      project_id: uuid(10),
      ticket: { provider: 'jira-cloud', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
      template: 'feature',
      mode: 'normal' as const,
      state: 'active' as const,
      current_stage: 'refinement',
      iteration_counters: {},
      risk_classes: [],
      coverage: null,
      dependencies: null,
      required_reviewers: null,
      conflict: null,
      cost_actual_usd: 0,
      cost_estimated_usd: 0,
      estimate_usd: null,
      estimate_basis: null,
      estimate_samples: null,
      estimate_accuracy: null,
      created_at: AT,
      updated_at: AT,
    };
    expect(tasksResponseSchema.parse({ items: [task], next_cursor: null })).toBeTruthy();
    expect(
      tasksResponseSchema.parse({ items: [task], next_cursor: `${AT}|${uuid(12)}` }),
    ).toBeTruthy();
    // `next_cursor` is required, not optional: "no more pages" and "the field was forgotten" would
    // otherwise be the same response.
    expect(tasksResponseSchema.safeParse({ items: [task] }).success).toBe(false);
  });

  it('publishes one health report, with its findings bounded to the kinds the domain computes', () => {
    const report = {
      id: uuid(13),
      project_id: uuid(10),
      commit_sha: 'a'.repeat(40),
      documents: 12,
      findings: [{ kind: 'expired' as const, path: 'kb/api.md', detail: 'last touched in March' }],
      source: 'hygiene' as const,
      created_at: AT,
    };
    expect(kbHealthResponseSchema.parse(report)).toBeTruthy();
    // A project whose vault has never been committed has no commit; a report with none is still a
    // report (the index can be empty).
    expect(
      kbHealthResponseSchema.parse({ ...report, commit_sha: null, findings: [] }),
    ).toBeTruthy();
    expect(kbHealthResponseSchema.safeParse({ ...report, source: 'cron' }).success).toBe(false);
    expect(
      kbHealthResponseSchema.safeParse({
        ...report,
        findings: [{ kind: 'stale', path: 'kb/api.md', detail: 'x' }],
      }).success,
    ).toBe(false);
    expect(kbHealthResponseSchema.safeParse({ ...report, unexpected: 1 }).success).toBe(false);
  });
});

describe('the onboarding wizard’s DTOs (WP-21, product/06)', () => {
  it('creates a project from the facts an operator types, and nothing else', () => {
    expect(
      createProjectRequestSchema.parse({
        key: 'acme_api',
        name: 'ACME API',
        repo_url: 'https://git.example.test/acme/api.git',
      }),
    ).toEqual({
      key: 'acme_api',
      name: 'ACME API',
      repo_url: 'https://git.example.test/acme/api.git',
    });
    // The dial is step 4, through the preset: accepting it here would give a project a second way
    // to be configured, and that one would skip `applyAutonomyPreset`.
    expect(
      createProjectRequestSchema.safeParse({
        key: 'acme_api',
        name: 'ACME API',
        repo_url: 'https://git.example.test/acme/api.git',
        autonomy_level: 'autonomous',
      }).success,
    ).toBe(false);
    // A key is a slug: it ends up in URLs and in a branch name.
    expect(
      createProjectRequestSchema.safeParse({
        key: 'ACME API',
        name: 'ACME API',
        repo_url: 'https://git.example.test/acme/api.git',
      }).success,
    ).toBe(false);
  });

  it('bounds the knowledge directory and keeps it repository-relative', () => {
    const project = {
      key: 'acme_api',
      name: 'ACME API',
      repo_url: 'https://git.example.test/acme/api.git',
    };
    // The value the platform joins a model-chosen page path onto, so it is the directory itself
    // that has to be relative and bounded — both sides asserted (rule 42).
    expect(
      createProjectRequestSchema.parse({ ...project, knowledge_dir: '.agentic/knowledge' })
        .knowledge_dir,
    ).toBe('.agentic/knowledge');
    for (const bad of ['/etc', '../outside', 'a/../../b', './here', 'x'.repeat(513), '']) {
      expect(
        createProjectRequestSchema.safeParse({ ...project, knowledge_dir: bad }).success,
        bad,
      ).toBe(false);
    }
    // …and a branch name is bounded too: it reaches git arguments and an audit row.
    expect(
      createProjectRequestSchema.safeParse({ ...project, default_branch: 'x'.repeat(256) }).success,
    ).toBe(false);
  });

  it('takes the whole binding set rather than a delta, so the step is re-submittable', () => {
    expect(
      putProjectBindingsRequestSchema.parse({
        items: [
          { integration_id: uuid(1) },
          { integration_id: uuid(2), config: { project: 'acme/api' } },
        ],
      }).items,
    ).toHaveLength(2);
    // An empty list is legal and means "this project is bound to nothing" — a fact, not a mistake.
    expect(putProjectBindingsRequestSchema.parse({ items: [] }).items).toEqual([]);
    expect(
      projectBindingsResponseSchema.parse({
        items: [
          {
            integration_id: uuid(1),
            type: 'git',
            provider: 'gitlab',
            name: 'acme gitlab',
            config: { project: 'acme/api' },
          },
        ],
      }).items[0]?.provider,
    ).toBe('gitlab');
  });

  it('writes a whole config document with the dial beside it, and refuses an unknown key', () => {
    const body = { config: { version: 1 }, autonomy_level: 'supervised' as const };
    expect(updateProjectConfigRequestSchema.parse(body).autonomy_level).toBe('supervised');
    // The dial is optional: editing the limits should not force a caller to restate it.
    expect(updateProjectConfigRequestSchema.parse({ config: { version: 1 } }).autonomy_level).toBe(
      undefined,
    );
    expect(
      updateProjectConfigRequestSchema.safeParse({ ...body, autonomy_level: 'yolo' }).success,
    ).toBe(false);
    expect(
      updateProjectConfigRequestSchema.safeParse({ config: { version: 1, nope: true } }).success,
    ).toBe(false);
  });

  it('answers a discovery start with the task the run belongs to', () => {
    expect(
      startDiscoveryResponseSchema.parse({
        task_id: uuid(3),
        started: true,
        detail: 'discovery queued',
      }).started,
    ).toBe(true);
    // `started: false` is the idempotent answer, not an error: a second call must not spend a
    // second budget on the same question.
    expect(
      startDiscoveryResponseSchema.parse({
        task_id: uuid(3),
        started: false,
        detail: 'this project already has a discovery task',
      }).started,
    ).toBe(false);
  });

  it('publishes a readiness evaluation with who detected each criterion', () => {
    const response = {
      level: 2,
      evaluated_at: AT,
      source: 'discovery',
      criteria: [
        {
          id: 'R1',
          passed: true,
          evidence: 'ran `pnpm test`: 42 passed',
          unlocks: 'Implementation self-check',
          detected_by: 'agent' as const,
        },
        {
          id: 'R9',
          passed: false,
          evidence: 'the default branch is not protected',
          unlocks: 'Human merge guarantee (BD-007)',
          detected_by: 'platform' as const,
        },
      ],
      next_improvements: [{ id: 'R9', title: 'Protected default branch', unlocks: 'BD-007' }],
    };
    expect(readinessResponseSchema.parse(response).level).toBe(2);
    // `detected_by` is the field that says whether a model's word was taken for a criterion, so a
    // row without it is not a readiness record.
    expect(
      readinessResponseSchema.safeParse({
        ...response,
        criteria: [{ id: 'R1', passed: true, evidence: '', unlocks: '' }],
      }).success,
    ).toBe(false);
    expect(readinessResponseSchema.safeParse({ ...response, level: 9 }).success).toBe(false);
  });
});
