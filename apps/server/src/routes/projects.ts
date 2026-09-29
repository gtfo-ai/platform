/**
 * The project reads of technical/08: the list, the effective configuration, the budgets, the task
 * page and the readiness ladder.
 *
 * `GET /api/projects/:project_id/config` is the effective configuration with per-key provenance
 * (technical/12 § "Effective configuration"), `…/budgets` is the projection WP-19's ledger folds
 * spend into, and WP-15h part 2 added `GET /api/projects`, `…/tasks` and `…/readiness`.
 *
 * Project scoping is a property of the RBAC middleware that only a real project-scoped request can
 * demonstrate, and every route with a `:project_id` carries the same guard. `GET /api/projects` has
 * no id to scope by, so it is decided on the organisation role — which is the honest reading of a
 * list: `project.read` is `viewer` at organisation level anyway, and a per-project filter here would
 * be the only place in the server that answers a different question from `can()`.
 *
 * **The writes moved next door.** `POST /api/projects`, `PUT …/config`, `GET/PUT …/bindings` and
 * `POST …/discovery` are served by `routes/onboarding.ts` since WP-21 — a command needs an audit
 * row and an `Idempotency-Key` a read does not — and `GET/PUT …/autonomy`, `PUT …/budgets` and
 * `GET …/audit` by `routes/settings.ts` since WP-30, which is the same settings reached from the
 * other side of onboarding. `POST …/config/export` and `POST …/config/refresh` are
 * `routes/project-config.ts`'s since WP-63, which also made `GET …/config` merge what technical/12
 * names — the organisation's command maximum, the settings, and the repository's own
 * `.agentic/config.yml` from the default branch — through `mergeProjectConfig`, its first production
 * caller ({@link effectiveConfigResponseOf}).
 */

import type {
  RepositoryConfigNotApplied,
  RepositoryConfigSnapshot,
  SecretRedactor,
} from '@platform/application';
import {
  ignoredProjectAllow,
  REPOSITORY_CONFIG_PATH,
  settingsNotApplied,
  tightenRepositoryLayer,
} from '@platform/application';
import {
  type AgenticConfig,
  type AutonomyLevel,
  agenticConfigSchema,
  apiErrorSchema,
  budgetsResponseSchema,
  type ConfigSource,
  checklistNameOf,
  type EffectiveConfigResponse,
  effectiveConfigResponseSchema,
  type IsoDateTime,
  type LastConfigExport,
  listTasksQuerySchema,
  type OrganisationSettings,
  projectsResponseSchema,
  type RepositoryConfigReading,
  type RiskClass,
  readinessResponseSchema,
  riskClassSchema,
  slugSchema,
  tasksResponseSchema,
} from '@platform/contracts';
import {
  type ConfigValues,
  mergeProjectConfig,
  PROPOSED_REVIEW_CHECKLISTS,
  PROPOSED_RISK_CLASSES,
  resolveWipLimits,
} from '@platform/domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { organisationSettingsForRequest, repositorySnapshotFrom } from '../config-layers.js';
import { HttpError, NotFoundError } from '../errors.js';
import { findProjectTimezone, listProjectBudgets } from '../queries/cost-queries.js';
import type { Database } from '../queries/identity-queries.js';
import {
  type ConfigLayerColumns,
  findConfigLayers,
  findProjectConfig,
  findProjectRole,
  type ProjectConfigRow,
} from '../queries/identity-queries.js';
import { listProjectTasks, type TaskCursor } from '../queries/pipeline-queries.js';
import {
  findLastConfigExport,
  findProjectReadiness,
  listProjectSummaries,
} from '../queries/project-queries.js';

export interface ProjectRoutesOptions {
  readonly database: Database;
  /**
   * TD-012 step 2 — the platform's pattern rules, injected.
   *
   * The only thing this module publishes that did not come out of a typed projection is the
   * `invalid_stored_config` refusal, which quotes `projects.config` back at the caller;
   * {@link describeConfigIssues} says why that needs a redactor. A read request carries no
   * run-scoped credential (Q55), so the patterns alone are the honest composition — the same one
   * `routes/settings.ts` is given.
   */
  readonly redactor: SecretRedactor;
}

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

/** Default page size for the task list; the client sends its own `limit` when it wants one. */
const DEFAULT_TASK_LIMIT = 50;

/**
 * technical/08's `next_cursor` for the task page, which is a **pair**.
 *
 * `tasks.id` is a uuidv7 and `created_at` is `now()`, so two tasks created inside one transaction
 * share the timestamp exactly — a cursor of the timestamp alone would skip whichever of them fell
 * after a page boundary, silently, because a short page and the last page look the same. Opaque by
 * contract and parsed as untrusted input: the client sends back what it was given, so anything else
 * is a `400` rather than half a keyset in a query.
 *
 * The timestamp is the **database's own rendering, to the microsecond**, and is passed through
 * without being parsed into a `Date` — {@link TaskCursor} records the row that was skipped when it
 * was.
 */
export const encodeTaskCursor = (cursor: TaskCursor): string => `${cursor.createdAt}|${cursor.id}`;

const taskCursorSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});

export const decodeTaskCursor = (raw: string): TaskCursor => {
  const separator = raw.lastIndexOf('|');
  const parsed = taskCursorSchema.safeParse({
    createdAt: separator < 0 ? '' : raw.slice(0, separator),
    id: separator < 0 ? '' : raw.slice(separator + 1),
  });
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_cursor',
      'the cursor is not one this endpoint issued; ask for the first page and follow next_cursor',
    );
  }
  // Passed back as the string it arrived as — the query casts it in the database. Parsing it into
  // a `Date` here is exactly the truncation `TaskCursor`'s docblock measures.
  return { createdAt: parsed.data.createdAt, id: parsed.data.id };
};

/** Longest rendering of one offending clause; stored state came from outside (BD-022). */
export const MAX_STORED_VALUE_CHARS = 120;

/**
 * `features.review_only.trigger: "manual"` — one clause per zod issue, in the order they were found.
 *
 * The **key path and the value**, because a refusal an operator cannot act on is a 500 with better
 * manners. `instancePath`-style dotted paths are the same spelling `toApiError` gives a request's
 * own validation errors (`errors.ts`), so the two refusals read alike.
 *
 * **Every clause goes through the caller's redactor** (TD-012, BD-022), and all three of its parts
 * do: `projects.config` is text an operator typed (the repository's own file is a separate layer
 * since WP-63, refused with its key paths by `describeRepositoryConfigIssues`, which quotes no
 * value), the value is whatever was stored there, and a *strict* schema puts an
 * unrecognised **key** into both the path and zod's own message — so a credential pasted into a
 * config file reaches this string by three routes, not one. It is the same composition
 * `routes/settings.ts` gives `override_reason` and `routes/commands.ts` gives every task command,
 * injected rather than constructed here for the same reason.
 *
 * Redaction runs **before** the bound, which is the opposite order from `auditedText`'s and is
 * deliberate: truncating first can cut a credential in half, and half a credential is both
 * unmatchable by the rules and still a prefix of the secret.
 */
export const describeConfigIssues = (
  document: unknown,
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
  redactText: (value: string) => string,
): string =>
  issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      const value = valueAt(document, issue.path);
      const clause =
        value === undefined
          ? `${path === '' ? '(root)' : path} (${issue.message})`
          : `${path}: ${JSON.stringify(value)}`;
      return redactText(clause).slice(0, MAX_STORED_VALUE_CHARS);
    })
    .join(', ');

const valueAt = (document: unknown, path: readonly PropertyKey[]): unknown => {
  let current: unknown = document;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
};

/**
 * What the wizard is offered for `policies.risk_classes` — product/18:52 (WP-37, WP-45).
 *
 * A discovery run's proposal when there is one, and product/19 §14's own table when there is not.
 * **Both are parsed before they are published**, and a stored proposal that does not parse is
 * dropped back to the platform's table rather than refused: this field is an *offer*, so failing
 * the whole configuration read over it would make an unopenable settings screen out of a suggestion
 * (PROGRESS backlog 58's distinction — fail closed on the write, open on the read). The stored value
 * is model output about somebody's repository, which is the other reason it is re-validated here
 * (BD-022).
 *
 * **A stored class's `require` is the platform table's, read now** (WP-45). What a class forces was
 * never the model's (`proposedClassesFrom` copies it from `PROPOSED_RISK_CLASSES` at the write), so
 * a proposal a Discovery run stored before `payments` gained its checklist would otherwise go on
 * offering the half-class this row exists to retire — the stored copy is a snapshot of a platform
 * policy, and the policy is the one to publish. Only the paths are the proposal's.
 *
 * `checklists` is every `checklist:<name>` the offered classes select, with the classes that select
 * it, product/19's words for it and whether `config` already defines it — the thing accepting asks
 * the operator to write, on the published document rather than in a docblock (PROGRESS backlog 91).
 */
export const riskClassProposalOf = (
  stored: Record<string, unknown> | null,
  config: AgenticConfig | null = null,
): EffectiveConfigResponse['risk_class_proposal'] => {
  const parsed = stored === null ? null : z.record(slugSchema, riskClassSchema).safeParse(stored);
  const proposed = parsed?.success === true && Object.keys(parsed.data).length > 0;
  const classes: Record<string, RiskClass> = proposed
    ? Object.fromEntries(
        Object.entries(parsed.data).map(([name, declared]) => [
          name,
          {
            paths: declared.paths,
            require: [
              ...(Object.hasOwn(PROPOSED_RISK_CLASSES, name)
                ? (PROPOSED_RISK_CLASSES[name] as RiskClass).require
                : declared.require),
            ],
          },
        ]),
      )
    : Object.fromEntries(
        Object.entries(PROPOSED_RISK_CLASSES).map(([name, declared]) => [
          name,
          { paths: [...declared.paths], require: [...declared.require] },
        ]),
      );
  const defined = config?.policies?.review_checklists ?? {};
  const checklists = new Map<string, string[]>();
  for (const [name, declared] of Object.entries(classes)) {
    for (const requirement of declared.require) {
      const checklist = checklistNameOf(requirement);
      if (checklist !== null) {
        checklists.set(checklist, [...(checklists.get(checklist) ?? []), name]);
      }
    }
  }
  return {
    source: proposed ? 'discovery' : 'platform',
    classes: classes as EffectiveConfigResponse['risk_class_proposal']['classes'],
    checklists: [...checklists.entries()].map(([name, requiredBy]) => ({
      name,
      required_by: requiredBy,
      purpose:
        (Object.hasOwn(PROPOSED_REVIEW_CHECKLISTS, name)
          ? PROPOSED_REVIEW_CHECKLISTS[name]?.purpose
          : undefined) ??
        'a review checklist a proposed class selects; the platform ships no items (Q83), so the list is yours to write',
      defined: Object.hasOwn(defined, name),
    })),
  };
};

/**
 * The autonomy position the published view is capped at — the organisation's `autonomy.maximum`
 * (WP-93), or `autonomous` when it states none.
 *
 * `mergeProjectConfig` caps `policies.autonomy` at this value, or at the shipped default when the
 * caller passes nothing — the reading that keeps a repository from handing itself `autonomous`. On
 * this build the repository cannot state the dial at all (its `policies.autonomy` is not applied,
 * `REPOSITORY_AUTONOMY_NOT_APPLIED`), so the cap that matters is the organisation's, the one the
 * settings port applies to the materialised dial (`cappedAutonomy` in `pipeline.ts`). With no
 * maximum stated, all four positions are selectable (WP-30), and capping at the shipped default
 * would publish `supervised` for a project that runs `autonomous` — a lie about the running system.
 */
export const publishedAutonomyMaximum = (organisation: OrganisationSettings): AutonomyLevel =>
  organisation.autonomy?.maximum ?? 'autonomous';

/**
 * `GET …/config`'s answer — pure, so every refusal and both directions of precedence are driven
 * without a database (WP-63).
 *
 * Three refusals, each a `409` naming what to fix, none a silently missing layer (standing rule 20):
 * the stored settings layer does not parse (`invalid_stored_config`, backlog 58); the organisation's
 * `settings.commands` does not (`invalid_organisation_config`); or the repository's file on the
 * default branch does not (`invalid_repository_config`, WP-63 criterion 4) — the last with the key
 * paths the reading recorded, already redacted and bounded where it was stored.
 */
export const effectiveConfigResponseOf = (input: {
  readonly projectId: string;
  readonly row: ProjectConfigRow;
  readonly layers: ConfigLayerColumns | null;
  readonly redactText: (value: string) => string;
  /** The project's last recorded export (WP-91, backlog 225); omitted reads as none. */
  readonly lastExport?: LastConfigExport | null;
}): EffectiveConfigResponse => {
  const { projectId, row } = input;
  // A project that has never been configured stores `{}`. The settings layer of "no
  // configuration" is the schema's own minimum — version 1 — not an empty object, which would not
  // validate.
  const raw = Object.keys(row.config).length === 0 ? { version: 1 } : row.config;
  const parsed = agenticConfigSchema.safeParse(raw);
  if (!parsed.success) {
    /**
     * **Named, and a 409 rather than a 500** — PROGRESS backlog 58.
     *
     * Boundary schemas are strict, so a value a *previous* release accepted is refused rather
     * than dropped. That is right on the write side, where the platform is about to act, and
     * wrong on the read side, where it is being told what it stored itself: a whole document
     * failing over one key, with a 500 that named no key and offered an import endpoint that
     * does not exist, made wizard step 4 and the project panel unopenable and gave an operator
     * nothing to act on (standing rule 20 splits the two sides).
     *
     * It stays a **refusal** — nothing is dropped, so strictness is preserved and a silently
     * pruned document cannot be re-saved without the key the operator never saw — but it names
     * every key it could not parse and the value it found there, which is a `PUT` an operator
     * can make. The value is stringified, **redacted** and bounded because it is stored state,
     * and stored state came from outside (BD-022) — `describeConfigIssues` has the order and
     * the reason for it.
     */
    throw new HttpError(
      409,
      'invalid_stored_config',
      `the stored configuration of project ${projectId} has ${parsed.error.issues.length} key(s) this release does not accept: ` +
        `${describeConfigIssues(raw, parsed.error.issues, input.redactText)}. ` +
        `Send a corrected document to PUT /api/projects/${projectId}/config`,
    );
  }

  const organisation = organisationSettingsForRequest(input.layers?.orgSettings);
  const organisationCommands = organisation.commands;
  const organisationWip = organisation.pipeline?.wip;

  const snapshot = repositorySnapshotFrom(input.layers ?? {});
  if (snapshot?.status === 'invalid') {
    throw new HttpError(
      409,
      'invalid_repository_config',
      `the repository's .agentic/config.yml on the default branch (commit ${snapshot.commitSha}) does not parse: ${snapshot.detail}. ` +
        'The effective configuration is not computed without it, and no run of this project starts until it parses. ' +
        `Correct the file on the default branch, or propose the settings over it (POST /api/projects/${projectId}/config/export), then re-read it (POST /api/projects/${projectId}/config/refresh)`,
    );
  }

  const { version: _version, ...project } = parsed.data;
  // WP-63 review round 1: the file may tighten, never loosen (`repository-grades.ts`). Its
  // tighten-only keys are merged against the settings here, so the merge below can only add.
  const tightened =
    snapshot?.status === 'valid' ? tightenRepositoryLayer(project, snapshot.values) : undefined;
  const repo = tightened?.values;
  const effective = mergeProjectConfig(
    [
      ...(organisationCommands === undefined
        ? []
        : [{ source: 'org' as const, values: { commands: organisationCommands } }]),
      { source: 'project' as const, values: project },
      ...(repo === undefined ? [] : [{ source: 'repo' as const, values: repo }]),
    ],
    { autonomyMaximum: publishedAutonomyMaximum(organisation) },
  );

  // WP-91 (backlog 224): the organisation's WIP maximum bounds whatever the layers produced — the
  // settings port's `resolveWipLimits`, so the view and admission cannot disagree.
  const wip = resolveWipLimits(effective.values.pipeline?.wip, organisationWip);
  const sources: Record<string, ConfigSource> = { ...effective.sources };
  for (const bound of wip.bounded) {
    sources[bound.key] = 'org';
  }
  const effectiveValues: ConfigValues = {
    ...effective.values,
    pipeline: {
      ...effective.values.pipeline,
      wip: {
        max_parallel_tasks: wip.limits.maxParallelTasks,
        max_tasks_in_pipeline: wip.limits.maxTasksInPipeline,
      },
    },
  };

  return {
    config: parsed.data,
    effective: { version: 1, ...effectiveValues },
    sources,
    repository: repositoryReadingOf(snapshot, tightened?.notApplied ?? []),
    hash: row.configHash ?? 'unconfigured',
    computed_at: row.updatedAt.toISOString(),
    not_applied: [
      ...settingsNotApplied(project),
      ...wip.bounded.map((bound) => ({
        key: bound.key,
        reason: `the organisation's maximum is ${bound.bound}, so ${bound.bound} applies rather than ${bound.stated}`,
      })),
    ],
    last_export: input.lastExport ?? null,
    // WP-54: what the project declared and no role's baseline grants — dropped, never widened
    // (BD-025), and published here rather than dropped in silence. Since WP-63 it is judged after
    // the organisation maximum, and the repository file's entries after the settings' — so a file
    // trying to re-grant what the settings removed is listed here too.
    ignored_allow_commands: [
      ...ignoredProjectAllow(project.commands, organisationCommands, repo?.commands),
    ],
    risk_class_proposal: riskClassProposalOf(row.proposedRiskClasses, parsed.data),
  };
};

/** A recorded export as the DTO publishes it (`lastConfigExportSchema`). */
export const lastExportOf = (
  recorded: Awaited<ReturnType<typeof findLastConfigExport>>,
): LastConfigExport | null =>
  recorded === null
    ? null
    : {
        status: recorded.status,
        config_hash: recorded.configHash,
        branch: recorded.branch,
        merge_request_url: recorded.mergeRequestUrl,
        exported_at: recorded.exportedAt,
      };

/** The reading as the DTO publishes it (`repositoryConfigReadingSchema`). */
export const repositoryReadingOf = (
  snapshot: RepositoryConfigSnapshot | null,
  /** What the tighten-only merge kept from the settings over the file (WP-63 review round 1). */
  merged: readonly RepositoryConfigNotApplied[] = [],
): RepositoryConfigReading => ({
  path: REPOSITORY_CONFIG_PATH,
  status: snapshot?.status ?? 'unread',
  commit_sha: snapshot?.commitSha ?? null,
  read_at: snapshot?.readAt ?? null,
  detail: snapshot?.status === 'invalid' ? snapshot.detail : null,
  not_applied: snapshot?.status === 'valid' ? [...snapshot.notApplied, ...merged] : [],
});

export const registerProjectRoutes = async (
  app: FastifyInstance,
  options: ProjectRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      findProjectRole(options.database, projectId, userId),
  };

  typed.get(
    '/api/projects',
    {
      preHandler: requirePermission(guard, 'project.read'),
      schema: {
        summary: 'Every project, with its open work and its recent spend',
        description:
          '`open_tasks` counts the tasks that are neither `done` nor `cancelled` — `merged` and `retro` are still in flight. `spent_usd_30d` sums `cost_rollup_daily` over the last thirty calendar days **in the organisation’s timezone** (Q12), so it agrees with the budget windows about when a day turned. Project names and repository URLs come from configuration, not from a model.',
        tags: ['projects'],
        response: { 200: projectsResponseSchema },
      },
    },
    // `new Date()` is the read's own instant: "the last thirty days" is a question about now, and
    // the caller does not get to choose which thirty.
    async () => listProjectSummaries(options.database, new Date().toISOString() as IsoDateTime),
  );

  typed.get(
    '/api/projects/:project_id/config',
    {
      preHandler: requirePermission(guard, 'project.read', {
        // Project scoping: the caller's role for *this* project, which may be higher than their
        // organisation role (see auth/rbac.ts).
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'Effective project configuration, with the source of every key',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: effectiveConfigResponseSchema, 404: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const row = await findProjectConfig(options.database, projectId);
      if (row === null) {
        throw new NotFoundError(`project ${projectId}`);
      }
      return effectiveConfigResponseOf({
        projectId,
        row,
        layers: await findConfigLayers(options.database, projectId),
        redactText: (value) => options.redactor.redactText(value).value,
        lastExport: lastExportOf(await findLastConfigExport(options.database, projectId)),
      });
    },
  );

  typed.get(
    '/api/projects/:project_id/budgets',
    {
      preHandler: requirePermission(guard, 'project.read', {
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'Budgets applying to this project, with the spend of the current window',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: budgetsResponseSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const zone = await findProjectTimezone(options.database, projectId);
      if (zone === undefined) {
        throw new NotFoundError(`project ${projectId}`);
      }
      if (zone.substituted) {
        // The same state the ledger charges in UTC and warns about; a read answers with the window
        // it actually used rather than a 500 (`findProjectTimezone` says why).
        request.log.warn(
          { project_id: projectId, fallback: zone.timezone },
          'the organisation timezone is not an IANA zone this runtime can use; budget windows are read in UTC',
        );
      }
      // Q12: the organisation's zone decides where the window boundary falls. `new Date()` is the
      // read's own instant — a budget window is "now", and the caller does not get to choose which
      // window it is shown.
      const items = await listProjectBudgets(
        options.database,
        projectId,
        new Date().toISOString() as IsoDateTime,
        zone.timezone,
      );
      return { items: [...items] };
    },
  );

  typed.get(
    '/api/projects/:project_id/tasks',
    {
      preHandler: requirePermission(guard, 'task.read', {
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'One page of a project’s tasks, newest first',
        description:
          'Filtered by `state`, `template`, `mode` or `stage`. `next_cursor` is an **opaque** keyset over `(created_at, id)`: send it back unchanged, never parse it. A task carries the ticket’s provider, key and URL, which are external text (BD-022): render them, never execute them.',
        tags: ['tasks'],
        params: projectParamsSchema,
        querystring: listTasksQuerySchema,
        response: { 200: tasksResponseSchema },
      },
    },
    async (request) => {
      const query = request.query;
      const limit = query.limit ?? DEFAULT_TASK_LIMIT;
      const page = await listProjectTasks(options.database, request.params.project_id, {
        limit,
        ...(query.cursor === undefined ? {} : { before: decodeTaskCursor(query.cursor) }),
        ...(query.state === undefined ? {} : { state: query.state }),
        ...(query.template === undefined ? {} : { template: query.template }),
        ...(query.mode === undefined ? {} : { mode: query.mode }),
        ...(query.stage === undefined ? {} : { stage: query.stage }),
      });
      if (page === null) {
        // The same answer `/config`, `/budgets` and `/readiness` give for the same id: an empty page
        // and a project that does not exist are different facts, and only one of them is a 200.
        throw new NotFoundError(`project ${request.params.project_id}`);
      }
      return {
        items: [...page.items],
        next_cursor: page.next === undefined ? null : encodeTaskCursor(page.next),
      };
    },
  );

  typed.get(
    '/api/projects/:project_id/readiness',
    {
      preHandler: requirePermission(guard, 'project.read', {
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'The project’s readiness evaluation',
        description:
          'product/17’s fourteen criteria as the last evaluation found them, with the level they add up to and the three cheapest improvements next. `unlocks` is platform text; `evidence` is the Discovery agent’s own words for the eleven criteria it answers (BD-022) — render it, never execute it. Refuses with 409 `readiness_not_evaluated` for a project nothing has evaluated yet, which is a project whose discovery run has not happened.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: readinessResponseSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const readiness = await findProjectReadiness(options.database, projectId);
      if (!readiness.found) {
        throw new NotFoundError(`project ${projectId}`);
      }
      if (readiness.recorded) {
        return readiness.response;
      }
      /**
       * **The refusal is a statement about this project, not about the build.**
       *
       * It used to be the latter — nothing wrote `readiness_evaluations` at all — and WP-21's
       * evaluator changed which sentence is true. What has not changed is why a projection is
       * refused in its place: `readinessResponseSchema` publishes the criteria, the evidence and
       * the instant of an evaluation, and `projects.readiness_level` carries none of those, so
       * `{level: 0, evaluated_at: <now>, criteria: []}` would invent two of the three. The row
       * count stays in the message because it is what distinguishes "nothing has evaluated this
       * project" from "rows exist and this reader could not read them".
       */
      throw new HttpError(
        409,
        'readiness_not_evaluated',
        `project ${projectId} has no readiness evaluation (${readiness.rows} readiness_evaluations rows): run discovery on it (POST /api/projects/${projectId}/discovery), which is what records one. The published record needs the criteria, the evidence and the instant of an evaluation, none of which projects.readiness_level carries`,
      );
    },
  );
};
