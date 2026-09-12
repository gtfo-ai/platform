/**
 * Every endpoint of technical/08 this app talks to, as one function each.
 *
 * The response schema is always the one `@platform/contracts` publishes — including the three that
 * used to be composed here. `GET /api/projects`, `GET /api/projects/:id/tasks` and
 * `GET /api/integrations` had no published envelope while nothing served them, so this file built
 * one from the published item (`projectSummarySchema`, `taskRecordSchema`,
 * `integrationSummarySchema`); **Q45 said to move them into `packages/contracts` when the work
 * package that implements the route lands**, and WP-15h part 2 is that work package. The shapes are
 * byte-for-byte what was composed here, so nothing this client parses changed.
 *
 * **What is not here, and why.**
 *
 * - `GET /api/org/stats` has no DTO anywhere in contracts, so the statistics screen has nothing to
 *   parse and ships as an honest empty state rather than as a screen built on a shape this work
 *   package invented (Q45).
 * - `POST /api/tasks/:id/{take-over,hand-back}` and `POST /api/tasks/:id/ask`. contracts publishes
 *   a *request* for each and technical/08 names the routes, but each command's whole value is in a
 *   response no schema publishes: take-over must hand back the branch, the resume command and the
 *   workspace export (product/10), hand-back is its other half, and ask-the-task is a thread whose
 *   answers `taskDetailResponseSchema` has nowhere to carry. A button that fires the command and
 *   shows the operator none of that is worse than an absent one, and the plan already owns them —
 *   WP-27 for take-over/hand-back, WP-31 for ask. Named in the screens' docblocks as gaps, the way
 *   the Checks panel names its own.
 */
import {
  agentsResponseSchema,
  answerQuestionRequestSchema,
  budgetsResponseSchema,
  cancelRunRequestSchema,
  cancelTaskRequestSchema,
  contextPackRecordSchema,
  decideApprovalRequestSchema,
  decideKbProposalRequestSchema,
  effectiveConfigResponseSchema,
  inboxResponseSchema,
  integrationsResponseSchema,
  kbDocResponseSchema,
  kbProposalsResponseSchema,
  kbTreeResponseSchema,
  orgAuditResponseSchema,
  orgUsersResponseSchema,
  pauseTaskRequestSchema,
  projectsResponseSchema,
  readinessResponseSchema,
  resumeTaskRequestSchema,
  retryRunRequestSchema,
  retryStageRequestSchema,
  returnToStageRequestSchema,
  reworkRequestSchema,
  runMessagesResponseSchema,
  runPromptResponseSchema,
  runRecordSchema,
  setupGuideResponseSchema,
  steerRunRequestSchema,
  submitFeedbackRequestSchema,
  taskDetailResponseSchema,
  tasksResponseSchema,
  versionResponseSchema,
} from '@platform/contracts';
import * as z from 'zod';
import type { ApiClient } from './http.js';

/**
 * Command responses.
 *
 * technical/08 fixes the *request* of every command and leaves the response open (some return the
 * updated resource, some an acknowledgement), so there is nothing to parse against and pretending
 * otherwise would reject a legal answer. The requests are parsed — see `command` below — because
 * those the contract does fix.
 */
const acknowledgedSchema = z.unknown();

export interface Endpoints {
  readonly version: () => Promise<z.output<typeof versionResponseSchema>>;
  readonly orgUsers: () => Promise<z.output<typeof orgUsersResponseSchema>>;
  readonly orgAudit: (query: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly entity_type?: string;
  }) => Promise<z.output<typeof orgAuditResponseSchema>>;
  readonly agents: () => Promise<z.output<typeof agentsResponseSchema>>;
  readonly inbox: () => Promise<z.output<typeof inboxResponseSchema>>;
  readonly integrations: () => Promise<z.output<typeof integrationsResponseSchema>>;
  readonly integrationSetupGuide: (
    integrationId: string,
  ) => Promise<z.output<typeof setupGuideResponseSchema>>;
  readonly projects: () => Promise<z.output<typeof projectsResponseSchema>>;
  readonly projectConfig: (
    projectId: string,
  ) => Promise<z.output<typeof effectiveConfigResponseSchema>>;
  readonly projectReadiness: (
    projectId: string,
  ) => Promise<z.output<typeof readinessResponseSchema>>;
  readonly projectBudgets: (projectId: string) => Promise<z.output<typeof budgetsResponseSchema>>;
  readonly projectTasks: (
    projectId: string,
    query?: { readonly state?: string; readonly limit?: number; readonly cursor?: string },
  ) => Promise<z.output<typeof tasksResponseSchema>>;
  readonly task: (taskId: string) => Promise<z.output<typeof taskDetailResponseSchema>>;
  readonly run: (runId: string) => Promise<z.output<typeof runRecordSchema>>;
  readonly runMessages: (
    runId: string,
    query?: { readonly after?: number; readonly limit?: number },
  ) => Promise<z.output<typeof runMessagesResponseSchema>>;
  readonly runPrompt: (runId: string) => Promise<z.output<typeof runPromptResponseSchema>>;
  readonly runContextPack: (runId: string) => Promise<z.output<typeof contextPackRecordSchema>>;
  readonly kbTree: (projectId: string) => Promise<z.output<typeof kbTreeResponseSchema>>;
  readonly kbDoc: (
    projectId: string,
    path: string,
  ) => Promise<z.output<typeof kbDocResponseSchema>>;
  readonly kbProposals: (projectId: string) => Promise<z.output<typeof kbProposalsResponseSchema>>;

  // Commands (technical/08 § Principles: imperative names, audited).
  readonly pauseTask: (
    taskId: string,
    body: z.input<typeof pauseTaskRequestSchema>,
  ) => Promise<void>;
  readonly resumeTask: (
    taskId: string,
    body: z.input<typeof resumeTaskRequestSchema>,
  ) => Promise<void>;
  readonly cancelTask: (
    taskId: string,
    body: z.input<typeof cancelTaskRequestSchema>,
  ) => Promise<void>;
  readonly answerQuestion: (
    taskId: string,
    questionId: string,
    body: z.input<typeof answerQuestionRequestSchema>,
  ) => Promise<void>;
  readonly decideApproval: (
    taskId: string,
    approvalId: string,
    body: z.input<typeof decideApprovalRequestSchema>,
  ) => Promise<void>;
  readonly retryStage: (
    taskId: string,
    body: z.input<typeof retryStageRequestSchema>,
  ) => Promise<void>;
  readonly returnToStage: (
    taskId: string,
    body: z.input<typeof returnToStageRequestSchema>,
  ) => Promise<void>;
  readonly reworkStage: (
    taskId: string,
    body: z.input<typeof reworkRequestSchema>,
  ) => Promise<void>;
  readonly submitFeedback: (
    taskId: string,
    body: z.input<typeof submitFeedbackRequestSchema>,
  ) => Promise<void>;
  readonly steerRun: (runId: string, body: z.input<typeof steerRunRequestSchema>) => Promise<void>;
  readonly retryRun: (runId: string, body: z.input<typeof retryRunRequestSchema>) => Promise<void>;
  readonly cancelRun: (
    runId: string,
    body: z.input<typeof cancelRunRequestSchema>,
  ) => Promise<void>;
  readonly decideKbProposal: (
    projectId: string,
    proposalId: string,
    body: z.input<typeof decideKbProposalRequestSchema>,
  ) => Promise<void>;
}

/** Encodes one path segment. A ticket key or a KB path is untrusted input (BD-022). */
const seg = (value: string): string => encodeURIComponent(value);

export const createEndpoints = (client: ApiClient): Endpoints => {
  /**
   * Sends a command, with its body parsed by the schema contracts publishes for it first.
   *
   * A request that does not match is a bug in this app, and finding it here — with the field name
   * — beats finding it as a 400 whose `details` the user is shown.
   */
  const command = async <TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    body: z.input<TSchema>,
    idempotent = false,
  ): Promise<void> => {
    await client.command(path, {
      schema: acknowledgedSchema,
      body: schema.parse(body) as unknown,
      idempotent,
    });
  };

  return {
    version: () => client.get('/api/version', { schema: versionResponseSchema }),
    orgUsers: () => client.get('/api/org/users', { schema: orgUsersResponseSchema }),
    orgAudit: (query) =>
      client.get('/api/org/audit', { schema: orgAuditResponseSchema, query: { ...query } }),
    agents: () => client.get('/api/org/agents', { schema: agentsResponseSchema }),
    inbox: () => client.get('/api/org/inbox', { schema: inboxResponseSchema }),
    integrations: () => client.get('/api/integrations', { schema: integrationsResponseSchema }),
    integrationSetupGuide: (integrationId) =>
      client.get(`/api/integrations/${seg(integrationId)}/setup-guide`, {
        schema: setupGuideResponseSchema,
      }),

    projects: () => client.get('/api/projects', { schema: projectsResponseSchema }),
    projectConfig: (projectId) =>
      client.get(`/api/projects/${seg(projectId)}/config`, {
        schema: effectiveConfigResponseSchema,
      }),
    projectReadiness: (projectId) =>
      client.get(`/api/projects/${seg(projectId)}/readiness`, { schema: readinessResponseSchema }),
    projectBudgets: (projectId) =>
      client.get(`/api/projects/${seg(projectId)}/budgets`, { schema: budgetsResponseSchema }),
    projectTasks: (projectId, query) =>
      client.get(`/api/projects/${seg(projectId)}/tasks`, {
        schema: tasksResponseSchema,
        query: { ...query },
      }),

    task: (taskId) => client.get(`/api/tasks/${seg(taskId)}`, { schema: taskDetailResponseSchema }),
    run: (runId) => client.get(`/api/runs/${seg(runId)}`, { schema: runRecordSchema }),
    runMessages: (runId, query) =>
      client.get(`/api/runs/${seg(runId)}/messages`, {
        schema: runMessagesResponseSchema,
        query: { ...query },
      }),
    runPrompt: (runId) =>
      client.get(`/api/runs/${seg(runId)}/prompt`, { schema: runPromptResponseSchema }),
    runContextPack: (runId) =>
      client.get(`/api/runs/${seg(runId)}/context-pack`, { schema: contextPackRecordSchema }),

    kbTree: (projectId) =>
      client.get(`/api/projects/${seg(projectId)}/kb/tree`, { schema: kbTreeResponseSchema }),
    kbDoc: (projectId, path) =>
      client.get(`/api/projects/${seg(projectId)}/kb/doc`, {
        schema: kbDocResponseSchema,
        query: { path },
      }),
    kbProposals: (projectId) =>
      client.get(`/api/projects/${seg(projectId)}/kb/proposals`, {
        schema: kbProposalsResponseSchema,
      }),

    pauseTask: (taskId, body) =>
      command(`/api/tasks/${seg(taskId)}/pause`, pauseTaskRequestSchema, body),
    resumeTask: (taskId, body) =>
      command(`/api/tasks/${seg(taskId)}/resume`, resumeTaskRequestSchema, body),
    cancelTask: (taskId, body) =>
      command(`/api/tasks/${seg(taskId)}/cancel`, cancelTaskRequestSchema, body),
    answerQuestion: (taskId, questionId, body) =>
      command(
        `/api/tasks/${seg(taskId)}/questions/${seg(questionId)}/answer`,
        answerQuestionRequestSchema,
        body,
        true,
      ),
    decideApproval: (taskId, approvalId, body) =>
      command(
        `/api/tasks/${seg(taskId)}/approvals/${seg(approvalId)}/decide`,
        decideApprovalRequestSchema,
        body,
        true,
      ),
    // The four commands below create work — a new attempt, a return, a rework, a feedback row —
    // so they carry an `Idempotency-Key` (technical/08 § Principles). A double-clicked Retry that
    // starts two runs is the failure the header exists for.
    retryStage: (taskId, body) =>
      command(`/api/tasks/${seg(taskId)}/retry-stage`, retryStageRequestSchema, body, true),
    returnToStage: (taskId, body) =>
      command(`/api/tasks/${seg(taskId)}/return-to-stage`, returnToStageRequestSchema, body, true),
    reworkStage: (taskId, body) =>
      command(`/api/tasks/${seg(taskId)}/rework`, reworkRequestSchema, body, true),
    submitFeedback: (taskId, body) =>
      command(`/api/tasks/${seg(taskId)}/feedback`, submitFeedbackRequestSchema, body, true),

    steerRun: (runId, body) =>
      command(`/api/runs/${seg(runId)}/steer`, steerRunRequestSchema, body, true),
    retryRun: (runId, body) =>
      command(`/api/runs/${seg(runId)}/retry`, retryRunRequestSchema, body, true),
    cancelRun: (runId, body) =>
      command(`/api/runs/${seg(runId)}/cancel`, cancelRunRequestSchema, body),

    // technical/08 spells this one as three paths — `.../proposals/:pid/{approve,reject,edit}` —
    // while contracts publishes a single body carrying the decision. Docs win (CLAUDE.md), so the
    // path comes from the decision and the published body is sent unchanged; a server that later
    // prefers one `/decide` endpoint changes one line here.
    decideKbProposal: (projectId, proposalId, body) =>
      command(
        `/api/projects/${seg(projectId)}/kb/proposals/${seg(proposalId)}/${seg(body.decision)}`,
        decideKbProposalRequestSchema,
        body,
        true,
      ),
  };
};
