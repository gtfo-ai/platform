/**
 * `GET /api/artifacts/:artifact_id` and its **three endings**, driven through the real router
 * against plain functions (WP-52 round 4).
 *
 * ## Why this file exists, which is the interesting part
 *
 * The 409 `artifact_not_redacted` refusal is the only thing standing between a body written before
 * migration 0038 — when nothing redacted an artifact (PROGRESS backlog 35, measured) — and
 * `artifact.read`, which is `viewer`. Round 3 asserted it in the **e2e** tier, which was the only
 * place the *route's status* could be seen: no integration test builds the real router, and
 * `routes/tasks.ts` took a `Database` rather than injected queries.
 *
 * That assertion then failed **one full-tier run in two** on the orchestrator's machine at a
 * one-minute load of 9.45, reporting `expected 200 to be 409` with an **empty** response body — a
 * combination this route's code cannot produce, since both endings either throw or return a defined
 * object. It did not reproduce here: three runs of the file alone and two full-tier passes, green,
 * at loads 3.2 to 9. So the mechanism was **not established**, and none is claimed (standing rule 86
 * — a prediction written into the tree becomes an observation; standing rule 76 — a flake's *rate*
 * can be the only random thing about it).
 *
 * What *is* established is that the assertion does not belong there. A refusal this load-bearing has
 * to be assertable in a tier that runs it often and deterministically, so `registerTaskRoutes` gained
 * the injected-query seam `asks.ts`, `breakdown.ts` and `commands.ts` already use, and the three
 * endings are asserted here: the real router, the real guards, the real response schemas and the
 * real error handler, with no database, no container and no network. The e2e keeps the half only it
 * can state — a body the pipeline really produced, served without the run's credential.
 *
 * **What this tier cannot see**, stated rather than implied: whether `findArtifactBody` reads the
 * column correctly. That is `test/integration/server/read-api.integration.test.ts`, which drives the
 * real SQL and produces the `null` the only honest way. Neither half alone is enough — the
 * integration half is blind to a route that ignores the verdict, and this half is blind to a query
 * that reports the wrong one.
 */
import type {
  RunRecord,
  TaskAuditEntry,
  TaskDetailResponse,
  TaskRecord,
  UserRole,
} from '@platform/contracts';
import {
  MAX_TASK_EXPORT_EVENTS,
  MAX_TASK_EXPORT_HUMAN_ACTIONS,
  taskDetailResponseSchema,
  taskExportResponseSchema,
} from '@platform/contracts';
import { redaction } from '@platform/infrastructure';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import type { ArtifactBody, TaskEventRow } from '../queries/pipeline-queries.js';
import { registerTaskRoutes, type TaskQueries } from './tasks.js';

const ARTIFACT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const PROJECT = '00000000-0000-4000-8000-0000000000c1';
const USER = '00000000-0000-4000-8000-0000000000d1';
const RUN = '00000000-0000-4000-8000-0000000000e1';
const EXPORTED_AT = '2026-10-01T12:00:00.000Z';

interface World {
  body: ArtifactBody;
  role: UserRole | null;
  signedIn: boolean;
  /** Every artifact id the route asked about — so "it read the row" is assertable. */
  readonly asked: string[];
  /** Every artifact id the **scope** resolved a project for. */
  readonly scopedFor: string[];
  /** Every `(projectId, userId)` the permission guard was asked about. */
  readonly guardedFor: { projectId: string; userId: string }[];
  /** Every task id the *task* scope resolved — empty unless a route was wired to the wrong one. */
  readonly taskScopedFor: string[];
  /** The caller's organisation role (WP-112); a project membership can only raise it. */
  orgRole: UserRole;
  /** What the export's three reads answer (WP-112). */
  detail: TaskDetailResponse | null;
  audit: TaskAuditEntry[];
  events: TaskEventRow[];
  /** Every `(read, limit)` the export asked for — so "it read nothing" is assertable. */
  readonly exportReads: string[];
}

const build = async (): Promise<{ app: FastifyInstance; world: World }> => {
  const world: World = {
    body: { found: false },
    role: 'viewer',
    signedIn: true,
    asked: [],
    scopedFor: [],
    guardedFor: [],
    taskScopedFor: [],
    orgRole: 'member',
    detail: null,
    audit: [],
    events: [],
    exportReads: [],
  };

  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    if (world.signedIn) {
      request.actor = {
        userId: USER,
        email: 'operator@example.test',
        name: 'Operator',
        role: world.orgRole,
        sessionId: 'session-1',
      };
    }
  });

  const queries: TaskQueries = {
    taskDetail: async (taskId) => {
      world.exportReads.push(`detail ${taskId}`);
      return world.detail;
    },
    taskAudit: async (taskId, limit) => {
      world.exportReads.push(`audit ${taskId} ${limit}`);
      return world.audit.slice(0, limit);
    },
    taskEvents: async (taskId, limit) => {
      world.exportReads.push(`events ${taskId} ${limit}`);
      return world.events.slice(0, limit);
    },
    taskProjectId: async (taskId) => {
      world.taskScopedFor.push(taskId);
      return PROJECT;
    },
    projectRole: async (projectId, userId) => {
      world.guardedFor.push({ projectId, userId });
      return world.role;
    },
    artifactProjectId: async (artifactId) => {
      world.scopedFor.push(artifactId);
      return PROJECT;
    },
    artifactBody: async (artifactId) => {
      world.asked.push(artifactId);
      return world.body;
    },
  };
  await registerTaskRoutes(app, {
    queries,
    redactor: redaction.patternRedactor(),
    now: () => new Date(EXPORTED_AT),
  });
  await app.ready();
  return { app, world };
};

const redactedBody = (redactionCount: number): ArtifactBody => ({
  found: true,
  redacted: true,
  body: {
    id: ARTIFACT,
    task_id: TASK,
    artifact_type: 'RefinedSpec',
    version: 1,
    schema_version: '1',
    produced_by_run_id: null,
    created_at: '2026-09-01T09:00:00.000Z',
    redaction_count: redactionCount,
    markdown: null,
    data: { goal: 'ship the footer' },
  },
});

describe('GET /api/artifacts/:artifact_id', () => {
  let app: FastifyInstance;
  let world: World;

  beforeEach(async () => {
    ({ app, world } = await build());
  });

  it('serves a row the platform redacted at the write', async () => {
    world.body = redactedBody(2);
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode, reply.body).toBe(200);
    const body = reply.json() as { redaction_count: number; data: { goal: string } };
    expect(body.redaction_count).toBe(2);
    expect(body.data.goal).toBe('ship the footer');
    // The route read the row it was asked about, rather than answering from the path.
    expect(world.asked).toEqual([ARTIFACT]);
  });

  it('serves a row whose redactor ran and replaced nothing, which is not the same as null', async () => {
    // Standing rule 18, at the route: `0` is a measurement and `null` is an absence, and only one
    // of them is refused. Without this case the refusal below could be "any falsy count".
    world.body = redactedBody(0);
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode, reply.body).toBe(200);
    expect((reply.json() as { redaction_count: number }).redaction_count).toBe(0);
  });

  /**
   * **The branch this route rests on.** A reviewer's canary that made the query serve such a row
   * instead of refusing it left the whole cheap tier green before this file existed.
   */
  it('refuses a row written before anything redacted it, by name and with no document', async () => {
    world.body = { found: true, redacted: false, createdAt: '2026-08-01T09:00:00.000Z' };
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode, reply.body).toBe(409);
    const body = reply.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('artifact_not_redacted');
    // The message names *why*, and carries the instant rather than the document.
    expect(body.error.message).toContain('before migration 0038');
    expect(body.error.message).toContain('2026-08-01');
    expect(reply.body).not.toContain('ship the footer');
  });

  it('answers 404 for an artifact that does not exist, which is a third fact', async () => {
    world.body = { found: false };
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode, reply.body).toBe(404);
  });

  it('refuses an anonymous caller before it reads anything', async () => {
    world.signedIn = false;
    world.body = redactedBody(1);
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode).toBe(401);
    // Both directions: the guard ran *before* the read, so a refused caller leaves no trace of the
    // row it asked about (standing rule 42).
    expect(world.asked).toEqual([]);
  });

  /**
   * **"Permissioned like its task", asserted as the thing it actually is.**
   *
   * The first version of this case expected a 403 for a caller with no project role and was wrong
   * about the mechanism: membership **promotes and never demotes** (`auth/rbac.ts`), so a null
   * project role falls back to the organisation role — and `artifact.read` is `viewer`, the floor,
   * which every signed-in caller already has. So a 403 on this route is **unreachable for a
   * signed-in user**, and writing a case that faked one would have pinned a fiction.
   *
   * What is real, and what the criterion's wording means, is *which project is consulted*: the
   * scope resolves it from the **artifact's own row**, never from the request, so a caller cannot
   * name a project they do have a role on and read another's artifact through it.
   */
  it('scopes by the artifact’s own project, and asks the guard about that project', async () => {
    world.body = redactedBody(1);
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(world.scopedFor).toEqual([ARTIFACT]);
    expect(world.guardedFor).toEqual([{ projectId: PROJECT, userId: USER }]);
    // …and the task route's own resolver was not the one consulted, which is what would happen if
    // the artifact route had been registered under the task scope by mistake.
    expect(world.taskScopedFor).toEqual([]);
  });

  it('rejects an id that is not a uuid without reading anything', async () => {
    const reply = await app.inject({ method: 'GET', url: '/api/artifacts/not-a-uuid' });
    expect(reply.statusCode).toBe(400);
    expect(world.asked).toEqual([]);
  });
});

// ── The task export (WP-112, PROGRESS backlog 310) ───────────────────────────

const AT = '2026-09-30T09:00:00.000Z';

const TASK_RECORD: TaskRecord = {
  id: TASK,
  project_id: PROJECT,
  ticket: { provider: 'jira', key: 'DEMO-1', url: 'https://jira.example.test/browse/DEMO-1' },
  ticket_title: 'Ship the footer',
  template: 'feature',
  mode: 'normal',
  state: 'active',
  current_stage: 'implementation',
  size: null,
  branch: null,
  mr_ref: null,
  workpad_ref: null,
  iteration_counters: {},
  risk_classes: [],
  coverage: null,
  dependencies: null,
  required_reviewers: null,
  review_threads: null,
  conflict: null,
  cost_actual_usd: 0.4,
  unmeasured_runs: 0,
  budget_cap_usd: 50,
  paused_reason: null,
  paused_budget_scope: null,
  cost_estimated_usd: 0,
  estimate_usd: null,
  estimate_basis: null,
  estimate_samples: null,
  estimate_accuracy: null,
  requested_by_user_id: null,
  requested_by_identity: null,
  created_at: AT,
  updated_at: AT,
  completed_at: null,
  ticket_claim: null,
  qa_stage: false,
} as TaskRecord;

const RUN_RECORD = (settingsHash: string | null): RunRecord => ({
  id: RUN,
  task_id: TASK,
  project_id: PROJECT,
  stage: 'refinement',
  role: 'product_manager',
  mode: 'normal',
  attempt: 1,
  session_id: null,
  model: 'claude-test',
  effort: 'medium',
  provider_mode: 'api',
  prompt_version: 'test@1',
  status: 'completed',
  terminal_reason: 'success',
  started_at: AT,
  ended_at: AT,
  last_output_at: AT,
  num_turns: 1,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  model_usage: [],
  cost: { usd: 0.4, is_estimate: false, price_list_id: null },
  wall_ms: 1_000,
  redaction_count: 0,
  settings_hash: settingsHash,
  start_failure: null,
  saved_work: null,
  latest_progress: null,
});

const DETAIL: TaskDetailResponse = taskDetailResponseSchema.parse({
  task: TASK_RECORD,
  taken_over: null,
  can_raise_budget: false,
  can_export: false,
  gate_feedback: null,
  human_time: {
    total_minutes: 0,
    by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
    by_user: null,
    entries: 0,
    withheld: { entries: 0, minutes: 0 },
  },
  stages: [
    {
      stage: 'refinement',
      attempt: 1,
      state: 'completed',
      entered_at: AT,
      exited_at: AT,
      outcome: 'approve',
    },
  ],
  artifacts: [
    {
      id: ARTIFACT,
      artifact_type: 'RefinedSpec',
      version: 1,
      url: `/api/artifacts/${ARTIFACT}`,
    },
  ],
  questions: [],
  approvals: [],
  runs: [RUN_RECORD('a'.repeat(64)), { ...RUN_RECORD(null), id: TASK.replace('b1', 'e2') }],
});

const eventRow = (index: number, payload: Record<string, string> = {}): TaskEventRow => ({
  position: index + 1,
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  type: 'task.stage.entered',
  streamType: 'task',
  streamId: TASK,
  streamSeq: index + 1,
  correlationId: TASK,
  causeEventId: null,
  actor: { kind: 'system', component: 'pipeline' },
  occurredAt: new Date(AT),
  payload: { project_id: PROJECT, task_id: TASK, stage: 'implementation', ...payload },
});

const auditRow = (index: number): TaskAuditEntry => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  action: 'task.pause',
  user_id: USER,
  params: { task_id: TASK, reason: 'lunch' },
  created_at: AT,
});

/**
 * WP-131 review round 3 (orchestrator): `can_raise_budget` is a fact about the **caller** — the
 * guard's own `budget.write` rule over the effective role in the task's project — and never part of
 * the export. The page offers the cap raise only where it is true; the command route refuses the
 * rest regardless.
 */
describe('GET /api/tasks/:task_id — can_raise_budget (WP-131)', () => {
  let app: FastifyInstance;
  let world: World;

  beforeEach(async () => {
    ({ app, world } = await build());
    world.detail = DETAIL;
  });

  it('answers false to a member and true to a maintainer of the task’s project, and the export carries neither', async () => {
    world.orgRole = 'viewer';
    world.role = 'member';
    const member = await app.inject({ method: 'GET', url: `/api/tasks/${TASK}` });
    expect(member.statusCode, member.body).toBe(200);
    expect((member.json() as { can_raise_budget: boolean }).can_raise_budget).toBe(false);

    world.role = 'maintainer';
    const maintainer = await app.inject({ method: 'GET', url: `/api/tasks/${TASK}` });
    expect(maintainer.statusCode, maintainer.body).toBe(200);
    expect((maintainer.json() as { can_raise_budget: boolean }).can_raise_budget).toBe(true);
    expect(world.guardedFor.every((entry) => entry.projectId === PROJECT)).toBe(true);

    const exported = await app.inject({ method: 'GET', url: `/api/tasks/${TASK}/export` });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(Object.hasOwn(exported.json() as object, 'can_raise_budget')).toBe(false);
  });
});

describe('GET /api/tasks/:task_id/export (WP-112)', () => {
  let app: FastifyInstance;
  let world: World;
  const url = `/api/tasks/${TASK}/export`;

  beforeEach(async () => {
    ({ app, world } = await build());
    world.detail = DETAIL;
    world.events = [eventRow(0), eventRow(1)];
    world.audit = [auditRow(0)];
  });

  it('refuses an anonymous caller before it reads anything', async () => {
    world.signedIn = false;
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode).toBe(401);
    expect((reply.json() as { error: { code: string } }).error.code).toBe('unauthenticated');
    expect(world.exportReads).toEqual([]);
    expect(world.taskScopedFor).toEqual([]);
  });

  it('refuses a caller whose role is in another project, scoped by the task’s own project', async () => {
    // An organisation viewer with no membership in the task's project — a member of some other
    // project, which the guard never consults: the project comes from the task's row.
    world.orgRole = 'viewer';
    world.role = null;
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(403);
    expect((reply.json() as { error: { code: string } }).error.code).toBe('forbidden');
    expect(world.taskScopedFor).toEqual([TASK]);
    expect(world.guardedFor).toEqual([{ projectId: PROJECT, userId: USER }]);
    expect(world.exportReads).toEqual([]);
    // …and the same caller holding `member` in that project is served (the branch above is the
    // project's answer, not a route that refuses everybody).
    world.role = 'member';
    const allowed = await app.inject({ method: 'GET', url });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('answers one document the extended schema parses, built from the task read', async () => {
    world.orgRole = 'viewer';
    world.role = 'member';
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(200);
    const body = taskExportResponseSchema.parse(reply.json());
    expect(body.format).toBe(1);
    expect(body.exported_at).toBe(EXPORTED_AT);
    // Every part of the task read, as the task read publishes it.
    expect(body.task).toEqual(DETAIL.task);
    expect(body.stages).toEqual(DETAIL.stages);
    expect(body.artifacts).toEqual(DETAIL.artifacts);
    expect(body.runs.map((run) => run.settings_hash)).toEqual(['a'.repeat(64), null]);
    expect(body.events.items.map((event) => event.position)).toEqual([1, 2]);
    expect(body.events.items[0]).toMatchObject({
      type: 'task.stage.entered',
      stream_type: 'task',
      stream_id: TASK,
      occurred_at: AT,
    });
    expect(body.events).toMatchObject({ limit: MAX_TASK_EXPORT_EVENTS, truncated: false });
    // A member may not read the task's audit (`org.audit.read` is maintainer), so the export
    // says so with `null` — and the audit rows were never read at all.
    expect(body.human_actions).toBeNull();
    expect(world.exportReads.some((read) => read.startsWith('audit'))).toBe(false);
  });

  it('carries the audit rows for a caller who may read the task’s audit', async () => {
    world.role = 'maintainer';
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(200);
    const body = taskExportResponseSchema.parse(reply.json());
    expect(body.human_actions).toEqual({
      items: [auditRow(0)],
      limit: MAX_TASK_EXPORT_HUMAN_ACTIONS,
      truncated: false,
    });
    expect(world.exportReads).toContain(`audit ${TASK} ${MAX_TASK_EXPORT_HUMAN_ACTIONS + 1}`);
  });

  it('caps the events at the stated count and says it cut — and does not at exactly the cap', async () => {
    world.events = Array.from({ length: MAX_TASK_EXPORT_EVENTS + 1 }, (_, index) =>
      eventRow(index),
    );
    const over = taskExportResponseSchema.parse((await app.inject({ method: 'GET', url })).json());
    expect(over.events.items).toHaveLength(MAX_TASK_EXPORT_EVENTS);
    expect(over.events.truncated).toBe(true);
    // The oldest are kept: the cut drops the newest row, which is the one past the cap.
    expect(over.events.items.at(-1)?.position).toBe(MAX_TASK_EXPORT_EVENTS);
    expect(world.exportReads).toContain(`events ${TASK} ${MAX_TASK_EXPORT_EVENTS + 1}`);

    // Standing rule 42: the same document exactly at the cap is not cut.
    world.events = world.events.slice(0, MAX_TASK_EXPORT_EVENTS);
    const at = taskExportResponseSchema.parse((await app.inject({ method: 'GET', url })).json());
    expect(at.events.items).toHaveLength(MAX_TASK_EXPORT_EVENTS);
    expect(at.events.truncated).toBe(false);
  });

  it('caps the audit rows the same way, both sides of the bound', async () => {
    world.role = 'maintainer';
    world.audit = Array.from({ length: MAX_TASK_EXPORT_HUMAN_ACTIONS + 1 }, (_, index) =>
      auditRow(index),
    );
    const over = taskExportResponseSchema.parse((await app.inject({ method: 'GET', url })).json());
    expect(over.human_actions?.items).toHaveLength(MAX_TASK_EXPORT_HUMAN_ACTIONS);
    expect(over.human_actions?.truncated).toBe(true);
    world.audit = world.audit.slice(0, MAX_TASK_EXPORT_HUMAN_ACTIONS);
    const at = taskExportResponseSchema.parse((await app.inject({ method: 'GET', url })).json());
    expect(at.human_actions?.truncated).toBe(false);
  });

  it('redacts a credential an event payload carries, and counts it', async () => {
    const planted = 'glpat-FAKE-wp112-not-a-real-token';
    world.events = [eventRow(0, { reason: `token ${planted} pasted` }), eventRow(1)];
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.body).not.toContain(planted);
    const body = taskExportResponseSchema.parse(reply.json());
    expect(body.events.redaction_count).toBe(1);
    expect(String(body.events.items[0]?.payload.reason)).toContain('pasted');
    // A payload with nothing to redact is unchanged, and counted as nothing.
    expect(body.events.items[1]?.payload).toEqual(eventRow(1).payload);
  });

  it('answers 404 for a task deleted between the scope and the read, never an empty document', async () => {
    world.detail = null;
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(404);
  });
});

/**
 * WP-122 (PROGRESS backlog 381): `can_export` is the task page's *Download JSON* — `task.export`
 * over the caller's effective role in the task's project, so a viewer is not offered a link the
 * export route would refuse. A fact about the caller, so the exported document carries none.
 */
describe('GET /api/tasks/:task_id — can_export (WP-122)', () => {
  let app: FastifyInstance;
  let world: World;

  beforeEach(async () => {
    ({ app, world } = await build());
    world.detail = DETAIL;
  });

  it('answers false to a viewer and true to a member of the task’s project, and the export carries neither', async () => {
    world.orgRole = 'viewer';
    world.role = 'viewer';
    const viewer = await app.inject({ method: 'GET', url: `/api/tasks/${TASK}` });
    expect(viewer.statusCode, viewer.body).toBe(200);
    expect((viewer.json() as { can_export: boolean }).can_export).toBe(false);
    const refused = await app.inject({ method: 'GET', url: `/api/tasks/${TASK}/export` });
    expect(refused.statusCode).toBe(403);

    world.role = 'member';
    const member = await app.inject({ method: 'GET', url: `/api/tasks/${TASK}` });
    expect((member.json() as { can_export: boolean }).can_export).toBe(true);
    const exported = await app.inject({ method: 'GET', url: `/api/tasks/${TASK}/export` });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(Object.hasOwn(exported.json() as object, 'can_export')).toBe(false);
  });
});
