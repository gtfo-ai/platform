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
 * | `feedback` | `task_stages` rows with `state = 'returned'`: the stage, its target (`returned_to`) and the reason — escalations excluded (WP-55) | never; an empty list is an answer |
 * | `mr` | `tasks.mr_ref` and `tasks.branch` | the task has no merge request yet |
 * | `ci` | `tasks.coverage` — the one per-task CI figure the platform stores | no coverage was recorded; pipeline runs themselves are **not** projected per task |
 * | `runs` | `findTaskDetail`'s runs, newest {@link TASK_CONTEXT_RUN_LIMIT} | never |
 * | `audit` | `human_actions` for this task, newest {@link TASK_CONTEXT_AUDIT_LIMIT} | never |
 *
 * `ci` is narrow on purpose: `ci.pipeline.finished` is stored on the **project** stream and its
 * `task_id` is often absent (the gate resolves a pipeline to a task by merge request when it reads
 * it), so a per-task list of pipelines would be a second resolution of that join written here.
 */
import type { Id, JsonObject, TicketSnapshot } from '@platform/contracts';
import { isPromptExcludedArtifact } from '@platform/domain';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { type Database, findArtifactBody, findTaskDetail } from './pipeline-queries.js';

const { humanActions, taskStages, tasks } = dbAdapters.schema;

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
      reason: `does not fit this call's share (${String(sizeOf(item))} characters); read it at ${String(item['url'])}`,
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
 */
export const taskContextShares = (
  values: readonly TaskContextInclude[],
): Readonly<Partial<Record<TaskContextInclude, number>>> => {
  const equal = Math.floor(TASK_CONTEXT_MAX_CHARS / values.length);
  if (!values.includes('ticket') || values.length === 1) {
    return Object.fromEntries(values.map((value) => [value, equal]));
  }
  const ticket = Math.max(equal, TASK_CONTEXT_TICKET_SHARE);
  const rest = Math.floor((TASK_CONTEXT_MAX_CHARS - ticket) / (values.length - 1));
  return Object.fromEntries(values.map((value) => [value, value === 'ticket' ? ticket : rest]));
};

/** How many of the task's runs and audit rows one call returns — the ask's own bounds. */
export const TASK_CONTEXT_RUN_LIMIT = 50;
export const TASK_CONTEXT_AUDIT_LIMIT = 100;

export type TaskContextSection =
  | ({ readonly status: 'ok' } & Record<string, unknown>)
  | { readonly status: 'refused'; readonly reason: string };

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

/**
 * This task's `human_actions`, newest first, on the table's `(task_id, created_at desc)` index.
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
    .where(eq(humanActions.taskId, taskId))
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
): Promise<TaskContextAnswer> => {
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
          if (isPromptExcludedArtifact(entry.artifact_type)) {
            continue;
          }
          const current = latest.get(entry.artifact_type);
          if (current === undefined || entry.version > current.version) {
            latest.set(entry.artifact_type, entry);
          }
        }
        const bodies = await Promise.all(
          [...latest.values()].map(async (entry) => {
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
            return {
              artifact_type: entry.artifact_type,
              version: entry.version,
              status: 'ok',
              url: entry.url,
              data: body.body.data,
              markdown: body.body.markdown,
            };
          }),
        );
        return { status: 'ok', latest_per_type: bodies };
      }
      case 'feedback': {
        const rows = await listReturnFeedback(database, scope.taskId);
        return {
          status: 'ok',
          returns: rows.map((row) => ({
            stage: row.stage,
            attempt: row.attempt,
            returned_to: row.returnedTo,
            reason: row.reason,
            at: iso(row.exitedAt),
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
          runs: newestFirst.slice(0, TASK_CONTEXT_RUN_LIMIT),
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
  const shares = taskContextShares(values);
  const sections: Partial<Record<TaskContextInclude, TaskContextSection>> = {};
  for (const value of values) {
    sections[value] = boundTaskContextSection(value, await section(value), shares[value] ?? 0);
  }
  return { task_id: detail.task.id, project_id: detail.task.project_id, sections };
};
