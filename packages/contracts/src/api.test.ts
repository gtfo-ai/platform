import { describe, expect, it } from 'vitest';
import {
  answerQuestionRequestSchema,
  apiErrorSchema,
  auditEntrySchema,
  businessInterviewRequestSchema,
  ciManualNotRunSchema,
  createProjectRequestSchema,
  createTaskRequestSchema,
  decideApprovalRequestSchema,
  effectiveConfigResponseSchema,
  eventsQuerySchema,
  exportProjectConfigRequestSchema,
  exportProjectConfigResponseSchema,
  inboxEscalatedSchema,
  inboxResponseSchema,
  integrationsResponseSchema,
  kbHealthResponseSchema,
  lifecycleErrorCodeSchema,
  listTasksQuerySchema,
  MAX_CI_MANUAL_NOT_RUN_JOBS,
  MAX_INBOX_ESCALATED,
  MAX_QUEUE_WAIT_HOLDERS,
  MAX_TASK_STOP_RECORDED_CHARS,
  MAX_TICKET_KEY_CHARS,
  orgAuditQuerySchema,
  orgAuditResponseSchema,
  orgUsersResponseSchema,
  ownerCandidatesResponseSchema,
  paginationQuerySchema,
  patchIntegrationRequestSchema,
  pipelineGraphSchema,
  projectBindingsResponseSchema,
  projectPipelineQuerySchema,
  projectPipelinesResponseSchema,
  projectsResponseSchema,
  putKbDocRequestSchema,
  putProjectBindingsRequestSchema,
  queueWaitSchema,
  readinessResponseSchema,
  runActivitySchema,
  runMessagesQuerySchema,
  runSeatSchema,
  setDefaultBranchRequestSchema,
  setupStateResponseSchema,
  sseFrameSchema,
  sseTopicSchema,
  startDiscoveryResponseSchema,
  startShadowRunsRequestSchema,
  steerRunRequestSchema,
  TASK_CALLER_FACT_KEYS,
  taskDetailResponseSchema,
  taskExportResponseSchema,
  taskReturnSchema,
  taskStopSchema,
  tasksResponseSchema,
  ticketStatusesResponseSchema,
  updateProjectConfigRequestSchema,
  updateSubscriptionsRequestSchema,
  webhookDeliverySchema,
} from './api.js';
import { MAX_TICKET_STATUSES } from './common.js';

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

  /**
   * WP-122: the key is untrusted text on its way into a provider's URL, so its character set is
   * fixed and anything outside it is refused rather than escaped; and the template and mode the
   * unserved sketch carried are refused, because a manual start bypasses the pick-up rule and
   * nothing else (classification included).
   */
  it('refuses a ticket key outside its character set, and every field but the key', () => {
    for (const key of ['ACME-1', 'acme_2.x', 'X', 'A'.repeat(MAX_TICKET_KEY_CHARS)]) {
      expect(createTaskRequestSchema.safeParse({ ticket_key: key }).success, key).toBe(true);
    }
    for (const key of [
      '../ACME-1',
      'ACME-1/comment',
      'ACME 1',
      'ACME-1?x=1',
      '#12',
      '-ACME',
      'A'.repeat(MAX_TICKET_KEY_CHARS + 1),
    ]) {
      expect(createTaskRequestSchema.safeParse({ ticket_key: key }).success, key).toBe(false);
    }
    expect(
      createTaskRequestSchema.safeParse({ ticket_key: 'ACME-1', template: 'bug' }).success,
    ).toBe(false);
    expect(
      createTaskRequestSchema.safeParse({ ticket_key: 'ACME-1', mode: 'shadow' }).success,
    ).toBe(false);
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
  it('publishes the setup state as one strict bit (WP-291)', () => {
    expect(setupStateResponseSchema.parse({ first_sign_in_pending: true })).toEqual({
      first_sign_in_pending: true,
    });
    expect(setupStateResponseSchema.safeParse({ first_sign_in_pending: 'yes' }).success).toBe(
      false,
    );
    // Strict: the public read must not grow a second fact by accident.
    expect(
      setupStateResponseSchema.safeParse({ first_sign_in_pending: false, users: 1 }).success,
    ).toBe(false);
    expect(setupStateResponseSchema.safeParse({}).success).toBe(false);
  });

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
      // WP-63: the merged document beside the settings layer, and the reading that fed `repo`.
      effective: {
        version: 1 as const,
        policies: { autonomy: 'supervised' as const },
        stages: { refinement: { model: 'claude-sonnet-5' } },
      },
      sources: { 'stages.refinement.model': 'repo' as const, version: 'default' as const },
      repository: {
        path: '.agentic/config.yml' as const,
        status: 'valid' as const,
        commit_sha: 'a'.repeat(40),
        read_at: AT,
        detail: null,
        not_applied: [{ key: 'policies.autonomy', reason: 'the dial is moved in the platform' }],
        // WP-113: the prompt half of the same reading — path, status, length, cut; never the text.
        prompts: {
          directory: '.agentic/prompts' as const,
          cut_at_chars: 8_000,
          truncated: false,
          files: [
            {
              path: '.agentic/prompts/implementation.md',
              status: 'file' as const,
              chars: 8_001,
              bytes: null,
              cut: true,
            },
          ],
        },
        // WP-121: nothing withheld is `null`, never an absent key.
        prompts_withheld: null,
      },
      hash: 'sha256:abc',
      computed_at: AT,
      // WP-91: what the settings layer states and this build does not read, and the last export.
      not_applied: [
        {
          key: 'pipeline.template_overrides.feature.stages.business_review.enabled',
          reason: 'not applied on this build',
        },
      ],
      last_export: {
        status: 'open' as const,
        config_hash: '0123456789abcdef',
        branch: 'agentic/config/0123456789ab-fedcba987654',
        merge_request_url: 'https://git.example.test/acme/api/-/merge_requests/9',
        exported_at: AT,
      },
      // WP-54: a declared `allow` entry no role's baseline grants, published rather than dropped.
      ignored_allow_commands: ['curl https://example.test'],
      // WP-113: which prompt file each stage would be given, and in what state.
      stage_prompts: [
        {
          stage: 'implementation',
          key: 'prompt' as const,
          path: '.agentic/prompts/implementation.md',
          declared: false,
          status: 'read' as const,
          given: true,
          cut: true,
        },
      ],
      // WP-37: what the wizard is offered for `policies.risk_classes`, which is **not** what the
      // project has — the field above is empty and this one is not, which is the whole shape of
      // "proposed, not applied" (product/18:52).
      risk_class_proposal: {
        source: 'discovery' as const,
        classes: {
          payments: {
            paths: ['src/billing/**'],
            require: ['plan_approval', 'checklist:payments'],
          },
        },
        // WP-45: the list accepting asks the operator to write, by name and with its purpose.
        checklists: [
          {
            name: 'payments',
            required_by: ['payments'],
            purpose: 'product/19 §14 asks for a "stricter checklist" (Q83)',
            defined: false,
          },
        ],
      },
      // WP-170 ruling (d), required since WP-181 (criterion (6)).
      status_mapping_superseded: false,
    };
    expect(effectiveConfigResponseSchema.parse(response)).toEqual(response);
    for (const superseded of [true, false]) {
      expect(
        effectiveConfigResponseSchema.parse({ ...response, status_mapping_superseded: superseded }),
      ).toEqual({ ...response, status_mapping_superseded: superseded });
    }
    expect(
      effectiveConfigResponseSchema.safeParse({ ...response, status_mapping_superseded: 'yes' })
        .success,
    ).toBe(false);
    // WP-181 criterion (6): required — an answer that omits it is refused, never read as `false`.
    const { status_mapping_superseded: _omitted, ...withoutSuperseded } = response;
    expect(effectiveConfigResponseSchema.safeParse(withoutSuperseded).success).toBe(false);
    // A requirement this build cannot act on is refused **by name**, here as everywhere else
    // (PROGRESS backlog 73 (d)): the offer a screen renders goes through the same schema.
    expect(
      effectiveConfigResponseSchema.safeParse({
        ...response,
        risk_class_proposal: {
          ...response.risk_class_proposal,
          classes: { payments: { paths: ['src/billing/**'], require: ['budget_approval'] } },
        },
      }).success,
    ).toBe(false);
    expect(
      effectiveConfigResponseSchema.safeParse({ ...response, sources: { x: 'guess' } }).success,
    ).toBe(false);
    // The reading names one file and nothing else.
    expect(
      effectiveConfigResponseSchema.safeParse({
        ...response,
        repository: { ...response.repository, path: '.agentic/pipeline.yml' },
      }).success,
    ).toBe(false);
    // WP-113: a prompt file's text has no field to travel in — a strict object refuses it.
    expect(
      effectiveConfigResponseSchema.safeParse({
        ...response,
        repository: {
          ...response.repository,
          prompts: {
            ...response.repository.prompts,
            files: [{ ...response.repository.prompts.files[0], text: 'the instructions' }],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      effectiveConfigResponseSchema.safeParse({
        ...response,
        repository: { ...response.repository, prompts: null },
      }).success,
    ).toBe(true);
    // WP-121 (backlog 363): what a reading withheld, as the store records it — and nothing else.
    const withheld = {
      reason: 'the credentials of integration "s" cannot be decrypted',
      integrations: [{ integration: 'integration "s" (sentry, 1)', reason: 'old key' }],
    };
    expect(
      effectiveConfigResponseSchema.safeParse({
        ...response,
        repository: { ...response.repository, prompts: null, prompts_withheld: withheld },
      }).success,
    ).toBe(true);
    const { prompts_withheld: _absent, ...missing } = response.repository;
    for (const repository of [
      missing,
      { ...response.repository, prompts_withheld: { ...withheld, value: 'x' } },
      { ...response.repository, prompts_withheld: { reason: '', integrations: [] } },
    ]) {
      expect(effectiveConfigResponseSchema.safeParse({ ...response, repository }).success).toBe(
        false,
      );
    }
  });

  it('answers an export with the merge request it opened, and refuses an unknown key (WP-63)', () => {
    const exported = {
      status: 'exported' as const,
      performed: true,
      config_hash: '0123456789abcdef',
      branch: 'agentic/config/0123456789ab-fedcba987654',
      commit_sha: 'abc1234',
      merge_request_url: 'https://git.example.test/acme/api/-/merge_requests/9',
      paths: ['.agentic/config.yml', 'CLAUDE.md'],
      notes: [],
    };
    expect(exportProjectConfigResponseSchema.parse(exported)).toEqual(exported);
    expect(exportProjectConfigRequestSchema.safeParse({ direct_commit: true }).success).toBe(false);
    expect(exportProjectConfigRequestSchema.parse({})).toEqual({});
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

describe('the owner candidates (S-26.1 follow-up)', () => {
  it('lists the people the Assign picker offers, snake_case and strict', () => {
    const candidate = { user_id: uuid(1), name: 'Ada' };
    expect(ownerCandidatesResponseSchema.parse({ items: [candidate] })).toEqual({
      items: [candidate],
    });
    expect(ownerCandidatesResponseSchema.parse({ items: [] })).toEqual({ items: [] });
    // Strict at both levels: no email, no role rides along, and the envelope takes no cursor.
    expect(
      ownerCandidatesResponseSchema.safeParse({
        items: [{ ...candidate, email: 'ada@example.test' }],
      }).success,
    ).toBe(false);
    expect(
      ownerCandidatesResponseSchema.safeParse({ items: [candidate], next_cursor: null }).success,
    ).toBe(false);
    expect(
      ownerCandidatesResponseSchema.safeParse({ items: [{ userId: uuid(1), name: 'Ada' }] })
        .success,
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

describe('the live views’ reads (S-23.15)', () => {
  it('publishes an activity line with a bounded tool name and nothing else', () => {
    const line = { kind: 'tool', tool_name: 'mcp__platform__kb_search', at: AT };
    expect(runActivitySchema.parse(line)).toEqual(line);
    expect(runActivitySchema.safeParse({ ...line, tool_name: 'x'.repeat(64) }).success).toBe(true);
    for (const hostile of ['x'.repeat(65), 'Read /etc/passwd', 'a\nb', '<b>', '']) {
      expect(runActivitySchema.safeParse({ ...line, tool_name: hostile }).success).toBe(false);
    }
    // Strict: the entry's text or a tool's input has no key to arrive under.
    expect(runActivitySchema.safeParse({ ...line, input: { path: '/x' } }).success).toBe(false);
    expect(runActivitySchema.safeParse({ ...line, text: 'hello' }).success).toBe(false);
    expect(runActivitySchema.safeParse({ ...line, kind: 'typing' }).success).toBe(false);
  });

  it('publishes a seat as the server or a named worker, strictly', () => {
    expect(
      runSeatSchema.safeParse({ kind: 'server', worker_id: null, worker_name: null }).success,
    ).toBe(true);
    expect(
      runSeatSchema.safeParse({ kind: 'worker', worker_id: uuid(9), worker_name: 'laptop' })
        .success,
    ).toBe(true);
    expect(
      runSeatSchema.safeParse({ kind: 'laptop', worker_id: null, worker_name: null }).success,
    ).toBe(false);
    expect(runSeatSchema.safeParse({ kind: 'server', worker_id: null }).success).toBe(false);
  });

  it('holds the stage graph to its edge kinds and to slugs', () => {
    const graph = {
      template: 'feature',
      nodes: [
        {
          id: 'ci_gate',
          kind: 'gate',
          role: null,
          enabled: true,
          advisory: false,
          model: null,
          effort: null,
          produces: null,
        },
      ],
      edges: [
        {
          from: 'ci_gate',
          to: 'implementation',
          kind: 'fail',
          on_event: null,
          loop: 'ci_fix',
          loop_limit: 3,
        },
        {
          from: 'ready_for_merge',
          to: 'merged_gate',
          kind: 'on',
          on_event: 'mr.merged',
          loop: null,
          loop_limit: null,
        },
      ],
    };
    expect(pipelineGraphSchema.parse(graph)).toEqual(graph);
    expect(projectPipelinesResponseSchema.parse({ items: [graph] })).toBeTruthy();
    const edge = graph.edges[0];
    expect(
      pipelineGraphSchema.safeParse({ ...graph, edges: [{ ...edge, kind: 'jump' }] }).success,
    ).toBe(false);
    expect(
      pipelineGraphSchema.safeParse({ ...graph, edges: [{ ...edge, on_event: 'not.an.event' }] })
        .success,
    ).toBe(false);
    expect(pipelineGraphSchema.safeParse({ ...graph, template: 'Feature Flow' }).success).toBe(
      false,
    );
    expect(projectPipelineQuerySchema.safeParse({ template: 'feature' }).success).toBe(true);
    expect(projectPipelineQuerySchema.safeParse({ stage: 'qa' }).success).toBe(false);
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
    // S-23.23: whether the caller may create one — absent reads `false`, never an offer.
    expect(projectsResponseSchema.parse({ items: [] }).can_create).toBe(false);
    expect(projectsResponseSchema.parse({ items: [], can_create: true }).can_create).toBe(true);
    expect(projectsResponseSchema.safeParse({ items: [], can_create: 'yes' }).success).toBe(false);
  });

  it('lists integrations without a cursor and keeps the config opaque', () => {
    const integration = {
      id: uuid(11),
      type: 'git' as const,
      provider: 'gitlab',
      name: 'acme gitlab',
      config: { base_url: 'https://gitlab.example.test' },
      health: { status: 'unknown' as const, checked_at: null, detail: null },
      config_refusal: null,
      retired_at: null,
      credentials_readable: null,
      credentials_consequence: null,
      activity: { last_call: null, last_delivery_at: null },
      current_health: { status: 'never_checked' as const, basis: null, at: null },
      used_by: [],
    };
    expect(integrationsResponseSchema.parse({ items: [integration] })).toBeTruthy();
    // S-25.3: traffic, health now and the projects are required, so a server that forgot them is
    // caught; a health word outside the enum and an empty use are refused.
    for (const key of ['activity', 'current_health', 'used_by'] as const) {
      const { [key]: _forgot, ...without } = integration;
      expect(integrationsResponseSchema.safeParse({ items: [without] }).success, key).toBe(false);
    }
    expect(
      integrationsResponseSchema.safeParse({
        items: [
          {
            ...integration,
            activity: {
              last_call: { at: '2026-11-06T09:00:00.000Z', ok: true },
              last_delivery_at: null,
            },
            current_health: { status: 'working', basis: 'call', at: '2026-11-06T09:00:00.000Z' },
            used_by: [
              {
                project_id: uuid(12),
                project_key: 'autix',
                project_name: 'Autix',
                uses: [{ label: 'Tickets from', value: 'AUT' }],
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      integrationsResponseSchema.safeParse({
        items: [{ ...integration, current_health: { status: 'healthy', basis: null, at: null } }],
      }).success,
    ).toBe(false);
    expect(
      integrationsResponseSchema.safeParse({
        items: [
          {
            ...integration,
            used_by: [
              {
                project_id: uuid(12),
                project_key: 'autix',
                project_name: 'Autix',
                uses: [{ label: 'Tickets from', value: '' }],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    // WP-157: both credential fields are required-nullable, so a server that forgot them is caught.
    const { credentials_readable: _unread, ...withoutReadable } = integration;
    expect(integrationsResponseSchema.safeParse({ items: [withoutReadable] }).success).toBe(false);
    expect(
      integrationsResponseSchema.safeParse({
        items: [{ ...integration, credentials_readable: false, credentials_consequence: '' }],
      }).success,
    ).toBe(false);
    // WP-100: the refusal is required-nullable, so a server that forgot it is caught here.
    const { config_refusal: _dropped, ...withoutRefusal } = integration;
    expect(integrationsResponseSchema.safeParse({ items: [withoutRefusal] }).success).toBe(false);
    // WP-114: so is `retired_at` — a server that forgot it would publish a retired row as live.
    const { retired_at: _forgotten, ...withoutRetired } = integration;
    expect(integrationsResponseSchema.safeParse({ items: [withoutRetired] }).success).toBe(false);
    expect(
      integrationsResponseSchema.safeParse({
        items: [{ ...integration, retired_at: '2026-10-01T09:00:00.000Z' }],
      }).success,
    ).toBe(true);
    expect(
      integrationsResponseSchema.safeParse({
        items: [{ ...integration, health: { status: 'fine', checked_at: null, detail: null } }],
      }).success,
    ).toBe(false);
    expect(
      integrationsResponseSchema.safeParse({ items: [integration], next_cursor: null }).success,
    ).toBe(false);
    // S-23.23: whether the caller may write integrations — absent reads `false`, never an offer.
    expect(integrationsResponseSchema.parse({ items: [] }).can_write).toBe(false);
    expect(integrationsResponseSchema.parse({ items: [], can_write: true }).can_write).toBe(true);
  });

  it('holds the task read’s caller facts required, and keeps every one out of the export', () => {
    // S-23.23: each is the command route's own permission over the caller's role; one forgotten
    // would hide a control or offer it by accident, so none defaults.
    const shape = taskDetailResponseSchema.shape;
    for (const key of TASK_CALLER_FACT_KEYS) {
      expect(Object.hasOwn(shape, key), key).toBe(true);
      expect(shape[key].safeParse(undefined).success, key).toBe(false);
      // …and the document handed to somebody else carries none of the exporter's permissions.
      expect(Object.hasOwn(taskExportResponseSchema.shape, key), key).toBe(false);
    }
    expect([...TASK_CALLER_FACT_KEYS].sort()).toEqual([
      'can_cancel',
      'can_change_limits',
      'can_decide_approval',
      'can_export',
      'can_pause',
      'can_raise_budget',
      'can_resume',
      'can_return',
      'can_rework',
    ]);
  });

  it('pages tasks, because a project accumulates them without bound', () => {
    const task = {
      id: uuid(12),
      project_id: uuid(10),
      ticket: { provider: 'jira-cloud', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
      ticket_title: null,
      template: 'feature',
      mode: 'normal' as const,
      state: 'active' as const,
      current_stage: 'refinement',
      iteration_counters: {},
      risk_classes: [],
      coverage: null,
      dependencies: null,
      required_reviewers: null,
      review_threads: null,
      conflict: null,
      cost_actual_usd: 0,
      unmeasured_runs: 0,
      budget_cap_usd: 50,
      paused_reason: null,
      paused_budget_scope: null,
      cost_estimated_usd: 0,
      estimate_usd: null,
      estimate_basis: null,
      estimate_samples: null,
      estimate_accuracy: null,
      created_at: AT,
      updated_at: AT,
      // Required since WP-181 (criterion (6)).
      ticket_claim: null,
      qa_stage: false,
      owner: null,
      owner_source: null,
      unlinked_assignee: null,
      owner_writes_back: false,
      tracker_assignee: null,
      waiting: null,
      // The board card's glance (S-23.9a).
      stages: [{ stage: 'refinement', attempt: 1, state: 'running' as const, entered_at: AT }],
      open_questions: 0,
      pending_approvals: 0,
      loop_limits: { code_review: 3 },
      gate_wait: null,
      // S-25.11: the newest return and the stop, `null` when the rows record none.
      latest_return: null,
      stop: null,
      // Backlog 1360: the escalation's reason key, `null` for a task that is not `needs_human`.
      escalation_reason: null,
    };
    expect(
      tasksResponseSchema.parse({
        items: [task],
        next_cursor: null,
        can_start_task: true,
        can_cancel_task: true,
        can_return_to_stage: true,
        can_pause_task: true,
        can_resume_task: true,
      }),
    ).toBeTruthy();
    expect(
      tasksResponseSchema.parse({
        items: [task],
        next_cursor: `${AT}|${uuid(12)}`,
        can_start_task: false,
        can_cancel_task: true,
        can_return_to_stage: true,
        can_pause_task: true,
        can_resume_task: true,
      }),
    ).toBeTruthy();
    // `next_cursor` is required, not optional: "no more pages" and "the field was forgotten" would
    // otherwise be the same response.
    expect(
      tasksResponseSchema.safeParse({
        items: [task],
        can_start_task: true,
        can_cancel_task: true,
        can_return_to_stage: true,
        can_pause_task: true,
        can_resume_task: true,
      }).success,
    ).toBe(false);
    // So is the caller's capability (WP-122): a board that cannot tell "may not start" from "the
    // server did not say" would offer or hide the form by accident.
    expect(tasksResponseSchema.safeParse({ items: [task], next_cursor: null }).success).toBe(false);
    // …and the menu's two capabilities (S-23.9a), each required.
    for (const key of [
      'can_cancel_task',
      'can_return_to_stage',
      'can_pause_task',
      'can_resume_task',
    ] as const) {
      const full = {
        items: [task],
        next_cursor: null,
        can_start_task: true,
        can_cancel_task: true,
        can_return_to_stage: true,
        can_pause_task: true,
        can_resume_task: true,
      };
      const { [key]: _dropped, ...without } = full;
      expect(tasksResponseSchema.safeParse(without).success, key).toBe(false);
    }

    // S-23.9a: the card's glance is required and strict. A page whose item forgot the stage rows or
    // a count would draw "no stage" and "nothing waits on you" — a claim, not a missing value.
    const page = (item: unknown) =>
      tasksResponseSchema.safeParse({
        items: [item],
        next_cursor: null,
        can_start_task: true,
        can_cancel_task: true,
        can_return_to_stage: true,
        can_pause_task: true,
        can_resume_task: true,
      });
    for (const key of [
      'stages',
      'open_questions',
      'pending_approvals',
      'loop_limits',
      'latest_return',
      'stop',
      'escalation_reason',
    ] as const) {
      const { [key]: _dropped, ...without } = task;
      expect(page(without).success, key).toBe(false);
    }
    expect(page({ ...task, loop_limits: null }).success).toBe(true);
    expect(page({ ...task, escalation_reason: 'ticket_assigned_elsewhere' }).success).toBe(true);
    expect(page({ ...task, escalation_reason: '' }).success).toBe(false);
    expect(page({ ...task, open_questions: -1 }).success).toBe(false);
    expect(page({ ...task, stages: [{ ...task.stages[0], state: 'sideways' }] }).success).toBe(
      false,
    );
    expect(page({ ...task, stages: [{ ...task.stages[0], exited_at: null }] }).success).toBe(false);
    expect(page({ ...task, extra: true }).success).toBe(false);
  });

  it('words a return and a stop only from what the rows hold, strictly and bounded (S-25.11)', () => {
    const ret = {
      from_stage: 'ci_gate',
      attempt: 2,
      to_stage: 'implementation',
      to_role: 'developer',
      at: AT,
      outcome: 'returned',
      reason_recorded: true,
      ci_failure: { status: 'failed', jobs: 'unit' },
      loop: 'ci_fix',
    };
    expect(taskReturnSchema.parse(ret)).toEqual(ret);
    // Every fact a row may not hold is nullable, never optional: absent is not "not recorded".
    for (const key of ['to_stage', 'to_role', 'outcome', 'ci_failure', 'loop'] as const) {
      expect(taskReturnSchema.safeParse({ ...ret, [key]: null }).success, key).toBe(true);
      const { [key]: _dropped, ...without } = ret;
      expect(taskReturnSchema.safeParse(without).success, key).toBe(false);
    }
    // A pipeline status that is not a failure is not a CI failure.
    expect(
      taskReturnSchema.safeParse({ ...ret, ci_failure: { status: 'success', jobs: '' } }).success,
    ).toBe(false);
    expect(taskReturnSchema.safeParse({ ...ret, extra: true }).success).toBe(false);

    const stop = {
      stage: 'ci_gate',
      attempt: 1,
      cause: 'no_answer',
      loop: null,
      ci_failure: null,
      recorded: 'the CI gate on a poll-only gitlab binding timed out',
      recorded_cut: false,
      ci_ending: 'ci_timed_out',
    };
    expect(taskStopSchema.parse(stop)).toEqual(stop);
    // S-25.12 (backlog 1099): the CI ending is required and nullable, never absent.
    expect(taskStopSchema.safeParse({ ...stop, ci_ending: null }).success).toBe(true);
    const { ci_ending: _ending, ...noEnding } = stop;
    expect(taskStopSchema.safeParse(noEnding).success).toBe(false);
    expect(taskStopSchema.safeParse({ ...stop, cause: 'failed' }).success).toBe(false);
    expect(
      taskStopSchema.safeParse({ ...stop, recorded: 'x'.repeat(MAX_TASK_STOP_RECORDED_CHARS) })
        .success,
    ).toBe(true);
    expect(
      taskStopSchema.safeParse({ ...stop, recorded: 'x'.repeat(MAX_TASK_STOP_RECORDED_CHARS + 1) })
        .success,
    ).toBe(false);
    // The task read carries the returns, the stop and the limits, each required.
    // S-25.12 (backlog 1099): so are the CI wait's two reads — and (BACKLOG 850) the escalation.
    for (const key of [
      'returns',
      'stop',
      'loop_limits',
      'gate_wait',
      'last_gate_wait',
      'escalation',
    ] as const) {
      expect(taskDetailResponseSchema.shape[key].safeParse(undefined).success, key).toBe(false);
    }
  });

  it('publishes what a CI pass left unstarted strictly and bounded, or null (S-27.2, TD-036 decision 5)', () => {
    const notRun = {
      pipeline_id: '3038234623',
      pipeline_url: 'https://gitlab.example.test/acme/api/-/pipelines/3038234623',
      pipeline_status: 'manual',
      jobs: [
        {
          name: 'sentry-release-commit',
          stage: 'release',
          url: 'https://gitlab.example.test/acme/api/-/jobs/9003',
        },
      ],
      checked_at: AT,
    };
    expect(ciManualNotRunSchema.parse(notRun)).toEqual(notRun);
    const field = taskDetailResponseSchema.shape.ci_manual_not_run;
    expect(field.safeParse(notRun).success).toBe(true);
    expect(field.safeParse(null).success).toBe(true);
    // Optional on the wire because the SPA's fixtures predate it; the task read always sends it.
    expect(field.safeParse(undefined).success).toBe(true);
    const job = notRun.jobs[0] as (typeof notRun.jobs)[number];
    for (const refused of [
      { ...notRun, extra: true },
      { ...notRun, jobs: [] },
      { ...notRun, jobs: Array.from({ length: MAX_CI_MANUAL_NOT_RUN_JOBS + 1 }, () => job) },
      { ...notRun, jobs: [{ ...job, name: 'x'.repeat(101) }] },
      { ...notRun, jobs: [{ ...job, url: 'javascript:alert(1)' }] },
      { ...notRun, jobs: [{ ...job, extra: 1 }] },
      { ...notRun, pipeline_url: 'javascript:alert(1)' },
      { ...notRun, pipeline_id: 'x'.repeat(256) },
      { ...notRun, pipeline_status: 'blocked' },
    ]) {
      expect(field.safeParse(refused).success, JSON.stringify(refused).slice(0, 80)).toBe(false);
    }
    expect(
      ciManualNotRunSchema.safeParse({
        ...notRun,
        jobs: Array.from({ length: MAX_CI_MANUAL_NOT_RUN_JOBS }, () => ({ ...job, stage: null })),
      }).success,
    ).toBe(true);
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

  it('takes a default branch only as a git branch name the mirror and the checkout can use (WP-139)', () => {
    const project = {
      key: 'acme_api',
      name: 'ACME API',
      repo_url: 'https://git.example.test/acme/api.git',
    };
    for (const good of ['develop', 'dev', 'main', 'release/2.x', 'v1.0_rc-1', 'x'.repeat(200)]) {
      expect(
        createProjectRequestSchema.safeParse({ ...project, default_branch: good }).success,
        good,
      ).toBe(true);
      expect(setDefaultBranchRequestSchema.safeParse({ default_branch: good }).success, good).toBe(
        true,
      );
    }
    for (const bad of [
      '',
      'x'.repeat(201),
      '-develop',
      '.hidden',
      'a..b',
      'a//b',
      'feature/',
      'feature/.x',
      'main.lock',
      'HEAD',
      'a/b.lock/c',
      'main.',
      'has space',
      'at@{1}',
      'tilde~1',
      'caret^',
      'colon:x',
      'star*',
      'back\\slash',
      'nul\u0000x',
      'refs/heads/../../HEAD',
    ]) {
      expect(
        createProjectRequestSchema.safeParse({ ...project, default_branch: bad }).success,
        bad,
      ).toBe(false);
      expect(setDefaultBranchRequestSchema.safeParse({ default_branch: bad }).success, bad).toBe(
        false,
      );
    }
    expect(
      setDefaultBranchRequestSchema.safeParse({ default_branch: 'dev', reason: 'x' }).success,
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

/**
 * WP-64 review round 1: an interview answer or reason carrying U+0000 is a 400 naming the field,
 * never a 500 from PostgreSQL (`text` and `jsonb` both refuse the byte). Both directions (rule 42).
 */
describe('businessInterviewRequestSchema', () => {
  it('refuses a NUL in an answer or a reason, and names where', () => {
    const nul = String.fromCharCode(0);
    const answer = businessInterviewRequestSchema.safeParse({
      answers: { product: { status: 'answered', text: `Invoicing${nul}` } },
    });
    expect(answer.success).toBe(false);
    expect(answer.error?.issues[0]?.path).toEqual(['answers', 'product', 'text']);
    expect(answer.error?.issues[0]?.message).toContain('NUL');
    const reason = businessInterviewRequestSchema.safeParse({
      answers: { users: { status: 'not_applicable', reason: `none${nul}` } },
    });
    expect(reason.success).toBe(false);
    expect(reason.error?.issues[0]?.path).toEqual(['answers', 'users', 'reason']);
  });

  it('accepts the same text without it', () => {
    expect(
      businessInterviewRequestSchema.safeParse({
        answers: {
          product: { status: 'answered', text: 'Invoicing' },
          users: { status: 'not_applicable', reason: 'none' },
        },
      }).success,
    ).toBe(true);
  });
});

describe('PATCH /api/integrations/:id (WP-100)', () => {
  it('takes keys to set and keys to remove, and refuses a body with neither', () => {
    expect(patchIntegrationRequestSchema.safeParse({ config: { channel: '#a' } }).success).toBe(
      true,
    );
    expect(patchIntegrationRequestSchema.safeParse({ remove: ['host'] }).success).toBe(true);
    expect(patchIntegrationRequestSchema.safeParse({}).success).toBe(false);
    // Strict: an unknown key is an error, never dropped.
    expect(patchIntegrationRequestSchema.safeParse({ config: {}, secret_refs: {} }).success).toBe(
      false,
    );
  });
});

/** WP-170 ruling (d): the tracker's statuses and the lifecycle block's two refusals. */
describe('ticket statuses', () => {
  const status = {
    id: '10001',
    name: 'Testing',
    category: 'in_progress',
    raw_category: 'indeterminate',
  };

  it('publishes a status with its category and the provider key it came from', () => {
    const response = {
      items: [status, { id: '3', name: 'Sent back', category: 'unknown', raw_category: null }],
    };
    expect(ticketStatusesResponseSchema.parse(response)).toEqual(response);
  });

  it('refuses a category outside the four, an empty name and an unknown key', () => {
    for (const item of [
      { ...status, category: 'indeterminate' },
      { ...status, name: '' },
      { ...status, colour: 'blue' },
      { id: status.id, name: status.name, category: status.category },
    ]) {
      expect(
        ticketStatusesResponseSchema.safeParse({ items: [item] }).success,
        JSON.stringify(item),
      ).toBe(false);
    }
  });

  it('holds the list at MAX_TICKET_STATUSES: the bound passes, one past it is refused (WP-181 (7))', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...status,
        id: String(index),
        name: `S${index}`,
      }));
    expect(
      ticketStatusesResponseSchema.safeParse({ items: many(MAX_TICKET_STATUSES) }).success,
    ).toBe(true);
    expect(
      ticketStatusesResponseSchema.safeParse({ items: many(MAX_TICKET_STATUSES + 1) }).success,
    ).toBe(false);
  });

  it('names the two refusals as error codes the envelope carries', () => {
    expect(lifecycleErrorCodeSchema.options).toEqual([
      'lifecycle_status_unknown',
      'lifecycle_statuses_unavailable',
    ]);
    for (const code of lifecycleErrorCodeSchema.options) {
      expect(apiErrorSchema.safeParse({ error: { code, message: 'x' } }).success).toBe(true);
    }
  });
});

/** Backlog 1360 (S-25.14): the Inbox's escalated tasks — required, strict, snake_case. */
describe('the inbox lists escalated tasks', () => {
  const row = {
    task_id: uuid(1),
    project_id: uuid(2),
    ticket: {
      provider: 'fake-jira',
      key: 'ACME-1',
      url: 'https://jira.example.test/browse/ACME-1',
    },
    ticket_title: 'Show the totals',
    current_stage: 'refinement',
    reason: 'ticket_assigned_elsewhere',
    at: AT,
    tracker_assignee: { display_name: 'Jane Example', user_id: null },
    unlinked_assignee: { display_name: 'Jane Example' },
  };

  it('parses a row, and every fact a row may not hold is nullable, never optional', () => {
    expect(inboxEscalatedSchema.parse(row)).toEqual(row);
    for (const key of [
      'ticket_title',
      'current_stage',
      'reason',
      'tracker_assignee',
      'unlinked_assignee',
    ] as const) {
      expect(inboxEscalatedSchema.safeParse({ ...row, [key]: null }).success, key).toBe(true);
      const { [key]: _dropped, ...without } = row;
      expect(inboxEscalatedSchema.safeParse(without).success, key).toBe(false);
    }
    expect(inboxEscalatedSchema.safeParse({ ...row, reason: '' }).success).toBe(false);
    expect(inboxEscalatedSchema.safeParse({ ...row, brief: 'the words' }).success).toBe(false);
  });

  it('requires the list on the inbox response', () => {
    const inbox = { questions: [], approvals: [], ci_held: [], escalated: [row] };
    expect(inboxResponseSchema.parse(inbox).escalated).toEqual([row]);
    const { escalated: _dropped, ...without } = inbox;
    expect(inboxResponseSchema.safeParse(without).success).toBe(false);
    // Bounded at the API's page maximum, both sides of the boundary.
    const many = (n: number) => ({ ...inbox, escalated: Array.from({ length: n }, () => row) });
    expect(inboxResponseSchema.safeParse(many(MAX_INBOX_ESCALATED)).success).toBe(true);
    expect(inboxResponseSchema.safeParse(many(MAX_INBOX_ESCALATED + 1)).success).toBe(false);
  });
});

describe('queue_wait (S-25.16)', () => {
  const holder = (n: number) => ({
    task_id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
    ticket_key: `AUT-${n}`,
    state: 'needs_human',
  });
  const waiting = {
    status: 'waiting',
    reason: 'max_tasks_in_pipeline',
    count: 5,
    limit: 5,
    position: 2,
    queued: 5,
    running: { count: 0, limit: 2 },
    pipeline: { count: 5, limit: 5 },
    holders: { total: 5, needs_human: 5, items: [1, 2, 3, 4, 5].map(holder) },
  };
  const room = { running: { count: 0, limit: 2 }, pipeline: { count: 1, limit: 5 } };

  it('parses a wait and the honest admitted state', () => {
    expect(queueWaitSchema.parse(waiting)).toEqual(waiting);
    expect(queueWaitSchema.parse({ status: 'admitted', position: 1, queued: 1, ...room })).toEqual({
      status: 'admitted',
      position: 1,
      queued: 1,
      ...room,
    });
    // Both limits are required on either shape.
    expect(queueWaitSchema.safeParse({ status: 'admitted', position: 1, queued: 1 }).success).toBe(
      false,
    );
    const { pipeline: _pipeline, ...onlyRunning } = waiting;
    expect(queueWaitSchema.safeParse(onlyRunning).success).toBe(false);
  });

  it('refuses an unknown key, a wait without its counts, and a run-limit reason', () => {
    expect(queueWaitSchema.safeParse({ ...waiting, guessed: true }).success).toBe(false);
    expect(
      queueWaitSchema.safeParse({
        status: 'admitted',
        position: 1,
        queued: 1,
        ...room,
        holders: {},
      }).success,
    ).toBe(false);
    const { count: _count, ...noCount } = waiting;
    expect(queueWaitSchema.safeParse(noCount).success).toBe(false);
    expect(queueWaitSchema.safeParse({ ...waiting, reason: 'max_parallel_runs' }).success).toBe(
      false,
    );
    expect(queueWaitSchema.safeParse({ ...waiting, position: 0 }).success).toBe(false);
  });

  it('lists at most the cap of holders, with the total beside it', () => {
    const items = Array.from({ length: MAX_QUEUE_WAIT_HOLDERS }, (_, n) => holder(n + 1));
    const full = { ...waiting, holders: { total: 12, needs_human: 12, items } };
    expect(queueWaitSchema.safeParse(full).success).toBe(true);
    expect(
      queueWaitSchema.safeParse({
        ...full,
        holders: { ...full.holders, items: [...items, holder(99)] },
      }).success,
    ).toBe(false);
  });
});
