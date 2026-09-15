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
 * - ~~`GET /api/org/stats`~~ **is here since WP-41**, which is the work package that answered Q45's
 *   statistics half: the DTO is `orgStatsResponseSchema` and the CSV is the same numbers in long
 *   form, on a path of its own (`/api/org/stats.csv`) so that neither answer has to publish the
 *   other's schema. The screen no longer ships as an empty state (standing rule 83: closing a gap
 *   falsifies the sentence that described it).
 * - `POST /api/tasks/:id/{take-over,hand-back}`. **The reason this list gave has been answered, and
 *   the remaining absence is a smaller one.** It used to read *"each command's whole value is in a
 *   response no schema publishes"*; WP-27 built both routes and published `takeOverResponseSchema`,
 *   which carries the branch, the session, the resume commands and what became of the workspace —
 *   so the objection that kept the buttons out is gone (standing rule 83: closing a gap falsifies
 *   the sentence that described it). What is left is the **screen**: a take-over control needs
 *   somewhere to render those four things and a hand-back control needs a stage picker, which is a
 *   UI row rather than a client function. `apps/server/src/routes/client-census.test.ts` asserts
 *   both routes by hand for exactly this reason — a census driven by the client's calls cannot see
 *   an endpoint no screen calls.
 * - `POST /api/tasks/:id/ask` (WP-31). contracts publishes a *request* and technical/08 names the
 *   route, and the command's whole value is in a response no schema publishes: ask-the-task is a
 *   thread whose answers `taskDetailResponseSchema` has nowhere to carry. A button that fires the
 *   command and shows the operator nothing is worse than an absent one.
 */
import {
  agentsResponseSchema,
  answerQuestionRequestSchema,
  askTaskRequestSchema,
  askTaskResponseSchema,
  autonomyResponseSchema,
  budgetsResponseSchema,
  cancelRunRequestSchema,
  cancelTaskRequestSchema,
  contextPackRecordSchema,
  createIntegrationRequestSchema,
  createProjectRequestSchema,
  decideApprovalRequestSchema,
  decideKbProposalRequestSchema,
  effectiveConfigResponseSchema,
  historyBootstrapsResponseSchema,
  inboxResponseSchema,
  integrationsResponseSchema,
  kbDocResponseSchema,
  kbProposalsResponseSchema,
  kbTreeResponseSchema,
  orgAuditResponseSchema,
  orgStatsResponseSchema,
  orgUsersResponseSchema,
  pauseTaskRequestSchema,
  projectAuditResponseSchema,
  projectBindingsResponseSchema,
  projectRecordSchema,
  projectsResponseSchema,
  putBudgetsRequestSchema,
  putProjectBindingsRequestSchema,
  readinessResponseSchema,
  resumeTaskRequestSchema,
  retryRunRequestSchema,
  retryStageRequestSchema,
  returnToStageRequestSchema,
  reworkRequestSchema,
  runMessagesResponseSchema,
  runPromptResponseSchema,
  runRecordSchema,
  setAutonomyRequestSchema,
  setupGuideResponseSchema,
  shadowBatchesResponseSchema,
  shadowBatchResponseSchema,
  startDiscoveryResponseSchema,
  startHistoryBootstrapRequestSchema,
  startHistoryBootstrapResponseSchema,
  startShadowBatchRequestSchema,
  startShadowBatchResponseSchema,
  steerRunRequestSchema,
  submitFeedbackRequestSchema,
  taskAskListSchema,
  taskAuditPageSchema,
  taskDetailResponseSchema,
  tasksResponseSchema,
  testIntegrationResponseSchema,
  updateProjectConfigRequestSchema,
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
  /**
   * The organisation's delivery statistics (WP-41, product/16).
   *
   * `range` and `bucket` are omitted rather than defaulted here: the server's defaults are the
   * contract, and a second copy of them in the client is a second thing to drift.
   */
  readonly orgStats: (query?: {
    readonly range?: string;
    readonly bucket?: string;
    readonly project_id?: string;
  }) => Promise<z.output<typeof orgStatsResponseSchema>>;
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
  readonly orgBudgets: () => Promise<z.output<typeof budgetsResponseSchema>>;
  readonly projectAutonomy: (projectId: string) => Promise<z.output<typeof autonomyResponseSchema>>;
  readonly projectAudit: (
    projectId: string,
  ) => Promise<z.output<typeof projectAuditResponseSchema>>;
  /** WP-34, product/10:20 — the project's shadow batches and whether another may start. */
  readonly shadowBatches: (
    projectId: string,
  ) => Promise<z.output<typeof shadowBatchesResponseSchema>>;
  readonly shadowBatch: (batchId: string) => Promise<z.output<typeof shadowBatchResponseSchema>>;
  readonly startShadowBatch: (
    projectId: string,
    body: z.input<typeof startShadowBatchRequestSchema>,
    idempotencyKey: string,
  ) => Promise<z.output<typeof startShadowBatchResponseSchema>>;
  /** WP-35, product/06 step 3b — the batches, the gate and the estimate for a given N. */
  readonly historyBootstraps: (
    projectId: string,
    mergeRequests: number | null,
  ) => Promise<z.output<typeof historyBootstrapsResponseSchema>>;
  readonly startHistoryBootstrap: (
    projectId: string,
    body: z.input<typeof startHistoryBootstrapRequestSchema>,
    idempotencyKey: string,
  ) => Promise<z.output<typeof startHistoryBootstrapResponseSchema>>;
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
  readonly projectBindings: (
    projectId: string,
  ) => Promise<z.output<typeof projectBindingsResponseSchema>>;

  /**
   * The onboarding wizard's commands (WP-21, product/06).
   *
   * Unlike the task and run commands below, these **parse their answer**: technical/08 leaves a
   * command's response open, and these four fix one — the project that was created, the health of
   * an integration, the bindings that are now in force, the task a discovery run belongs to. A
   * wizard that could not read what it just made would have nothing to show the next step.
   */
  readonly createProject: (
    body: z.input<typeof createProjectRequestSchema>,
    /** The caller's intent key (`app/idempotency.ts`); omitted, a fresh one is minted per request. */
    idempotencyKey?: string,
  ) => Promise<z.output<typeof projectRecordSchema>>;
  readonly createIntegration: (
    body: z.input<typeof createIntegrationRequestSchema>,
    idempotencyKey?: string,
  ) => Promise<{ readonly id: string; readonly provider: string; readonly name: string }>;
  readonly testIntegration: (
    integrationId: string,
  ) => Promise<z.output<typeof testIntegrationResponseSchema>>;
  readonly putProjectBindings: (
    projectId: string,
    body: z.input<typeof putProjectBindingsRequestSchema>,
  ) => Promise<z.output<typeof projectBindingsResponseSchema>>;
  readonly updateProjectConfig: (
    projectId: string,
    body: z.input<typeof updateProjectConfigRequestSchema>,
  ) => Promise<{ readonly hash: string; readonly autonomy_level: string }>;
  readonly startDiscovery: (
    projectId: string,
    idempotencyKey?: string,
  ) => Promise<z.output<typeof startDiscoveryResponseSchema>>;

  /**
   * The settings commands (WP-30). Each takes the caller's `Idempotency-Key` — the key belongs to
   * the user's *intent* and only the call site that owns the intent knows when one ends
   * (`app/idempotency.ts`, PROGRESS backlog 53).
   */
  readonly setProjectAutonomy: (
    projectId: string,
    body: z.input<typeof setAutonomyRequestSchema>,
    idempotencyKey: string,
  ) => Promise<void>;
  readonly putProjectBudget: (
    projectId: string,
    body: z.input<typeof putBudgetsRequestSchema>,
    idempotencyKey: string,
  ) => Promise<void>;
  readonly putOrgBudget: (
    body: z.input<typeof putBudgetsRequestSchema>,
    idempotencyKey: string,
  ) => Promise<void>;

  // Commands (technical/08 § Principles: imperative names, audited).
  /** The ask-the-task thread and the task's own audit trail (WP-31, product/10:57). */
  readonly taskAsks: (taskId: string) => Promise<z.output<typeof taskAskListSchema>>;
  readonly taskAudit: (taskId: string) => Promise<z.output<typeof taskAuditPageSchema>>;
  /**
   * Ask this task a question. Carries the caller's `Idempotency-Key` because the server requires
   * one: a repeat would start a second run the project pays for.
   */
  readonly askTask: (
    taskId: string,
    body: z.input<typeof askTaskRequestSchema>,
    idempotencyKey: string,
  ) => Promise<z.output<typeof askTaskResponseSchema>>;
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
    orgStats: (query) =>
      client.get('/api/org/stats', { schema: orgStatsResponseSchema, query: { ...query } }),
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
    orgBudgets: () => client.get('/api/org/budgets', { schema: budgetsResponseSchema }),
    projectAutonomy: (projectId) =>
      client.get(`/api/projects/${seg(projectId)}/autonomy`, { schema: autonomyResponseSchema }),
    projectAudit: (projectId) =>
      client.get(`/api/projects/${seg(projectId)}/audit`, { schema: projectAuditResponseSchema }),
    shadowBatches: (projectId) =>
      client.get(`/api/projects/${seg(projectId)}/shadow-batches`, {
        schema: shadowBatchesResponseSchema,
      }),
    shadowBatch: (batchId) =>
      client.get(`/api/shadow-batches/${seg(batchId)}`, { schema: shadowBatchResponseSchema }),
    startShadowBatch: (projectId, body, idempotencyKey) =>
      client.command(`/api/projects/${seg(projectId)}/shadow-batches`, {
        method: 'POST',
        schema: startShadowBatchResponseSchema,
        body: startShadowBatchRequestSchema.parse(body),
        idempotencyKey,
      }),
    historyBootstraps: (projectId, mergeRequests) =>
      client.get(`/api/projects/${seg(projectId)}/history-bootstraps`, {
        schema: historyBootstrapsResponseSchema,
        ...(mergeRequests === null ? {} : { query: { merge_requests: String(mergeRequests) } }),
      }),
    startHistoryBootstrap: (projectId, body, idempotencyKey) =>
      client.command(`/api/projects/${seg(projectId)}/history-bootstraps`, {
        method: 'POST',
        schema: startHistoryBootstrapResponseSchema,
        body: startHistoryBootstrapRequestSchema.parse(body),
        idempotencyKey,
      }),
    projectTasks: (projectId, query) =>
      client.get(`/api/projects/${seg(projectId)}/tasks`, {
        schema: tasksResponseSchema,
        query: { ...query },
      }),

    task: (taskId) => client.get(`/api/tasks/${seg(taskId)}`, { schema: taskDetailResponseSchema }),
    taskAsks: (taskId) =>
      client.get(`/api/tasks/${seg(taskId)}/asks`, { schema: taskAskListSchema }),
    taskAudit: (taskId) =>
      client.get(`/api/tasks/${seg(taskId)}/audit`, { schema: taskAuditPageSchema }),
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
    projectBindings: (projectId) =>
      client.get(`/api/projects/${seg(projectId)}/bindings`, {
        schema: projectBindingsResponseSchema,
      }),

    // The wizard's commands. The three that **create** carry an `Idempotency-Key` (technical/08 §
    // Principles); a double-clicked "Create project" that made two projects is the failure the
    // header exists for, and the server refuses the request without one.
    createProject: (body, idempotencyKey) =>
      client.command('/api/projects', {
        schema: projectRecordSchema,
        body: createProjectRequestSchema.parse(body),
        idempotent: true,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }),
    createIntegration: (body, idempotencyKey) =>
      client.command('/api/integrations', {
        schema: z.object({ id: z.string(), provider: z.string(), name: z.string() }),
        body: createIntegrationRequestSchema.parse(body),
        idempotent: true,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }),
    testIntegration: (integrationId) =>
      client.command(`/api/integrations/${seg(integrationId)}/test`, {
        schema: testIntegrationResponseSchema,
        body: {},
      }),
    putProjectBindings: (projectId, body) =>
      client.command(`/api/projects/${seg(projectId)}/bindings`, {
        method: 'PUT',
        schema: projectBindingsResponseSchema,
        body: putProjectBindingsRequestSchema.parse(body),
      }),
    updateProjectConfig: (projectId, body) =>
      client.command(`/api/projects/${seg(projectId)}/config`, {
        method: 'PUT',
        schema: z.object({ hash: z.string(), autonomy_level: z.string() }),
        body: updateProjectConfigRequestSchema.parse(body),
      }),
    startDiscovery: (projectId, idempotencyKey) =>
      client.command(`/api/projects/${seg(projectId)}/discovery`, {
        schema: startDiscoveryResponseSchema,
        body: {},
        idempotent: true,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }),

    setProjectAutonomy: async (projectId, body, idempotencyKey) => {
      await client.command(`/api/projects/${seg(projectId)}/autonomy`, {
        method: 'PUT',
        schema: acknowledgedSchema,
        body: setAutonomyRequestSchema.parse(body),
        idempotencyKey,
      });
    },
    putProjectBudget: async (projectId, body, idempotencyKey) => {
      await client.command(`/api/projects/${seg(projectId)}/budgets`, {
        method: 'PUT',
        schema: acknowledgedSchema,
        body: putBudgetsRequestSchema.parse(body),
        idempotencyKey,
      });
    },
    putOrgBudget: async (body, idempotencyKey) => {
      await client.command('/api/org/budgets', {
        method: 'PUT',
        schema: acknowledgedSchema,
        body: putBudgetsRequestSchema.parse(body),
        idempotencyKey,
      });
    },

    askTask: (taskId, body, idempotencyKey) =>
      client.command(`/api/tasks/${seg(taskId)}/ask`, {
        schema: askTaskResponseSchema,
        body: askTaskRequestSchema.parse(body),
        idempotent: true,
        idempotencyKey,
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
