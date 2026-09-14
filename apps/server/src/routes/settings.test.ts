/**
 * The settings surface, driven end to end through Fastify against **plain functions** (WP-30).
 *
 * `routes/commands.test.ts`'s shape and its argument: the e2e tier proves the *effect* — a budget
 * written over HTTP pauses a task — and it can only do that once, slowly. The decisions this module
 * owns are asserted here, where a branch is cheap: which capability each route asks for, what a
 * replay does, what lands in the audit row, and which refusal maps to which status.
 *
 * **What this tier cannot see**, stated rather than implied: the recorders perform nothing, so
 * "the dial is materialised in the row" is `test/integration`'s assertion and "the route asked
 * `writeAutonomy` once, with this level and this user, and wrote one audit row" is this file's.
 */
import type {
  AutonomyResponse,
  JsonObject,
  MaterialisedAutonomy,
  UserRole,
} from '@platform/contracts';
import { redaction as redactionAdapters } from '@platform/infrastructure';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import type { SettingsQueries } from './settings.js';
import {
  MAX_OVERRIDE_REASON_CHARS,
  PROJECT_AUDIT_LIMIT,
  registerSettingsRoutes,
} from './settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000e9';

const AUTONOMY: AutonomyResponse = {
  level: 'supervised',
  materialised: true,
  preset_version: 1,
  current_preset_version: 1,
  preset_outdated: false,
  applied_at: '2026-09-14T10:00:00.000Z',
  applied_by: null,
  policies: {
    picks_up_new_tickets: true,
    stop_after_stage: null,
    plan_approval: 'above_size',
    plan_approval_size_threshold: 'L',
    plan_approval_for_risk_classes: true,
    probation: true,
    probation_tasks: 5,
    business_review: true,
    question_timeout: '1 working day',
    human_mr_rounds: 3,
    knowledge_auto_apply: false,
    budget_approval_threshold_usd: 50,
    review_only: false,
    shadow_mode: false,
    suggested_readiness_min: 1,
  },
  is_custom: false,
  overrides: [],
  readiness_level: 0,
  suggested_cap: 'assist',
  above_suggested_cap: true,
};

interface World {
  readonly app: FastifyInstance;
  readonly calls: { name: string; input: unknown }[];
  readonly actions: { userId: string; action: string; params: JsonObject }[];
  readonly attempts: Map<string, { bodyDigest: string | null; params: JsonObject }>;
  role: UserRole;
  userId: string;
  signedIn: boolean;
  projectFound: boolean;
}

const build = async (overrides: Partial<SettingsQueries> = {}): Promise<World> => {
  const calls: World['calls'] = [];
  const actions: World['actions'] = [];
  const attempts = new Map<string, { bodyDigest: string | null; params: JsonObject }>();
  const world = {
    calls,
    actions,
    attempts,
    role: 'admin',
    userId: USER,
    signedIn: true,
    projectFound: true,
  } as unknown as World;

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
        userId: world.userId,
        email: 'operator@example.test',
        name: 'Operator',
        role: world.role,
        sessionId: 'session-1',
      };
    }
  });

  await registerSettingsRoutes(app, {
    // The production composition, not a stub: the redactor is what makes an audited reason safe,
    // and a test that injected an identity function would certify nothing (standing rule 31).
    redactor: redactionAdapters.patternRedactor(),
    queries: {
      projectRole: async () => null,
      projectAutonomy: async (projectId) =>
        projectId === PROJECT && world.projectFound ? AUTONOMY : null,
      writeAutonomy: async (projectId, input) => {
        calls.push({ name: 'writeAutonomy', input: { projectId, ...input } });
        return {
          status: 'written',
          autonomy: {
            level: input.level,
            preset_version: 1,
            applied_at: '2026-09-14T11:00:00.000Z',
            applied_by: input.appliedBy,
            policies: AUTONOMY.policies,
          } as MaterialisedAutonomy,
        };
      },
      projectExists: async (projectId) => projectId === PROJECT && world.projectFound,
      orgBudgets: async () => [],
      writeBudget: async (input) => {
        calls.push({ name: 'writeBudget', input });
        return {
          outcome: input.limitUsd === null ? 'removed' : 'created',
          id: 'budget-1',
          // `null`, never absent: the real writer answers a number or `null`, and a stub that
          // omitted the field would let the route read `undefined` where production reads `null`
          // — a fake kinder than the adapter (standing rule 1).
          previousLimitUsd: null,
        };
      },
      projectAudit: async () => ({ items: [] }),
      previousAttempt: async (query) =>
        attempts.get(`${query.userId}|${query.action}|${query.key}`) ?? null,
      recordAction: async (input) => {
        actions.push({ userId: input.userId, action: input.action, params: input.params });
        // What the real writer does, so a replay by the same caller finds this attempt and one by
        // anybody else does not (`findIdempotentAttempt`'s `where`).
        const key = input.params.idempotency_key;
        const digest = input.params.body_digest;
        if (typeof key === 'string') {
          attempts.set(`${input.userId}|${input.action}|${key}`, {
            bodyDigest: typeof digest === 'string' ? digest : null,
            params: input.params,
          });
        }
      },
      ...overrides,
    },
  });
  await app.ready();
  return Object.assign(world, { app }) as World;
};

let world: World;
beforeEach(async () => {
  world = await build();
});

const put = (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  world.app.inject({ method: 'PUT' as const, url, payload: body, headers });

const codeOf = (response: { json: () => unknown }): string =>
  (response.json() as { error?: { code?: string } }).error?.code ?? '';

describe('every settings route refuses an anonymous caller', () => {
  it('answers 401 on each one, by its own method and before validating the body', async () => {
    /**
     * The hole this closes is `routes/onboarding.ts`'s, one family later: Fastify validates the
     * body **before** `preHandler`, so a guard in the wrong position answers an anonymous caller a
     * `400` describing the route's shape. Each write is therefore asked with **no body at all**.
     */
    world.signedIn = false;
    const probes: [string, string][] = [
      ['GET', `/api/projects/${PROJECT}/autonomy`],
      ['PUT', `/api/projects/${PROJECT}/autonomy`],
      ['PUT', `/api/projects/${PROJECT}/budgets`],
      ['GET', '/api/org/budgets'],
      ['PUT', '/api/org/budgets'],
      ['GET', `/api/projects/${PROJECT}/audit`],
    ];
    for (const [method, url] of probes) {
      const response = await world.app.inject({ method: method as 'GET', url });
      expect(`${method} ${url} -> ${response.statusCode} ${codeOf(response)}`).toBe(
        `${method} ${url} -> 401 unauthenticated`,
      );
    }
  });
});

describe('capabilities', () => {
  it('refuses a viewer the dial and the budgets, and lets a maintainer have both', async () => {
    // `project.autonomy.write` and `budget.write` are both `maintainer` in the shipped table, and
    // both directions are asserted: a guard that refused everybody would pass the first half alone.
    world.role = 'viewer';
    expect(
      (await put(`/api/projects/${PROJECT}/autonomy`, { autonomy: 'assist' })).statusCode,
    ).toBe(403);
    expect(
      (await put(`/api/projects/${PROJECT}/budgets`, { window: 'day', limit_usd: 5 })).statusCode,
    ).toBe(403);
    expect((await put('/api/org/budgets', { window: 'day', limit_usd: 5 })).statusCode).toBe(403);
    // …and nothing was written for a refused command (technical/08: one row per *performed* one).
    expect(world.actions).toHaveLength(0);
    expect(world.calls).toHaveLength(0);

    world.role = 'maintainer';
    expect(
      (await put(`/api/projects/${PROJECT}/autonomy`, { autonomy: 'assist' })).statusCode,
    ).toBe(200);
    expect(
      (await put(`/api/projects/${PROJECT}/budgets`, { window: 'day', limit_usd: 5 })).statusCode,
    ).toBe(200);
  });

  it('refuses a viewer the settings audit, which is the organisation’s audit capability', async () => {
    world.role = 'viewer';
    expect(
      (await world.app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/audit` })).statusCode,
    ).toBe(403);
    world.role = 'maintainer';
    expect(
      (await world.app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/audit` })).statusCode,
    ).toBe(200);
  });

  it('lets a viewer read the dial and the budgets', async () => {
    world.role = 'viewer';
    const read = await world.app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/autonomy`,
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as AutonomyResponse).policies.probation_tasks).toBe(5);
    expect((await world.app.inject({ method: 'GET', url: '/api/org/budgets' })).statusCode).toBe(
      200,
    );
  });
});

describe('the dial’s write', () => {
  it('materialises the level it was given and records what changed', async () => {
    const response = await put(`/api/projects/${PROJECT}/autonomy`, { autonomy: 'autonomous' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ level: 'autonomous', preset_version: 1, performed: true });
    expect(world.calls).toEqual([
      {
        name: 'writeAutonomy',
        input: { projectId: PROJECT, level: 'autonomous', appliedBy: USER },
      },
    ]);
    // product/18:5 — the audit says *what changed*, not only that something did.
    expect(world.actions).toHaveLength(1);
    expect(world.actions[0]?.action).toBe('project.autonomy.write');
    expect(world.actions[0]?.params).toMatchObject({
      project_id: PROJECT,
      before_level: 'supervised',
      after_level: 'autonomous',
      before_preset_version: 1,
      suggested_cap: 'assist',
      preset_version: 1,
    });
  });

  /**
   * **Readiness suggests; it never refuses** (product/18, BD-026, Q21) — criterion 8.
   *
   * The fixture project is readiness level 0, whose suggested cap is `assist`, and the request is
   * `autonomous`. A build that treated the cap as a limit would answer 403 or silently store
   * `assist`; this one stores what the maintainer chose and records the reason beside it.
   */
  it('accepts a level above the readiness suggestion, with the reason redacted in the audit row', async () => {
    const response = await put(`/api/projects/${PROJECT}/autonomy`, {
      autonomy: 'autonomous',
      override_reason: 'we accept the risk; token glpat-FAKEfakeFAKEfake123456 is rotated weekly',
    });
    expect(response.statusCode).toBe(200);
    expect(world.calls[0]).toMatchObject({ input: { level: 'autonomous' } });
    const reason = String(world.actions[0]?.params.override_reason);
    // The sentence survives and the credential does not (standing rule 42: both halves).
    expect(reason).toContain('we accept the risk');
    expect(reason).not.toContain('glpat-FAKEfakeFAKEfake123456');
    expect(world.actions[0]?.params.above_suggested_cap).toBeUndefined();
    expect(world.actions[0]?.params.suggested_cap).toBe('assist');
  });

  it('bounds the reason before it is written down', async () => {
    await put(`/api/projects/${PROJECT}/autonomy`, {
      autonomy: 'assist',
      override_reason: 'x'.repeat(MAX_OVERRIDE_REASON_CHARS + 500),
    });
    expect(String(world.actions[0]?.params.override_reason)).toHaveLength(
      MAX_OVERRIDE_REASON_CHARS,
    );
  });

  it('redacts before it bounds, so a credential straddling the bound leaves its placeholder and no half of itself', async () => {
    // Measured the other way round in this row's review: slice-then-redact published the first
    // half of a token that straddled the bound. The token starts 6 characters before the bound.
    const token = 'glpat-FAKEfakeFAKEfake123456';
    const prefix = 'x'.repeat(MAX_OVERRIDE_REASON_CHARS - 6);
    await put(`/api/projects/${PROJECT}/autonomy`, {
      autonomy: 'assist',
      override_reason: `${prefix}${token} and more words after the bound`,
    });
    const reason = String(world.actions[0]?.params.override_reason);
    expect(reason).not.toContain('glpat-');
    // The placeholder begins where the token began and is itself cut by the bound — which is the
    // right outcome: a truncated placeholder leaks nothing, a truncated token leaks its half.
    expect(reason.startsWith(`${prefix}[`)).toBe(true);
    expect(reason).toHaveLength(MAX_OVERRIDE_REASON_CHARS);
  });

  it('answers 404 for a project that does not exist, and writes nothing', async () => {
    world.projectFound = false;
    const response = await put(`/api/projects/${PROJECT}/autonomy`, { autonomy: 'assist' });
    expect(response.statusCode).toBe(404);
    expect(world.actions).toHaveLength(0);
    expect(world.calls).toHaveLength(0);
  });

  it('refuses a level the dial does not have', async () => {
    const response = await put(`/api/projects/${PROJECT}/autonomy`, { autonomy: 'full-send' });
    expect(response.statusCode).toBe(400);
    expect(world.calls).toHaveLength(0);
  });
});

describe('the budget write', () => {
  it('creates, removes, and refuses a project that does not exist', async () => {
    expect(
      (await put(`/api/projects/${PROJECT}/budgets`, { window: 'month', limit_usd: 250 })).json(),
    ).toEqual({ outcome: 'created', performed: true });
    // product/18:5 — what changed, not only that something did.
    expect(world.actions[0]?.params).toMatchObject({
      window: 'month',
      limit_usd: 250,
      outcome: 'created',
      before_limit_usd: null,
    });
    expect(world.calls[0]).toEqual({
      name: 'writeBudget',
      input: {
        scope: 'project',
        scopeId: PROJECT,
        window: 'month',
        limitUsd: 250,
        createdBy: USER,
      },
    });

    // A null limit removes the cap — spelled as a null rather than as a `DELETE` route, because a
    // cap of zero is a different thing and the table refuses it anyway.
    expect(
      (await put(`/api/projects/${PROJECT}/budgets`, { window: 'month', limit_usd: null })).json(),
    ).toEqual({ outcome: 'removed', performed: true });

    world.projectFound = false;
    const missing = await put(`/api/projects/${PROJECT}/budgets`, { window: 'day', limit_usd: 1 });
    expect(missing.statusCode).toBe(404);
    expect(world.calls).toHaveLength(2);
  });

  it('passes the caller’s notification thresholds through when it is given them', async () => {
    // Optional on the wire and optional in the call: omitting it must leave the column's own
    // `{50,80,100}` default rather than overwrite it with a list nobody asked for.
    await put(`/api/projects/${PROJECT}/budgets`, {
      window: 'day',
      limit_usd: 3,
      notify_pct: [90],
    });
    expect(world.calls[0]).toMatchObject({ input: { notifyPct: [90] } });
  });

  it('writes the organisation cap with a null scope id', async () => {
    expect((await put('/api/org/budgets', { window: 'day', limit_usd: 10 })).statusCode).toBe(200);
    expect(world.calls[0]).toEqual({
      name: 'writeBudget',
      input: { scope: 'org', scopeId: null, window: 'day', limitUsd: 10, createdBy: USER },
    });
  });

  it('refuses a limit the table would refuse, before reaching it', async () => {
    // `usdSchema` is non-negative; zero is refused by `budgets_limit_positive` in SQL, and a
    // negative one never gets that far.
    expect(
      (await put(`/api/projects/${PROJECT}/budgets`, { window: 'day', limit_usd: -1 })).statusCode,
    ).toBe(400);
    expect(world.calls).toHaveLength(0);
  });
});

describe('the reads', () => {
  it('answers 404 for a project that has no row, on both project reads', async () => {
    world.projectFound = false;
    for (const path of [`/api/projects/${PROJECT}/autonomy`, `/api/projects/${PROJECT}/audit`]) {
      const response = await world.app.inject({ method: 'GET', url: path });
      expect(`${path} -> ${response.statusCode} ${codeOf(response)}`).toBe(
        `${path} -> 404 not_found`,
      );
    }
  });

  it('asks the audit for a bounded page rather than the table', async () => {
    let asked: number | null = null;
    const bounded = await build({
      projectAudit: async (_projectId, limit) => {
        asked = limit;
        return { items: [] };
      },
    });
    await bounded.app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/audit` });
    expect(asked).toBe(PROJECT_AUDIT_LIMIT);
    await bounded.app.close();
  });

  it('serves the organisation’s own caps', async () => {
    const listed = await build({
      orgBudgets: async () => [
        {
          id: '00000000-0000-4000-8000-0000000000c1' as never,
          scope: 'org',
          scope_id: null,
          window: 'day',
          limit_usd: 10,
          notify_pct: [50],
          spent_usd: 1,
          window_start: '2026-09-14T00:00:00.000Z' as never,
        },
      ],
    });
    const response = await listed.app.inject({ method: 'GET', url: '/api/org/budgets' });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { items: unknown[] }).items).toHaveLength(1);
    await listed.app.close();
  });
});

describe('Idempotency-Key', () => {
  it('performs nothing twice and writes one audit row for a replayed key', async () => {
    const headers = { 'idempotency-key': 'intent-1' };
    const body = { window: 'week', limit_usd: 40 };
    expect((await put(`/api/projects/${PROJECT}/budgets`, body, headers)).json()).toEqual({
      outcome: 'created',
      performed: true,
    });
    const replay = await put(`/api/projects/${PROJECT}/budgets`, body, headers);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ outcome: 'updated', performed: false });
    // The countable effects, which is what the header is for (standing rule 79).
    expect(world.calls).toHaveLength(1);
    expect(world.actions).toHaveLength(1);
  });

  it('refuses a different body under a used key', async () => {
    const headers = { 'idempotency-key': 'intent-2' };
    await put(`/api/projects/${PROJECT}/autonomy`, { autonomy: 'assist' }, headers);
    const changed = await put(
      `/api/projects/${PROJECT}/autonomy`,
      { autonomy: 'autonomous' },
      headers,
    );
    expect(changed.statusCode).toBe(409);
    expect(codeOf(changed)).toBe('idempotency_key_reused');
    expect(world.calls).toHaveLength(1);
  });

  it('scopes a key to its caller', async () => {
    // The same string from another account is another person's attempt, not this one's: an
    // installation-wide lookup would refuse a legitimate command and leak that a stranger's key
    // exists (`queries/onboarding-queries.ts`'s `findIdempotentAttempt`).
    const headers = { 'idempotency-key': 'shared' };
    await put(`/api/projects/${PROJECT}/budgets`, { window: 'day', limit_usd: 1 }, headers);
    world.userId = '00000000-0000-4000-8000-0000000000ea';
    const other = await put(
      `/api/projects/${PROJECT}/budgets`,
      { window: 'day', limit_usd: 2 },
      headers,
    );
    expect(other.statusCode).toBe(200);
    expect(world.calls).toHaveLength(2);
  });

  it('refuses a key outside the character set, before performing anything', async () => {
    const response = await put(
      `/api/projects/${PROJECT}/budgets`,
      { window: 'day', limit_usd: 1 },
      { 'idempotency-key': 'a key with spaces' },
    );
    expect(response.statusCode).toBe(400);
    expect(world.calls).toHaveLength(0);
  });
});
