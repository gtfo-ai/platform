/**
 * `get_task_context` — the platform tool whose job is *"read the platform's own record of this
 * task"*, answered over the read projections instead of refused (WP-54, PROGRESS backlog 83).
 *
 * From WP-17 to WP-54 the production surface refused it by name for all ten roles that hold it,
 * so a run knew only what fitted in its prompt: a reviewer could not re-read the plan it was
 * reviewing against, and an ask answered a question about a long record from whatever the pack
 * held — with no way to say *"I could not look"*.
 *
 * ## Three rules, and they are the projections' rules
 *
 *  1. **This task, never another.** Every read is keyed by `PlatformToolContext.taskId`, which the
 *     runner builds from the `RunSpec` — the tool's input has no task or project field, so a model
 *     cannot name a different one. The task row's `project_id` is checked against the context's as
 *     well, and a mismatch is a refusal of the whole call rather than an answer.
 *  2. **A field the projection cannot answer is refused, by name, and never invented** — the rule
 *     `pipeline-queries.ts` already follows. Each requested value answers `{status: 'ok', …}` or
 *     `{status: 'refused', reason}`; `null` never stands in for "the platform does not know".
 *  3. **Everything returned is untrusted data** (BD-022): ticket text, artifact bodies a model
 *     wrote, return feedback, `human_actions.params` a client chose. It reaches the model as a
 *     tool result — JSON, so every value is a string inside the structure — after
 *     `platform-mcp.ts` has run the run's own redactor over the whole of it.
 *
 * ## What each `include` value is, and what it is not
 *
 * | value | answered from | refused when |
 * |---|---|---|
 * | `ticket` | `tasks.ticket_snapshot` (bounded and redacted at the write, WP-15f) | the platform has not read the ticket |
 * | `artifacts` | the latest version of each type, `findArtifactBody` | per artifact: stored before redaction existed (migration 0038) |
 * | `feedback` | `task_stages` rows with `state = 'returned'`: the stage, its target (`returned_to`), the reason and — since WP-105 — its `cause` ({@link returnCauseOf}) — escalations excluded (WP-55) | never; an empty list is an answer |
 * | `mr` | `tasks.mr_ref` and `tasks.branch` | the task has no merge request yet |
 * | `ci` | `tasks.coverage` — the one per-task CI figure the platform stores | no coverage was recorded; pipeline runs themselves are **not** projected per task |
 * | `runs` | `findTaskDetail`'s runs, newest {@link TASK_CONTEXT_RUN_LIMIT}, as {@link RUN_FIELDS_FOR_AGENTS} | never |
 * | `audit` | `human_actions` for this task, newest {@link TASK_CONTEXT_AUDIT_LIMIT} | never |
 *
 * ## What the prompt already holds is not sent again (PROGRESS backlog 474)
 *
 * A stage run's prompt carries the ticket and every artifact the assembler did not cut, and on
 * Autix the tool re-sent both — about 22 KB, twice in one context. The planner records what the
 * prompt holds whole (`RunSpec.promptHolds`, from the assembler's own cut) and this read answers
 * those with `status: 'in_prompt'` and a sentence saying where they are. A run whose spec carries
 * no record (the ask) is served everything, the direction that wastes context rather than hides it.
 *
 * `ci` is narrow on purpose: `ci.pipeline.finished` is stored on the **project** stream and its
 * `task_id` is often absent (the gate resolves a pipeline to a task by merge request when it reads
 * it), so a per-task list of pipelines would be a second resolution of that join written here.
 */
import type { PromptHolds } from '@platform/application';
import type { ArtifactType, Id, JsonObject, TicketSnapshot } from '@platform/contracts';
import { isBuiltinGateStageId } from '@platform/contracts';
import { isPromptExcludedArtifact, orderArtifactData } from '@platform/domain';
import { ask as askAdapters, db as dbAdapters } from '@platform/infrastructure';
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { type Database, findArtifactBody, findTaskDetail } from './pipeline-queries.js';

const { artifacts, humanActions, runs, taskStages, tasks } = dbAdapters.schema;
const { MANUAL_START_ACTION_ID_SQL } = askAdapters;

/** Every value `get_task_context`'s `include` accepts (`getTaskContextInputSchema`). */
export type TaskContextInclude =
  | 'ticket'
  | 'artifacts'
  | 'feedback'
  | 'mr'
  | 'ci'
  | 'runs'
  | 'audit';

/**
 * The size of one answer, in characters of its JSON rendering (WP-54 review round 1).
 *
 * Row counts alone did not bound it: every latest artifact, fifty runs and a hundred client-chosen
 * `human_actions.params` documents have no size between them. Each requested value gets an equal
 * share; a list that does not fit keeps its first items and says `truncated: true` with how many it
 * `omitted`, an artifact larger than the share on its own is refused by name with where to read
 * it, and a single-document value (`ticket`) that does not fit is refused rather than cut — the
 * same "announce it, never silently shorten" rule the prompt's own data blocks follow.
 *
 * **Measured before redaction.** `platform-mcp.ts` runs the run's redactor over the rendered answer
 * afterwards, and a redaction marker (`[REDACTED:…]`) can be longer than the value it replaces, so
 * the answer the model reads may be slightly over this cap.
 */
export const TASK_CONTEXT_MAX_CHARS = 160_000;

/**
 * The share the ticket is guaranteed: a stored snapshot is bounded at the write (WP-15f) and
 * serialises to about 43 000 characters at its cap for ordinary text — an estimate, not measured
 * against JSON escaping: a snapshot heavy in quotes or newlines serialises larger and is then
 * refused by name rather than served, which is the safe side.
 */
export const TASK_CONTEXT_TICKET_SHARE = 48_000;

/** The list each value carries, where it carries one — what a bound shortens. */
const LIST_OF: Readonly<Partial<Record<TaskContextInclude, string>>> = {
  artifacts: 'latest_per_type',
  feedback: 'returns',
  runs: 'runs',
  audit: 'actions',
};

const sizeOf = (value: unknown): number => JSON.stringify(value).length;

/**
 * What an artifact that does not fit is answered with (PROGRESS backlog 474): what to call instead,
 * never a URL — the `/api/artifacts/…` path this used to name is one no agent tool can reach.
 */
const artifactStubReason = (size: number): string =>
  size < TASK_CONTEXT_MAX_CHARS
    ? `this artifact is ${String(size)} characters and did not fit beside the rest of this answer; call get_task_context again with include ["artifacts"] and artifact_types naming only this type`
    : `this artifact is ${String(size)} characters, more than one answer carries (${String(TASK_CONTEXT_MAX_CHARS)}); work from the copy in your prompt and say in your artifact that you could not read it whole`;

/**
 * Fits one value into its share of {@link TASK_CONTEXT_MAX_CHARS}.
 *
 * Two list shapes, two rules. **Artifacts** are independent documents, so one that does not fit is
 * replaced by a refusal naming it and where to read it, and the loop **continues** — a small plan
 * after a large spec is still served. **Runs, audit rows and returns** are ordered records (newest
 * first, or in order of return), so the loop **stops** at the first that does not fit and reports
 * how many it `omitted`: a gapped list would read as "these are the newest" while not being so.
 * A single-document value that does not fit is refused, never cut.
 */
export const boundTaskContextSection = (
  value: TaskContextInclude,
  section: TaskContextSection,
  budget: number,
): TaskContextSection => {
  if (section.status !== 'ok' || sizeOf(section) <= budget) {
    return section;
  }
  const key = LIST_OF[value];
  if (key === undefined) {
    return refused(
      `this value is ${String(sizeOf(section))} characters and this call's share is ${String(budget)}; ask for it with fewer values`,
    );
  }
  const items = section[key] as readonly Record<string, unknown>[];
  const withList = (list: readonly unknown[], omitted: number) => ({
    ...section,
    [key]: list,
    truncated: omitted > 0 || section['truncated'] === true,
    omitted,
  });
  const kept: Record<string, unknown>[] = [];
  let omitted = 0;
  for (const item of items) {
    if (sizeOf(withList([...kept, item], omitted)) <= budget) {
      kept.push(item);
      continue;
    }
    if (value !== 'artifacts') {
      omitted = items.length - kept.length;
      break;
    }
    const stub = {
      artifact_type: item['artifact_type'],
      version: item['version'],
      status: 'refused',
      reason: artifactStubReason(sizeOf(item)),
    };
    if (sizeOf(withList([...kept, stub], omitted)) <= budget) {
      kept.push(stub);
    } else {
      omitted += 1;
    }
  }
  return withList(kept, omitted);
};

/**
 * Each requested value's share. The **ticket** is guaranteed {@link TASK_CONTEXT_TICKET_SHARE},
 * because a full-size snapshot is one document that can only be served whole or refused, and seven
 * equal shares (22 857 characters each) refused it whenever four or more values were asked for.
 *
 * **Given the sections' sizes, what a small value does not use goes to the large ones** (PROGRESS
 * backlog 474): on Autix the tool refused a 26 415-character plan as over *"this call's share"*
 * while the whole answer used 25.6 k of its 160 k. So the shares are filled like water — the
 * smallest section first, each given its size or an equal part of what is left, whichever is less —
 * and whatever the ticket's guarantee reserved and the ticket did not need joins the rest. Without
 * sizes (the old call) the shares are the equal split, ticket guarantee included.
 */
export const taskContextShares = (
  values: readonly TaskContextInclude[],
  sizes?: Readonly<Partial<Record<TaskContextInclude, number>>>,
): Readonly<Partial<Record<TaskContextInclude, number>>> => {
  const equal = Math.floor(TASK_CONTEXT_MAX_CHARS / values.length);
  const withTicket = values.includes('ticket') && values.length > 1;
  if (sizes === undefined) {
    if (!withTicket) {
      return Object.fromEntries(values.map((value) => [value, equal]));
    }
    const ticket = Math.max(equal, TASK_CONTEXT_TICKET_SHARE);
    const rest = Math.floor((TASK_CONTEXT_MAX_CHARS - ticket) / (values.length - 1));
    return Object.fromEntries(values.map((value) => [value, value === 'ticket' ? ticket : rest]));
  }
  const sizeOfValue = (value: TaskContextInclude): number => sizes[value] ?? 0;
  // The ticket's guarantee, reserved first — only as much of it as the ticket needs.
  const reserved = withTicket ? Math.min(sizeOfValue('ticket'), TASK_CONTEXT_TICKET_SHARE) : 0;
  const filled = withTicket ? values.filter((value) => value !== 'ticket') : [...values];
  const shares: Partial<Record<TaskContextInclude, number>> = {};
  let left = TASK_CONTEXT_MAX_CHARS - reserved;
  const ascending = [...filled].sort((a, b) => sizeOfValue(a) - sizeOfValue(b));
  ascending.forEach((value, index) => {
    const fair = Math.floor(left / (ascending.length - index));
    const share = Math.min(sizeOfValue(value), fair);
    shares[value] = index === ascending.length - 1 ? Math.max(share, fair) : share;
    left -= shares[value] ?? 0;
  });
  if (withTicket) {
    shares.ticket = reserved + Math.max(0, left);
  }
  return shares;
};

/**
 * What an agent is told about each of its task's runs (PROGRESS backlog 474): what happened, not
 * how the platform recorded it. `settings_hash`, `prompt_version`, the token counts, the session id
 * and the redaction count are audit material for a human; in a model's context they were noise it
 * read every time it asked.
 */
export const RUN_FIELDS_FOR_AGENTS = [
  'id',
  'stage',
  'role',
  'attempt',
  'model',
  'status',
  'terminal_reason',
  'started_at',
  'ended_at',
  'num_turns',
  'cost',
] as const;

const runForAgents = (run: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(
    RUN_FIELDS_FOR_AGENTS.filter((key) => Object.hasOwn(run, key)).map((key) => [key, run[key]]),
  );

/** How many of the task's runs and audit rows one call returns — the ask's own bounds. */
export const TASK_CONTEXT_RUN_LIMIT = 50;
export const TASK_CONTEXT_AUDIT_LIMIT = 100;

export type TaskContextSection =
  | ({ readonly status: 'ok' } & Record<string, unknown>)
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'in_prompt'; readonly note: string };

/** What a stage run's prompt carries whole, and which artifact types a call narrowed to. */
export interface TaskContextOptions {
  /** `RunSpec.promptHolds` — absent serves everything, as before backlog 474. */
  readonly promptHolds?: PromptHolds;
  /** `get_task_context`'s `artifact_types`: serve only these types' latest versions. */
  readonly artifactTypes?: readonly ArtifactType[];
}

export interface TaskContextAnswer {
  readonly task_id: Id;
  readonly project_id: Id;
  readonly sections: Readonly<Partial<Record<TaskContextInclude, TaskContextSection>>>;
}

/** Thrown when the call itself cannot be answered: no such task, or not this run's project. */
export class TaskContextRefusedError extends Error {
  override readonly name = 'TaskContextRefusedError';
}

const refused = (reason: string): TaskContextSection => ({ status: 'refused', reason });

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** `tasks.ticket_snapshot`: the ticket's own words as the platform read, bounded and redacted them. */
const findTicketSnapshot = async (
  database: Database,
  taskId: string,
): Promise<{ readonly snapshot: TicketSnapshot | null; readonly readAt: string | null }> => {
  const rows = await database
    .select({ snapshot: tasks.ticketSnapshot, readAt: tasks.ticketSnapshotAt })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const row = rows[0];
  return { snapshot: row?.snapshot ?? null, readAt: iso(row?.readAt ?? null) };
};

/**
 * Every return of this task, oldest first: the attempt that sent the task back, the stage it sent
 * it to (`returned_to`) and the finding it sent it with.
 *
 * **Returns only** (WP-55): `state = 'returned'`, not "every row with a `return_reason`" — the
 * stage executor and the lease sweep write their *escalation* reason into that column too, and an
 * escalation is not something a stage was sent back with. `returned_to` is null for a return
 * written before migration 0040, whose target the row never recorded.
 */
const listReturnFeedback = async (database: Database, taskId: string) =>
  database
    .select({
      id: taskStages.id,
      stage: taskStages.stage,
      attempt: taskStages.attempt,
      returnedTo: taskStages.returnedTo,
      reason: taskStages.returnReason,
      exitedAt: taskStages.exitedAt,
    })
    .from(taskStages)
    .where(
      and(
        eq(taskStages.taskId, taskId),
        eq(taskStages.state, 'returned'),
        isNotNull(taskStages.returnReason),
      ),
    )
    .orderBy(asc(taskStages.enteredAt), asc(taskStages.attempt));

/** The artifact types a stage returns a task by (`stageVerdict`), the only possible causes. */
const VERDICT_TYPES = ['ReviewVerdict', 'AcceptanceVerdict'] as const;

/**
 * The verdicts **a run of each stage attempt produced** — WP-83's link (`runs.task_stage_id` →
 * `artifacts.produced_by_run_id`), the one `lastReturnReason` reads a return's cause by for the
 * pack, read here for every attempt of the task at once.
 */
const listVerdictsByAttempt = async (database: Database, taskId: string) =>
  database
    .select({ taskStageId: runs.taskStageId, type: artifacts.type, version: artifacts.version })
    .from(artifacts)
    .innerJoin(runs, eq(runs.id, artifacts.producedByRunId))
    .where(and(eq(artifacts.taskId, taskId), inArray(artifacts.type, [...VERDICT_TYPES])));

/** `tasks.template_snapshot`'s stage kinds, by id — which returning stages are gates. */
const findStageKinds = async (
  database: Database,
  taskId: string,
): Promise<ReadonlyMap<string, string>> => {
  const rows = await database
    .select({ snapshot: tasks.templateSnapshot })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const stages = (rows[0]?.snapshot as { stages?: unknown } | null | undefined)?.stages;
  const kinds = new Map<string, string>();
  if (Array.isArray(stages)) {
    for (const stage of stages) {
      const entry = stage as { id?: unknown; kind?: unknown };
      if (typeof entry.id === 'string' && typeof entry.kind === 'string') {
        kinds.set(entry.id, entry.kind);
      }
    }
  }
  return kinds;
};

/**
 * **What a return was for** (WP-105, PROGRESS backlog 289, ruled option (b)).
 *
 * The tool keeps the whole history — every return and, in `artifacts`, the latest verdict of each
 * type — because a stage may legitimately need it; what it lacked was the tie between the two that
 * WP-83 gave the pack. So each return names its cause, by the same link:
 *
 *  - `verdict` — the `ReviewVerdict` or `AcceptanceVerdict` a run of the **returning attempt**
 *    produced (the highest version, as `lastReturnReason` picks), by type and version, so a model
 *    can match it against `artifacts` and see whether the verdict it is shown is the one it was
 *    sent back for;
 *  - `gate` — the returning stage is a gate of the task's template (a CI failure, the tamper check,
 *    a rebase conflict or WP-102's unconfirmed paths): a gate produces no artifact, and the reason
 *    is its finding — **except** a person's return or rework out of a task stopped at a gate (an
 *    escalation from `ci_gate`, say), which the row records the same way: the stage is the gate,
 *    and the reason is the person's note, not a finding (WP-105 review round 1);
 *  - `other` — neither: a person's return or rework, the dependency policy, or the review window's
 *    human threads. The row does not record which of those it was, so this answer does not claim
 *    one (the reason carries the words the return was made with).
 *
 * Pure over the rows the section reads, so each branch is a unit case.
 */
export const returnCauseOf = (
  row: { readonly id: string; readonly stage: string },
  verdicts: readonly {
    readonly taskStageId: string | null;
    readonly type: string;
    readonly version: number;
  }[],
  stageKinds: ReadonlyMap<string, string>,
):
  | { readonly kind: 'verdict'; readonly artifact_type: string; readonly version: number }
  | { readonly kind: 'gate'; readonly stage: string }
  | { readonly kind: 'other'; readonly note: string } => {
  const produced = verdicts
    .filter((verdict) => verdict.taskStageId === row.id)
    .sort((left, right) => right.version - left.version)[0];
  if (produced !== undefined) {
    return { kind: 'verdict', artifact_type: produced.type, version: produced.version };
  }
  const kind = stageKinds.get(row.stage);
  if (kind === 'gate' || (kind === undefined && isBuiltinGateStageId(row.stage))) {
    return { kind: 'gate', stage: row.stage };
  }
  return {
    kind: 'other',
    note: 'no verdict and no gate: a person’s return or rework, the dependency policy, or the review window’s threads — the reason says which',
  };
};

/**
 * This task's `human_actions`, newest first, on the table's `(task_id, created_at desc)` index —
 * plus the manual start that caused the task (WP-134), on `human_actions_project_idx`.
 *
 * `params` is **client-supplied** JSON (it carries the caller's own `Idempotency-Key`) and is
 * passed on as data, never interpreted.
 */
const listTaskAudit = async (database: Database, taskId: string, limit: number) =>
  database
    .select({
      id: humanActions.id,
      action: humanActions.action,
      userId: humanActions.userId,
      params: humanActions.params,
      createdAt: humanActions.createdAt,
    })
    .from(humanActions)
    .where(
      // The task's own rows, and the manual start that caused it, whose `task_id` is null (WP-134,
      // backlog 416): the same subquery the Who-did-what read uses (`ask/task-audit.ts`).
      or(
        eq(humanActions.taskId, taskId),
        sql`${humanActions.id} = ${sql.raw(MANUAL_START_ACTION_ID_SQL[0])}${taskId}${sql.raw(
          MANUAL_START_ACTION_ID_SQL[1],
        )}`,
      ),
    )
    .orderBy(desc(humanActions.createdAt))
    .limit(limit);

/**
 * Answers one `get_task_context` call for the task the run belongs to.
 *
 * @throws {TaskContextRefusedError} when the task does not exist or belongs to another project.
 */
export const readTaskContext = async (
  database: Database,
  include: readonly TaskContextInclude[],
  scope: { readonly taskId: Id; readonly projectId: Id },
  options: TaskContextOptions = {},
): Promise<TaskContextAnswer> => {
  const holds = options.promptHolds;
  const heldArtifact = (type: string, version: number): boolean =>
    holds?.artifacts.some((entry) => entry.artifact_type === type && entry.version === version) ??
    false;
  const detail = await findTaskDetail(database, scope.taskId);
  if (detail === null) {
    throw new TaskContextRefusedError(`task ${scope.taskId} does not exist`);
  }
  if (detail.task.project_id !== scope.projectId) {
    // Unreachable through the runner, which builds both ids from one `RunSpec`; checked because
    // "this task, never another" is the tool's one promise and it costs a comparison.
    throw new TaskContextRefusedError(
      `task ${scope.taskId} does not belong to this run's project, so its record is not served`,
    );
  }

  const section = async (value: TaskContextInclude): Promise<TaskContextSection> => {
    switch (value) {
      case 'ticket': {
        if (holds?.ticket === true) {
          return {
            status: 'in_prompt',
            note: 'your prompt carries the ticket whole, in its `ticket` block; it is not sent again',
          };
        }
        const { snapshot, readAt } = await findTicketSnapshot(database, scope.taskId);
        return snapshot === null
          ? refused(
              'the platform has not read this ticket (no snapshot is stored for the task); its key and URL are in your prompt',
            )
          : { status: 'ok', read_at: readAt, snapshot };
      }
      case 'artifacts': {
        const latest = new Map<string, (typeof detail.artifacts)[number]>();
        for (const entry of detail.artifacts) {
          if (
            isPromptExcludedArtifact(entry.artifact_type) ||
            (options.artifactTypes !== undefined &&
              !options.artifactTypes.includes(entry.artifact_type))
          ) {
            continue;
          }
          const current = latest.get(entry.artifact_type);
          if (current === undefined || entry.version > current.version) {
            latest.set(entry.artifact_type, entry);
          }
        }
        const bodies = await Promise.all(
          [...latest.values()].map(async (entry) => {
            if (heldArtifact(entry.artifact_type, entry.version)) {
              return {
                artifact_type: entry.artifact_type,
                version: entry.version,
                status: 'in_prompt',
                note: 'your prompt carries this version whole, in an `artifact` block; it is not sent again',
              };
            }
            const body = await findArtifactBody(database, entry.id);
            if (!body.found) {
              return {
                artifact_type: entry.artifact_type,
                version: entry.version,
                status: 'refused',
                reason: 'the artifact row is gone',
              };
            }
            if (!body.redacted) {
              return {
                artifact_type: entry.artifact_type,
                version: entry.version,
                status: 'refused',
                reason: `stored at ${body.createdAt}, before artifacts were redacted at the write, so it is not served`,
              };
            }
            // No `url` (backlog 474): an `/api/…` path is one no agent tool can reach.
            return {
              artifact_type: entry.artifact_type,
              version: entry.version,
              status: 'ok',
              data: orderArtifactData(entry.artifact_type, body.body.data),
              markdown: body.body.markdown,
            };
          }),
        );
        return { status: 'ok', latest_per_type: bodies };
      }
      case 'feedback': {
        const rows = await listReturnFeedback(database, scope.taskId);
        const verdicts =
          rows.length === 0 ? [] : await listVerdictsByAttempt(database, scope.taskId);
        const kinds = rows.length === 0 ? new Map() : await findStageKinds(database, scope.taskId);
        return {
          status: 'ok',
          returns: rows.map((row) => ({
            stage: row.stage,
            attempt: row.attempt,
            returned_to: row.returnedTo,
            reason: row.reason,
            at: iso(row.exitedAt),
            cause: returnCauseOf(row, verdicts, kinds),
          })),
        };
      }
      case 'mr':
        return detail.task.mr_ref === null
          ? refused('this task has no merge request yet')
          : { status: 'ok', mr_ref: detail.task.mr_ref, branch: detail.task.branch };
      case 'ci':
        return detail.task.coverage === null
          ? refused(
              'no CI result is recorded for this task: the platform stores the coverage a pipeline reported and none has been, and pipeline runs themselves are not projected per task',
            )
          : { status: 'ok', coverage: detail.task.coverage };
      case 'runs': {
        const newestFirst = [...detail.runs].reverse();
        return {
          status: 'ok',
          total: newestFirst.length,
          truncated: newestFirst.length > TASK_CONTEXT_RUN_LIMIT,
          runs: newestFirst
            .slice(0, TASK_CONTEXT_RUN_LIMIT)
            .map((run) => runForAgents(run as unknown as Record<string, unknown>)),
        };
      }
      case 'audit': {
        const rows = await listTaskAudit(database, scope.taskId, TASK_CONTEXT_AUDIT_LIMIT + 1);
        return {
          status: 'ok',
          truncated: rows.length > TASK_CONTEXT_AUDIT_LIMIT,
          actions: rows.slice(0, TASK_CONTEXT_AUDIT_LIMIT).map((row) => ({
            id: row.id,
            action: row.action,
            by_user_id: row.userId,
            params: row.params as JsonObject,
            at: row.createdAt.toISOString(),
          })),
        };
      }
    }
  };

  const values = [...new Set(include)];
  // Read every section first, so the shares can follow their sizes (backlog 474).
  const read: Partial<Record<TaskContextInclude, TaskContextSection>> = {};
  for (const value of values) {
    read[value] = await section(value);
  }
  const shares = taskContextShares(
    values,
    Object.fromEntries(values.map((value) => [value, sizeOf(read[value])])),
  );
  const sections: Partial<Record<TaskContextInclude, TaskContextSection>> = {};
  for (const value of values) {
    sections[value] = boundTaskContextSection(
      value,
      read[value] as TaskContextSection,
      shares[value] ?? 0,
    );
  }
  return { task_id: detail.task.id, project_id: detail.task.project_id, sections };
};
