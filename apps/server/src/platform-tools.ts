/**
 * The production `PlatformToolPort` — technical/04's in-process MCP server named `platform`, as a
 * composition root finally builds it (WP-17, PROGRESS backlog 11).
 *
 * WP-12 defined the port and its nine methods, and `packages/infrastructure/src/runner/platform-mcp.ts`
 * has been ready to register them since; the only implementations in the tree were a test recorder
 * and WP-16's `createKbSearchTool`, *a function a composition root supplies*. Nothing supplied it,
 * so `kb_search` had no home and the retrieval layer was reachable by nothing a run sees. This file
 * is the home.
 *
 * ## Six tools are real and four are refusals, and that is deliberate
 *
 * `kb_search` is wired to the PostgreSQL knowledge store, and **`get_task_context`** — since WP-54
 * (PROGRESS backlog 83) — to the read projections (`queries/task-context-queries.ts`), scoped to the
 * run's own task and refusing, value by value, what the projections cannot answer. **`open_mr` and
 * `update_mr_description`** are real since WP-138 (`@platform/application`'s
 * `createMergeRequestTools`): `IntegrationActionExecutor` reached from inside a live run, which is
 * the no-transaction phase of `stage.execute` and so the *call* half of WP-15d's split by
 * construction. **`report_progress`** is real since PROGRESS backlog 496: the runner hands every
 * run's tools a progress door over its own transcript door (`PlatformToolContext.progress`), so the
 * row gets the run's `seq`, redactor and sink, and `reportProgressTool` bounds the words and answers
 * the model. **`get_conversation`** is real since WP-181: the run task's ticket and merge request
 * are read off its own `tasks` row (scoped to the run's project), and WP-180's reader answers them
 * through the executor — the same bounded, redacted entries the prompt's `conversation` blocks hold,
 * as JSON (`conversationToolAnswer`). The other four need collaborators this build does not have —
 * the Question aggregate's HTTP surface and a waiter for the human's answer, a channel bound to a
 * live run, and a ticket write from inside a run. Each is therefore a **named refusal**, exactly like
 * `unavailableClaudeRunner` beside it in `pipeline.ts`, and for the same reason: a null object that
 * returns `{}` is a tool the model believes it used.
 *
 * **The "no run exists at all" half of this paragraph is gone** (standing rule 83, the second time
 * in this file): WP-53 built TD-028's control plane, so a configured instance does run agents and
 * these tools are refused *to a live run*. Each refusal below now names its own reason, and none of
 * them is the transport any more. When one becomes an implementation it lands in the same place,
 * and the thing that will not have to change is the wiring.
 *
 * ## Why the port and not the MCP server
 *
 * `platform-mcp.ts` decides which of the ten a given run is *registered* with, from
 * `RunSpec.platformTools` — a role that may not open a merge request never sees the tool, so the
 * mutating action is absent rather than refused (BD-021). This file has no opinion about that: it
 * answers for whichever ones a run was given.
 */
import type {
  ConversationSubject,
  GetConversationInput,
  GetTaskContextInput,
  InjectedSecret,
  KbSearchInput,
  Logger,
  MergeRequestToolReader,
  OpenMrInput,
  PipelineIntegrationsPort,
  PlatformToolContext,
  PlatformToolName,
  PlatformToolPort,
  ReportProgressInput,
  TaskRepository,
  UnitOfWork,
  UpdateMrDescriptionInput,
} from '@platform/application';
import {
  ConversationReadError,
  conversationToolAnswer,
  createConversationReader,
  createKbSearchTool,
  createMergeRequestTools,
  reportProgressTool,
} from '@platform/application';
import type { Id, JsonValue, MergeRequestRef, TaskMode } from '@platform/contracts';
import { mergeRequestRefSchema } from '@platform/contracts';
import {
  db as dbAdapters,
  eventing as eventingAdapters,
  knowledge as knowledgeAdapters,
} from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { readTaskContext } from './queries/task-context-queries.js';

/**
 * Thrown by every platform tool this build cannot perform.
 *
 * **One short plain sentence** (PROGRESS backlog 476), because this message is what the model reads
 * back: on Autix it was a paragraph about aggregates, sinks and `TranscriptEvent` kinds, and agents
 * spent turns on it. What is missing, in the platform's terms, is {@link MISSING}'s and goes to the
 * run log (`missing`), never to the model. Since the same work package a run is not *given* a tool
 * this build refuses (`availablePlatformTools`, composed from {@link IMPLEMENTED_PLATFORM_TOOLS}), so
 * this is reached only by a composition that registers one anyway.
 */
export class PlatformToolUnavailableError extends Error {
  override readonly name = 'PlatformToolUnavailableError';
  readonly tool: PlatformToolName;
  /** What the build lacks, for the operator's log. */
  readonly missing: string;

  constructor(tool: PlatformToolName, missing: string) {
    super(
      `${JSON.stringify(tool)} is not available in this build. Continue without it, and say in your artifact what you would have used it for.`,
    );
    this.tool = tool;
    this.missing = missing;
  }
}

/**
 * What each unimplemented tool is waiting for.
 *
 * Written out per tool rather than as one message, because "not implemented" tells a human nothing
 * and this string reaches both the run log and the model's own context.
 */
const MISSING: Readonly<Record<Exclude<PlatformToolName, ImplementedTool>, string>> = {
  ask_human:
    'asking a human needs the Question aggregate bound to a run that can wait for the answer; nothing suspends a run on a question and nothing resumes it on an answer (BD-025’s unattended default is deny, which `agent.ts` composes)',
  notify_human:
    'notifications need a channel bound to a live run; the SSE hub carries the transcript a run produces and has no path back into one',
  add_ticket_comment:
    'every outbound provider call goes through IntegrationActionExecutor, which the pipeline reaches from its `pipeline.outbound` job (WP-15d); a ticket comment from inside a run is unbuilt',
  create_followup_ticket:
    'every outbound provider call goes through IntegrationActionExecutor (WP-15d); filing a ticket from inside a run is unbuilt',
};

/**
 * The tools this build actually performs — the list the production planners offer a run
 * (`run-planners.ts`, which fixes it since WP-181) and the one the tests hold this file to.
 */
export const IMPLEMENTED_PLATFORM_TOOLS = [
  'report_progress',
  'kb_search',
  'get_task_context',
  'open_mr',
  'update_mr_description',
  // WP-181: the run task's conversation, through WP-180's reader.
  'get_conversation',
] as const;

type ImplementedTool = (typeof IMPLEMENTED_PLATFORM_TOOLS)[number];

const refuse = (tool: Exclude<PlatformToolName, ImplementedTool>, logger: Logger) => {
  logger.warn(
    { tool, reason: MISSING[tool] },
    'an agent called a platform tool this build does not compose',
  );
  throw new PlatformToolUnavailableError(tool, MISSING[tool]);
};

export interface PlatformToolsOptions {
  readonly pool: pg.Pool;
  readonly logger: Logger;
  /**
   * What `get_conversation` reads through (WP-181): the process's integrations port. The reader is
   * built **here**, by the factory the stage planner's `conversation` blocks use
   * (`createConversationReader`), so the tool and the blocks are one read of one shape — and so the
   * wiring is inside what `platform-tools.test.ts` drives through the MCP registration over the fake
   * tracker and git (review round 1: a reader injected from `pipeline.ts` was a seam no test saw).
   */
  readonly conversation: { readonly integrations: PipelineIntegrationsPort };
  /** The developer's merge request (WP-138): the store's narrow writer, the executor's door. */
  readonly mergeRequests: {
    readonly unitOfWork: UnitOfWork;
    readonly tasks: Pick<TaskRepository, 'recordMergeRequest'>;
    readonly integrations: PipelineIntegrationsPort;
    /** The model credential a run is given (`agentRunEnvironment`), as named secrets (Q55). */
    readonly runScopedSecrets: () => readonly InjectedSecret[];
  };
}

/**
 * What `open_mr` reads about the run's task, in its own short transaction (WP-138): the task's
 * mode, ticket key, branch and merge request, the project's default branch and the requesting
 * person's name for BD-025 §4's footer.
 */
export const createMergeRequestToolReader = (): MergeRequestToolReader => ({
  read: async (tx, taskId) => {
    const { rows } = await eventingAdapters.postgresTransaction(tx).client.query<{
      id: Id;
      project_id: Id;
      mode: TaskMode;
      ticket_key: string;
      branch: string | null;
      mr_ref: MergeRequestRef | null;
      default_branch: string;
      requested_by: string | null;
    }>(
      `select t.id, t.project_id, t.mode, t.ticket_key, t.branch, t.mr_ref,
              p.default_branch, u.name as requested_by
         from tasks t
         join projects p on p.id = t.project_id
         left join users u on u.id = t.requested_by_user_id
        where t.id = $1`,
      [taskId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      taskId: row.id,
      projectId: row.project_id,
      mode: row.mode,
      ticketKey: row.ticket_key,
      branch: row.branch,
      mr: row.mr_ref === null ? null : mergeRequestRefSchema.parse(row.mr_ref),
      defaultBranch: row.default_branch,
      requestedBy: row.requested_by,
    };
  },
});

/**
 * What `get_conversation` reads about the run's task (WP-181): its ticket and its merge request, off
 * the task's own row — **scoped to the run's project**, so a task id of another project answers
 * nothing. One statement, so no transaction is needed for it to be one reading.
 */
export const readConversationSubject = async (
  pool: Pick<pg.Pool, 'query'>,
  context: Pick<PlatformToolContext, 'taskId' | 'projectId'>,
): Promise<ConversationSubject> => {
  const { rows } = await pool.query<{
    ticket_provider: string;
    ticket_key: string;
    ticket_url: string;
    ticket_id: string | null;
    mr_ref: unknown;
  }>(
    `select ticket_provider, ticket_key, ticket_url, ticket_id, mr_ref
       from tasks
      where id = $1 and project_id = $2`,
    [context.taskId, context.projectId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `get_conversation found no task ${context.taskId} in project ${context.projectId}: the run's own task is the only one it reads`,
    );
  }
  return {
    projectId: context.projectId,
    taskId: context.taskId,
    ticket: {
      provider: row.ticket_provider,
      key: row.ticket_key,
      url: row.ticket_url,
      ...(row.ticket_id === null ? {} : { id: row.ticket_id }),
    } as ConversationSubject['ticket'],
    mr: row.mr_ref === null ? null : mergeRequestRefSchema.parse(row.mr_ref),
  };
};

/** Thrown to the model when a provider read failed: one plain sentence (backlog 476). */
export class ConversationUnavailableError extends Error {
  override readonly name = 'ConversationUnavailableError';
}

const toolContextOf = (context: PlatformToolContext) => ({
  taskId: context.taskId,
  projectId: context.projectId,
  ...(context.redactor === undefined ? {} : { redactor: context.redactor }),
});

export const composePlatformTools = (options: PlatformToolsOptions): PlatformToolPort => {
  // Built, not connected: drizzle issues nothing until a query runs, so wiring stays query-free.
  const database = drizzle(options.pool, { schema: dbAdapters.schema });
  const kbSearch = createKbSearchTool({
    store: new knowledgeAdapters.PostgresKnowledgeStore(options.pool),
    logger: options.logger,
  });
  const readConversation = createConversationReader({
    integrations: options.conversation.integrations,
  });
  const mergeRequests = createMergeRequestTools({
    unitOfWork: options.mergeRequests.unitOfWork,
    reader: createMergeRequestToolReader(),
    tasks: options.mergeRequests.tasks,
    integrations: options.mergeRequests.integrations,
    runScopedSecrets: options.mergeRequests.runScopedSecrets,
    logger: options.logger,
  });
  return {
    /**
     * The run's own task, never one the model named (WP-181): the input schema is an empty object,
     * and the subject is read off the task row the runner's context names. A provider failure is
     * logged with its source and answered in one plain sentence — the prompt already carries the
     * conversation blocks, or says it does not.
     */
    getConversation: async (
      _input: GetConversationInput,
      context: PlatformToolContext,
    ): Promise<JsonValue> => {
      const subject = await readConversationSubject(options.pool, context);
      try {
        return conversationToolAnswer(await readConversation(subject)) as JsonValue;
      } catch (error) {
        if (!(error instanceof ConversationReadError)) {
          throw error;
        }
        options.logger.warn(
          {
            tool: 'get_conversation',
            task_id: context.taskId,
            run_id: context.runId,
            source: error.source,
            err: error,
          },
          'get_conversation could not read the conversation; the model was told to use its prompt’s blocks',
        );
        throw new ConversationUnavailableError(
          'The conversation could not be read just now. Use the conversation blocks in your prompt, and say in your artifact that the tool failed.',
        );
      }
    },
    kbSearch: async (input: KbSearchInput, context: PlatformToolContext): Promise<JsonValue> =>
      // The **run's** project, never one the model named: `PlatformToolContext` is built by the
      // runner from the `RunSpec`, and the tool's own input schema has no project field. A model
      // that could choose the project could read another project's vault.
      kbSearch(context.projectId, input),
    askHuman: async () => refuse('ask_human', options.logger),
    notifyHuman: async () => refuse('notify_human', options.logger),
    /**
     * The run's own progress door (backlog 496), never a run the model named: the runner puts it on
     * `PlatformToolContext`, and the tool's input has no run field.
     */
    reportProgress: async (input: ReportProgressInput, context: PlatformToolContext) =>
      reportProgressTool(input, context),
    /**
     * The run's own task and project, never ones the model named (WP-54): `PlatformToolContext`
     * is built by the runner from the `RunSpec` and the tool's input schema has neither field.
     */
    getTaskContext: async (
      input: GetTaskContextInput,
      context: PlatformToolContext,
    ): Promise<JsonValue> =>
      (await readTaskContext(
        database,
        input.include,
        { taskId: context.taskId, projectId: context.projectId },
        {
          // Backlog 474: what the run's prompt already holds whole is not sent again.
          ...(context.promptHolds === undefined ? {} : { promptHolds: context.promptHolds }),
          ...(input.artifact_types === undefined ? {} : { artifactTypes: input.artifact_types }),
        },
      )) as unknown as JsonValue,
    addTicketComment: async () => refuse('add_ticket_comment', options.logger),
    /**
     * The run's own task and project, never ones the model named (WP-138): the branch and the
     * target are the platform's, and a branch in the input is ignored by the tool.
     */
    openMergeRequest: async (input: OpenMrInput, context: PlatformToolContext) =>
      (await mergeRequests.open(
        {
          title: input.title,
          description: input.description,
          ...(input.draft === undefined ? {} : { draft: input.draft }),
        },
        toolContextOf(context),
      )) as JsonValue,
    updateMrDescription: async (input: UpdateMrDescriptionInput, context: PlatformToolContext) =>
      (await mergeRequests.updateDescription(
        { description: input.description },
        toolContextOf(context),
      )) as JsonValue,
    createFollowupTicket: async () => refuse('create_followup_ticket', options.logger),
  };
};
