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
 * ## One tool is real and eight are refusals, and that is deliberate
 *
 * `kb_search` is wired to the PostgreSQL knowledge store. The other eight need collaborators this
 * build does not have — the Question aggregate's HTTP surface and a waiter for the human's answer,
 * the task read model, and `IntegrationActionExecutor` reached from inside a live run rather than from
 * the `pipeline.outbound` job (WP-15d). Each is therefore a **named refusal**, exactly like
 * `unavailableClaudeRunner` beside it in `pipeline.ts`, and for the same reason: a null object that
 * returns `{}` is a tool the model believes it used.
 *
 * **The transcript sink is no longer one of them** (WP-15g, and this correction is standing rule 83:
 * closing a gap falsifies the sentence nearest it). `createPostgresTranscriptSink` exists and
 * `agent.ts` composes it, so `report_progress` still refuses **for a different reason** — the sink is
 * reached by the *runner*, which writes what the SDK produced, and nothing routes a tool call into it;
 * a `report_progress` row is a `TranscriptEvent` kind the contract does not have. That is a decision
 * for whoever gives the progress feed a shape, not a missing adapter.
 *
 * A refusal is also the only honest state to be in while **no run exists at all** (Q52). When the
 * launcher transport lands, each of these becomes an implementation in the same place, and the
 * thing that will not have to change is the wiring.
 *
 * ## Why the port and not the MCP server
 *
 * `platform-mcp.ts` decides which of the nine a given run is *registered* with, from
 * `RunSpec.platformTools` — a role that may not open a merge request never sees the tool, so the
 * mutating action is absent rather than refused (BD-021). This file has no opinion about that: it
 * answers for whichever ones a run was given.
 */
import type {
  KbSearchInput,
  Logger,
  PlatformToolContext,
  PlatformToolName,
  PlatformToolPort,
} from '@platform/application';
import { createKbSearchTool } from '@platform/application';
import type { JsonValue } from '@platform/contracts';
import { knowledge as knowledgeAdapters } from '@platform/infrastructure';
import type pg from 'pg';

/** Thrown by every platform tool this build cannot perform. Names the tool and what is missing. */
export class PlatformToolUnavailableError extends Error {
  override readonly name = 'PlatformToolUnavailableError';
  readonly tool: PlatformToolName;

  constructor(tool: PlatformToolName, missing: string) {
    super(
      `the platform tool ${JSON.stringify(tool)} is not composed in this build: ${missing}. The run may continue without it; report in your artifact that you could not use it.`,
    );
    this.tool = tool;
  }
}

/**
 * What each unimplemented tool is waiting for.
 *
 * Written out per tool rather than as one message, because "not implemented" tells a human nothing
 * and this string reaches both the run log and the model's own context.
 */
const MISSING: Readonly<Record<Exclude<PlatformToolName, 'kb_search'>, string>> = {
  ask_human:
    'asking a human needs the Question aggregate bound to a run that can wait for the answer, which needs the launcher transport (Q52)',
  notify_human:
    'notifications need the SSE hub bound to a live run, which needs the launcher transport (Q52)',
  report_progress:
    'progress reporting writes a transcript row, and the run transcript sink now exists (WP-15g) — what is missing is a shape for it: the sink is the runner’s, it writes what the SDK produced, and `TranscriptEvent` has no kind for a tool-reported progress line',
  get_task_context:
    'the task read model is not exposed to a run yet; the prompt already carries the ticket, the artifacts and the return feedback as delimited data',
  add_ticket_comment:
    'every outbound provider call goes through IntegrationActionExecutor, which the pipeline reaches from its `pipeline.outbound` job (WP-15d); reaching it from inside a run is unbuilt',
  open_mr:
    'every outbound provider call goes through IntegrationActionExecutor (WP-15d); opening a merge request from inside a run is unbuilt',
  update_mr_description:
    'every outbound provider call goes through IntegrationActionExecutor (WP-15d); updating a merge request from inside a run is unbuilt',
  create_followup_ticket:
    'every outbound provider call goes through IntegrationActionExecutor (WP-15d); filing a ticket from inside a run is unbuilt',
};

/** The tools this build actually performs. Read by the composition test, not by the runtime. */
export const IMPLEMENTED_PLATFORM_TOOLS: readonly PlatformToolName[] = ['kb_search'];

const refuse = (tool: Exclude<PlatformToolName, 'kb_search'>, logger: Logger) => {
  logger.warn(
    { tool, reason: MISSING[tool] },
    'an agent called a platform tool this build does not compose',
  );
  throw new PlatformToolUnavailableError(tool, MISSING[tool]);
};

export interface PlatformToolsOptions {
  readonly pool: pg.Pool;
  readonly logger: Logger;
}

export const composePlatformTools = (options: PlatformToolsOptions): PlatformToolPort => {
  const kbSearch = createKbSearchTool({
    store: new knowledgeAdapters.PostgresKnowledgeStore(options.pool),
    logger: options.logger,
  });
  return {
    kbSearch: async (input: KbSearchInput, context: PlatformToolContext): Promise<JsonValue> =>
      // The **run's** project, never one the model named: `PlatformToolContext` is built by the
      // runner from the `RunSpec`, and the tool's own input schema has no project field. A model
      // that could choose the project could read another project's vault.
      kbSearch(context.projectId, input),
    askHuman: async () => refuse('ask_human', options.logger),
    notifyHuman: async () => refuse('notify_human', options.logger),
    reportProgress: async () => refuse('report_progress', options.logger),
    getTaskContext: async () => refuse('get_task_context', options.logger),
    addTicketComment: async () => refuse('add_ticket_comment', options.logger),
    openMergeRequest: async () => refuse('open_mr', options.logger),
    updateMrDescription: async () => refuse('update_mr_description', options.logger),
    createFollowupTicket: async () => refuse('create_followup_ticket', options.logger),
  };
};
