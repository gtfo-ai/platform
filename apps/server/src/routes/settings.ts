/**
 * The project and organisation **settings** surface — WP-30, product/10 § "Settings", product/18:55.
 *
 *   GET  /api/projects/:project_id/autonomy   the dial, as it is actually in force
 *   PUT  /api/projects/:project_id/autonomy   select a position — or re-apply the preset
 *   PUT  /api/projects/:project_id/budgets    BD-010's project cap, per window
 *   GET  /api/org/budgets                     the organisation's caps
 *   PUT  /api/org/budgets                     BD-010's organisation cap, per window
 *   GET  /api/projects/:project_id/audit      who changed this project's settings
 *
 * product/18:55 is unconditional — *"Settings pages mirror the wizard one-to-one, so nothing is only
 * reachable during onboarding"* — so every control the wizard has must have an endpoint a settings
 * screen can call. Four of the wizard's five steps already did (`routes/onboarding.ts`); what was
 * missing was the **dial as a thing you can read and re-apply**, and BD-010's budgets, which had no
 * production writer at all: before this module, `insert into budgets` appeared in exactly two files
 * and both were tests, so WP-19's admission guard asked an empty table on every instance.
 *
 * ## Why a module of its own rather than more of `routes/onboarding.ts`
 *
 * That module is the *wizard's* command surface and says so. These are the same settings reached
 * from the other side, with different permissions (`project.autonomy.write` is maintainer,
 * `project.settings.write` is admin, `budget.write` is maintainer) and different readers. Keeping
 * them apart is what lets `settings-mirror.test.ts` compare the two sets at all.
 *
 * ## The shapes that are not this module's invention
 *
 * **Idempotency** is the one mechanism the whole server has (`./idempotency.ts`): a digest of the
 * canonical request recorded in the `human_actions` row beside the key, so a replay performs nothing
 * twice and a different body under a used key is `409 idempotency_key_reused`. The header is
 * *optional* on both writes here, because both are upserts on a natural key and neither can create a
 * duplicate — what the key buys is the **audit row**, which would otherwise say a person set the
 * same budget twice.
 *
 * **Every accepted write leaves exactly one `human_actions` row and a refused one leaves none**
 * (technical/08 § "Rate limits and safety"), and each row carries what the value was *before* and
 * what it is *after* — product/18:5's *"every toggle records who changed it"*, which is only useful
 * if it says what changed. `GET …/audit` is the reader that makes it visible (PROGRESS backlog 52).
 *
 * **A reason is free text, so it is redacted before it is written down** (TD-012, BD-022). WP-27's
 * rule is that the *command that decides* the text redacts it and hands it back to its transport;
 * these writes have no application-ring command — they are a query and an audit row — so the route
 * **is** that one place, and the redactor arrives injected rather than constructed here. That is the
 * deviation stated: one site, named, not a second copy of a pipeline command's job.
 */

import type { SecretRedactor } from '@platform/application';
import type {
  AutonomyLevel,
  AutonomyResponse,
  BudgetRecord,
  JsonObject,
  MaterialisedAutonomy,
  ProjectAuditResponse,
  UserRole,
} from '@platform/contracts';
import {
  apiErrorSchema,
  autonomyResponseSchema,
  budgetsResponseSchema,
  projectAuditResponseSchema,
  putBudgetsRequestSchema,
  setAutonomyRequestSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { WriteBudgetResult } from '../queries/cost-queries.js';
import type { HumanActionInput } from '../queries/onboarding-queries.js';
import { idempotentReplay, readIdempotencyKey } from './idempotency.js';

/**
 * The database this module needs, as nine functions.
 *
 * The shape `routes/commands.ts` uses and for its reason: a route module that named Drizzle could
 * only be driven with a database, so the decisions it owns — which capability each route asks for,
 * what a replay does, what lands in the audit row, which refusal maps to which status — would be
 * asserted once each in the e2e tier, in the middle of a long walk. `app.ts` binds these to this
 * process's database; `settings.test.ts` binds them to recorders.
 */
export interface SettingsQueries {
  projectRole(projectId: string, userId: string): Promise<UserRole | null>;
  /** `null` for a project that does not exist — the 404 the dial's routes answer first. */
  projectAutonomy(projectId: string): Promise<AutonomyResponse | null>;
  writeAutonomy(
    projectId: string,
    input: { readonly level: AutonomyLevel; readonly appliedBy: string | null },
  ): Promise<
    | { readonly status: 'written'; readonly autonomy: MaterialisedAutonomy }
    | { readonly status: 'not_found' }
  >;
  projectExists(projectId: string): Promise<boolean>;
  orgBudgets(): Promise<readonly BudgetRecord[]>;
  writeBudget(input: {
    readonly scope: 'org' | 'project';
    readonly scopeId: string | null;
    readonly window: 'day' | 'week' | 'month' | 'total';
    readonly limitUsd: number | null;
    readonly notifyPct?: readonly number[];
    readonly createdBy: string | null;
  }): Promise<WriteBudgetResult>;
  projectAudit(projectId: string, limit: number): Promise<ProjectAuditResponse>;
  previousAttempt(query: {
    readonly userId: string;
    readonly action: string;
    readonly key: string;
  }): Promise<{ readonly bodyDigest: string | null; readonly params: JsonObject } | null>;
  recordAction(input: HumanActionInput): Promise<void>;
}

export interface SettingsRoutesOptions {
  readonly queries: SettingsQueries;
  /**
   * TD-012 step 2 — the platform's pattern rules, injected.
   *
   * A settings request arrives over HTTP and not from inside a run, so there is no run-scoped
   * credential to redact against (Q55): the patterns alone are the honest composition, and it is the
   * same one `apps/server/src/commands.ts` gives every task command.
   */
  readonly redactor: SecretRedactor;
}

/** How many audit rows a settings screen asks for at once. A page, not an export. */
export const PROJECT_AUDIT_LIMIT = 50;

/** Longest `override_reason` this server stores. Free text on its way to an audit row. */
export const MAX_OVERRIDE_REASON_CHARS = 2_000;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

const budgetWriteResponseSchema = z.strictObject({
  /** `created`, `updated`, `removed`, or `absent` when a removal found no cap to remove. */
  outcome: z.enum(['created', 'updated', 'removed', 'absent']),
  performed: z.boolean(),
});

const autonomyWriteResponseSchema = z.strictObject({
  level: z.string(),
  preset_version: z.int().positive(),
  performed: z.boolean(),
});

export const registerSettingsRoutes = async (
  app: FastifyInstance,
  options: SettingsRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };

  /**
   * The project id, or `undefined` when the segment is not a uuid.
   *
   * The write guards run at `preValidation` — Fastify validates the body before `preHandler`, so a
   * guard there answers an anonymous caller `400` describing the route's shape instead of `401`
   * (`routes/onboarding.ts` carries the measurement and the census asks each route by its own
   * method). That means the guard sees an unvalidated segment, and handing a non-uuid to a `uuid`
   * column would turn a `400` into a `500`.
   */
  const projectOf = (request: FastifyRequest): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };

  const actorOf = (request: FastifyRequest): { userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      // Unreachable through `requirePermission`; kept because the audit row's user is not optional.
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
  };

  /**
   * One settings write: replay, perform, audit — in that order and never another.
   *
   * `perform` runs only when this request is not a replay, and the `human_actions` row is written
   * only when `perform` returned, so a refusal writes nothing and a replay performs nothing. It is
   * `routes/commands.ts`'s helper with the task removed; the two are not shared because that one is
   * built around `TaskCommands` and a settings write has no aggregate.
   */
  const settingsWrite = async <T>(input: {
    readonly request: FastifyRequest;
    readonly action: string;
    /** What the digest is taken over: the body plus whatever the path contributes. */
    readonly subject: unknown;
    readonly params: JsonObject;
    /** What the write produced, for the audit row — including any text the route redacted. */
    readonly auditResult?: (result: T) => JsonObject;
    readonly perform: (userId: string) => Promise<T>;
    readonly answer: (outcome: {
      readonly performed: boolean;
      readonly result: T | null;
    }) => Promise<unknown>;
  }): Promise<unknown> => {
    const actor = actorOf(input.request);
    const key = readIdempotencyKey(input.request);
    const replay = await idempotentReplay(options.queries.previousAttempt, {
      userId: actor.userId,
      action: input.action,
      key,
      request: input.subject,
    });
    if (replay.replayed) {
      return input.answer({ performed: false, result: null });
    }
    const result = await input.perform(actor.userId);
    await options.queries.recordAction({
      userId: actor.userId,
      action: input.action,
      params: {
        ...input.params,
        ...(input.auditResult === undefined ? {} : input.auditResult(result)),
        ...(key === null ? {} : { idempotency_key: key }),
        ...(replay.digest === null ? {} : { body_digest: replay.digest }),
      },
    });
    return input.answer({ performed: true, result });
  };

  /**
   * A human's own words on their way to an audit row: redacted, **then** bounded (TD-012). The
   * order matters and was measured the other way round in this row's review: a credential that
   * straddles the bound survives a slice-then-redact as its first half, while redact-then-slice
   * publishes the placeholder — the same defect `describeConfigIssues` had.
   */
  const auditedText = (value: string | undefined): string | null => {
    if (value === undefined) {
      return null;
    }
    return options.redactor.redactText(value).value.slice(0, MAX_OVERRIDE_REASON_CHARS);
  };

  typed.get(
    '/api/projects/:project_id/autonomy',
    {
      preHandler: requirePermission(guard, 'project.read', { project: projectOf }),
      schema: {
        summary: 'This project’s autonomy dial and the policies it actually set',
        description:
          '`policies` is the **materialised** preset (BD-027:14) with the project’s own overrides applied — what the pipeline reads, not a re-derivation from `level`. `is_custom` and `overrides` are computed against the materialised copy, so a release that edits a preset table does not relabel every project *Custom*; `preset_outdated` is what the "re-apply preset" control is for. `suggested_cap` is readiness’s **suggestion** and `above_suggested_cap` says the chosen level is above it — neither refuses anything (product/18, Q21).',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: autonomyResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const found = await options.queries.projectAutonomy(request.params.project_id);
      if (found === null) {
        throw new NotFoundError(`project ${request.params.project_id}`);
      }
      return found;
    },
  );

  typed.put(
    '/api/projects/:project_id/autonomy',
    {
      preValidation: requirePermission(guard, 'project.autonomy.write', { project: projectOf }),
      schema: {
        summary: 'Select the autonomy dial’s position, or re-apply its preset',
        description:
          'Writes `projects.autonomy_level` **and** the granular policies that position means in this release (BD-027: materialised at selection time). Selecting and re-applying are the same command — sending the level a project already has is exactly "re-apply preset" — so there is no separate route and no flag. Readiness only ever **suggests** a cap: a level above the suggestion is accepted and `override_reason` is recorded in the audit row, redacted (TD-012). `Idempotency-Key` is optional and honoured: a replay writes no second audit row.',
        tags: ['projects'],
        params: projectParamsSchema,
        body: setAutonomyRequestSchema,
        response: {
          200: autonomyWriteResponseSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const before = await options.queries.projectAutonomy(projectId);
      if (before === null) {
        throw new NotFoundError(`project ${projectId}`);
      }
      return (await settingsWrite({
        request,
        action: 'project.autonomy.write',
        subject: { project_id: projectId, body: request.body },
        params: {
          project_id: projectId,
          // product/18:5 — the audit says what changed, not only that something did.
          before_level: before.level,
          after_level: request.body.autonomy,
          before_preset_version: before.preset_version,
          suggested_cap: before.suggested_cap,
        },
        auditResult: (result: {
          readonly reason: string | null;
          readonly presetVersion: number;
        }) => ({
          preset_version: result.presetVersion,
          ...(result.reason === null ? {} : { override_reason: result.reason }),
        }),
        perform: async (userId) => {
          // Bounded and redacted before anything is written down; the body is never read again.
          const reason = auditedText(request.body.override_reason);
          const written = await options.queries.writeAutonomy(projectId, {
            level: request.body.autonomy,
            appliedBy: userId,
          });
          if (written.status === 'not_found') {
            throw new NotFoundError(`project ${projectId}`);
          }
          return { reason, presetVersion: written.autonomy.preset_version };
        },
        answer: async ({ performed, result }) => ({
          level: request.body.autonomy,
          preset_version: result?.presetVersion ?? before.preset_version,
          performed,
        }),
      })) as z.output<typeof autonomyWriteResponseSchema>;
    },
  );

  typed.put(
    '/api/projects/:project_id/budgets',
    {
      preValidation: requirePermission(guard, 'budget.write', { project: projectOf }),
      schema: {
        summary: 'Set or remove this project’s budget for one window (BD-010)',
        description:
          'Upserts on `(scope, scope_id, window)`, the unique key `budgets` already carries, so a project has at most one cap per window and re-sending a window replaces it. `limit_usd: null` **removes** the cap — a cap of zero is refused by the table, because zero would block every run for ever. Reaching this cap prevents *new* runs and never kills a running one (BD-010); the task then reads `Paused: budget` and a human may raise the cap here. `Idempotency-Key` is optional and honoured.',
        tags: ['projects'],
        params: projectParamsSchema,
        body: putBudgetsRequestSchema,
        response: {
          200: budgetWriteResponseSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      // A budget for a project that does not exist would insert a row with a dangling scope id:
      // `budgets.scope_id` is deliberately **not** a foreign key (it addresses four scopes), so
      // nothing else would refuse it.
      if (!(await options.queries.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }
      return (await settingsWrite({
        request,
        action: 'budget.write',
        subject: { project_id: projectId, body: request.body },
        params: {
          project_id: projectId,
          scope: 'project',
          window: request.body.window,
          limit_usd: request.body.limit_usd,
        },
        auditResult: (result: WriteBudgetResult) => ({
          outcome: result.outcome,
          // product/18:5 — the row says what changed. `outcome` alone cannot say what a raise was
          // raised from, and the previous cap is the number an operator asks about afterwards.
          before_limit_usd: result.previousLimitUsd,
        }),
        perform: async (userId) =>
          options.queries.writeBudget({
            scope: 'project',
            scopeId: projectId,
            window: request.body.window,
            limitUsd: request.body.limit_usd,
            ...(request.body.notify_pct === undefined
              ? {}
              : { notifyPct: request.body.notify_pct }),
            createdBy: userId,
          }),
        answer: async ({ performed, result }) => ({
          // A replay answers the outcome it cannot recompute honestly: nothing was performed now.
          outcome: result?.outcome ?? 'updated',
          performed,
        }),
      })) as z.output<typeof budgetWriteResponseSchema>;
    },
  );

  typed.get(
    '/api/org/budgets',
    {
      preHandler: requirePermission(guard, 'budget.read'),
      schema: {
        summary: 'The organisation’s budgets, with the spend of the current window',
        description:
          'BD-010’s organisation caps. The window boundary is the organisation’s own timezone (Q12), the same one the ledger charges in, so this and the project view agree about when a day turned.',
        tags: ['org'],
        response: { 200: budgetsResponseSchema },
      },
    },
    async () => ({ items: [...(await options.queries.orgBudgets())] }),
  );

  typed.put(
    '/api/org/budgets',
    {
      preValidation: requirePermission(guard, 'budget.write'),
      schema: {
        summary: 'Set or remove the organisation’s budget for one window (BD-010)',
        description:
          'The organisation half of the project route, and the same upsert on `(scope, scope_id, window)` — `scope_id` is null, which the unique index treats as one value (`nulls not distinct`), so there is exactly one organisation cap per window. technical/08 sketches `PUT /api/org/budgets/:id`; an id-keyed write has no creator, and the natural key is the window, so the write is keyed by it. Reaching this cap prevents new runs **anywhere** and never kills a running one.',
        tags: ['org'],
        body: putBudgetsRequestSchema,
        response: { 200: budgetWriteResponseSchema, 400: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request) =>
      (await settingsWrite({
        request,
        action: 'budget.write',
        subject: { scope: 'org', body: request.body },
        params: {
          scope: 'org',
          window: request.body.window,
          limit_usd: request.body.limit_usd,
        },
        auditResult: (result: WriteBudgetResult) => ({
          outcome: result.outcome,
          before_limit_usd: result.previousLimitUsd,
        }),
        perform: async (userId) =>
          options.queries.writeBudget({
            scope: 'org',
            scopeId: null,
            window: request.body.window,
            limitUsd: request.body.limit_usd,
            ...(request.body.notify_pct === undefined
              ? {}
              : { notifyPct: request.body.notify_pct }),
            createdBy: userId,
          }),
        answer: async ({ performed, result }) => ({
          outcome: result?.outcome ?? 'updated',
          performed,
        }),
      })) as z.output<typeof budgetWriteResponseSchema>,
  );

  typed.get(
    '/api/projects/:project_id/audit',
    {
      preHandler: requirePermission(guard, 'org.audit.read', { project: projectOf }),
      schema: {
        summary: 'Who changed this project’s settings, newest first',
        description:
          'The `human_actions` rows whose `params.project_id` is this project — the wizard’s and the settings screens’ writes. product/18:5 requires every toggle to record who changed it, and a row nothing reads is not a record anybody can check (PROGRESS backlog 52). It is **not** the whole audit: a task command’s row names a task rather than a project, and `GET /api/org/audit` serves `config_audit`. `params` is client-supplied JSON and is rendered as text, never as markup (BD-022).',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: projectAuditResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      if (!(await options.queries.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }
      return options.queries.projectAudit(projectId, PROJECT_AUDIT_LIMIT);
    },
  );
};
