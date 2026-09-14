/**
 * TanStack Query hooks, one per endpoint (technical/09 § "Real-time state").
 *
 * `staleTime: Infinity` on everything, deliberately: this app does not poll. The stream is the
 * invalidation signal (`realtime/query-bridge.ts`), and a background refetch interval on top of it
 * would hide a broken stream behind data that happens to be fresh — the failure that is hardest to
 * notice and worst to debug. If the stream is down, the connection badge in the header says so.
 */
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/keys.js';
import type { SessionResponse } from '../auth/session.js';
import type { MintKey } from './idempotency.js';
import { useIntentKeys } from './idempotency.js';
import { useServices } from './services.js';

const FOREVER = { staleTime: Number.POSITIVE_INFINITY, gcTime: 5 * 60_000 } as const;

export const useSession = (): UseQueryResult<SessionResponse> => {
  const { auth } = useServices();
  return useQuery({
    queryKey: [...queryKeys.session],
    queryFn: () => auth.getSession(),
    ...FOREVER,
    // A 401 is an answer, not a failure worth retrying.
    retry: false,
  });
};

export const useVersion = () => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.version],
    queryFn: () => endpoints.version(),
    ...FOREVER,
  });
};

export const useProjects = () => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.projects],
    queryFn: () => endpoints.projects(),
    ...FOREVER,
  });
};

/**
 * Resolves the `$key` in the URL to the project it names.
 *
 * technical/09 fixes the route as `/projects/$key` — the human-readable slug, which is what someone
 * pastes into Slack — while every API path is keyed by uuid. The projects list is the mapping, and
 * it is one small request the shell needs anyway.
 */
export const useProjectByKey = (key: string) => {
  const projects = useProjects();
  const project = projects.data?.items.find((item) => item.key === key) ?? null;
  return { ...projects, project };
};

export const useProjectTasks = (projectId: string | null, state?: string) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.projectTasks(projectId ?? '', state === undefined ? {} : { state }),
    queryFn: () => endpoints.projectTasks(projectId ?? '', state === undefined ? {} : { state }),
    enabled: projectId !== null,
    ...FOREVER,
  });
};

export const useProjectConfig = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.projectConfig(projectId ?? ''),
    queryFn: () => endpoints.projectConfig(projectId ?? ''),
    enabled: projectId !== null,
    ...FOREVER,
  });
};

/** `GET /api/projects/:id/readiness` — 409 until a discovery run has evaluated the project. */
export const useProjectReadiness = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.projectReadiness(projectId ?? ''),
    queryFn: () => endpoints.projectReadiness(projectId ?? ''),
    enabled: projectId !== null,
    // A 409 is an answer, not a transport failure: retrying it would poll the server while an
    // operator reads the step that tells them to run discovery.
    retry: false,
    ...FOREVER,
  });
};

export const useProjectBindings = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.projectBindings(projectId ?? ''),
    queryFn: () => endpoints.projectBindings(projectId ?? ''),
    enabled: projectId !== null,
    ...FOREVER,
  });
};

export const useProjectBudgets = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.projectBudgets(projectId ?? ''),
    queryFn: () => endpoints.projectBudgets(projectId ?? ''),
    enabled: projectId !== null,
    ...FOREVER,
  });
};

/** `GET /api/projects/:id/autonomy` — the dial as it is in force, not as it is derived (WP-30). */
export const useProjectAutonomy = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.projectAutonomy(projectId ?? ''),
    queryFn: () => endpoints.projectAutonomy(projectId ?? ''),
    enabled: projectId !== null,
    ...FOREVER,
  });
};

/** `GET /api/projects/:id/audit` — who changed this project's settings (product/18:5). */
export const useProjectAudit = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.projectAudit(projectId ?? ''),
    queryFn: () => endpoints.projectAudit(projectId ?? ''),
    enabled: projectId !== null,
    ...FOREVER,
  });
};

export const useOrgBudgets = () => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.orgBudgets],
    queryFn: () => endpoints.orgBudgets(),
    ...FOREVER,
  });
};

export const useKbTree = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.kbTree(projectId ?? ''),
    queryFn: () => endpoints.kbTree(projectId ?? ''),
    enabled: projectId !== null,
    ...FOREVER,
  });
};

export const useKbDoc = (projectId: string | null, path: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.kbDoc(projectId ?? '', path ?? ''),
    queryFn: () => endpoints.kbDoc(projectId ?? '', path ?? ''),
    enabled: projectId !== null && path !== null,
    ...FOREVER,
  });
};

export const useKbProposals = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.kbProposals(projectId ?? ''),
    queryFn: () => endpoints.kbProposals(projectId ?? ''),
    enabled: projectId !== null,
    ...FOREVER,
  });
};

export const useTask = (taskId: string) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => endpoints.task(taskId),
    ...FOREVER,
  });
};

/**
 * The ask-the-task thread for one task (WP-31, product/10:57).
 *
 * A query of its own rather than a field of `useTask`: an ask is answered by a run that takes a
 * minute, so the thread changes on its own schedule and the task screen should not re-read five
 * tables to see one new answer arrive.
 */
export const useTaskAsks = (taskId: string) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.taskAsks(taskId),
    queryFn: () => endpoints.taskAsks(taskId),
    ...FOREVER,
  });
};

/** This task's `human_actions` rows (WP-31 criterion 10, PROGRESS backlog 52). */
export const useTaskAudit = (taskId: string) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.taskAudit(taskId),
    queryFn: () => endpoints.taskAudit(taskId),
    ...FOREVER,
  });
};

export const useRun = (runId: string) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: () => endpoints.run(runId),
    ...FOREVER,
  });
};

export const useRunMessages = (runId: string) => {
  const { endpoints, transcripts } = useServices();
  return useQuery({
    queryKey: queryKeys.runMessages(runId),
    queryFn: async () => {
      const page = await endpoints.runMessages(runId, { limit: 1000 });
      // The page and the stream overlap by construction; `merge` is idempotent by `seq`.
      transcripts.merge(runId, page.items);
      return page;
    },
    ...FOREVER,
  });
};

export const useRunPrompt = (runId: string, enabled: boolean) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.runPrompt(runId),
    queryFn: () => endpoints.runPrompt(runId),
    enabled,
    ...FOREVER,
  });
};

export const useRunContextPack = (runId: string, enabled: boolean) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.runContextPack(runId),
    queryFn: () => endpoints.runContextPack(runId),
    enabled,
    ...FOREVER,
  });
};

export const useAgents = () => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.agents],
    queryFn: () => endpoints.agents(),
    ...FOREVER,
  });
};

export const useInbox = () => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.inbox],
    queryFn: () => endpoints.inbox(),
    ...FOREVER,
  });
};

export const useOrgUsers = () => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.orgUsers],
    queryFn: () => endpoints.orgUsers(),
    ...FOREVER,
  });
};

export const useIntegrations = () => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.integrations],
    queryFn: () => endpoints.integrations(),
    ...FOREVER,
  });
};

export const useAudit = (filters: { readonly entity_type?: string; readonly cursor?: string }) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.audit(filters),
    queryFn: () => endpoints.orgAudit(filters),
    ...FOREVER,
  });
};

// ── Commands ─────────────────────────────────────────────────────────────────
//
// Every command invalidates what it could have changed. The stream will say the same thing a
// moment later; doing it here as well is what makes the button feel like it did something on an
// instance whose stream is down.

/**
 * Asking this task a question (WP-31).
 *
 * Its own hook rather than a member of {@link useTaskCommands}, because it is the only task command
 * whose server **requires** an `Idempotency-Key`: a repeat starts a second run the project pays for,
 * so the key is held per intent at the call site that owns it (`app/idempotency.ts`, backlog 53) and
 * released when the ask is recorded.
 */
export const useAskTask = (taskId: string, mint?: MintKey) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  const intents = useIntentKeys(mint);
  return useMutation({
    mutationFn: (question: string) =>
      endpoints.askTask(taskId, { question }, intents.keyFor(['task.ask', taskId, question])),
    onSuccess: async (_result, question) => {
      intents.release(['task.ask', taskId, question]);
      await queryClient.invalidateQueries({ queryKey: queryKeys.taskAsks(taskId) });
    },
  });
};

export const useTaskCommands = (taskId: string) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
    await queryClient.invalidateQueries({ queryKey: [...queryKeys.inbox] });
  };

  return {
    pause: useMutation({
      mutationFn: (reason: string) => endpoints.pauseTask(taskId, { reason }),
      onSuccess: invalidate,
    }),
    resume: useMutation({
      mutationFn: (reason: string) => endpoints.resumeTask(taskId, { reason }),
      onSuccess: invalidate,
    }),
    cancel: useMutation({
      mutationFn: (reason: string) => endpoints.cancelTask(taskId, { reason }),
      onSuccess: invalidate,
    }),
    answer: useMutation({
      mutationFn: (input: { questionId: string; answer: string }) =>
        endpoints.answerQuestion(taskId, input.questionId, { answer: input.answer }),
      onSuccess: invalidate,
    }),
    decide: useMutation({
      mutationFn: (input: {
        approvalId: string;
        decision: 'approve' | 'reject';
        reason?: string;
      }) =>
        endpoints.decideApproval(taskId, input.approvalId, {
          decision: input.decision,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }),
      onSuccess: invalidate,
    }),
    retryStage: useMutation({
      mutationFn: (input: { stage: string; reason?: string }) =>
        endpoints.retryStage(taskId, {
          stage: input.stage,
          ...(input.reason === undefined || input.reason === '' ? {} : { reason: input.reason }),
        }),
      onSuccess: invalidate,
    }),
    returnToStage: useMutation({
      mutationFn: (input: { stage: string; reason: string }) =>
        endpoints.returnToStage(taskId, { stage: input.stage, reason: input.reason }),
      onSuccess: invalidate,
    }),
    rework: useMutation({
      mutationFn: (input: { stage: string; instructions: string }) =>
        endpoints.reworkStage(taskId, {
          stage: input.stage,
          instructions: input.instructions,
        }),
      onSuccess: invalidate,
    }),
    feedback: useMutation({
      mutationFn: (input: {
        scope: 'task' | 'stage' | 'artifact' | 'project';
        text: string;
        rating?: number;
        stage?: string;
        artifactId?: string;
      }) =>
        endpoints.submitFeedback(taskId, {
          scope: input.scope,
          text: input.text,
          ...(input.rating === undefined ? {} : { rating: input.rating }),
          ...(input.stage === undefined ? {} : { stage: input.stage }),
          ...(input.artifactId === undefined ? {} : { artifact_id: input.artifactId }),
        }),
      onSuccess: invalidate,
    }),
  };
};

export const useRunCommands = (runId: string) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
  return {
    steer: useMutation({
      mutationFn: (message: string) => endpoints.steerRun(runId, { message }),
      onSuccess: invalidate,
    }),
    cancel: useMutation({
      mutationFn: (reason: string) => endpoints.cancelRun(runId, { reason }),
      onSuccess: invalidate,
    }),
    /**
     * Retry with a different model or effort. The command **creates a new run**, so the task is
     * invalidated as well as this run — the run list on the task screen is where the new attempt
     * appears, and this run's own record does not change at all.
     */
    retry: useMutation({
      mutationFn: (input: { taskId: string; model?: string; effort?: 'low' | 'medium' | 'high' }) =>
        endpoints.retryRun(runId, {
          ...(input.model === undefined || input.model === '' ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
        }),
      onSuccess: async (_result, input) => {
        await invalidate();
        await queryClient.invalidateQueries({ queryKey: queryKeys.task(input.taskId) });
      },
    }),
    /**
     * Feedback on this run's stage. The route is the **task's** (`POST /api/tasks/:id/feedback`,
     * technical/08): feedback is scoped to a stage or a project, never to a run, because a run is
     * one attempt at a stage and the retrospective reads the stage.
     */
    feedback: useMutation({
      mutationFn: (input: { taskId: string; stage: string; text: string; rating?: number }) =>
        endpoints.submitFeedback(input.taskId, {
          scope: 'stage',
          stage: input.stage,
          text: input.text,
          ...(input.rating === undefined ? {} : { rating: input.rating }),
        }),
      onSuccess: async (_result, input) => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.task(input.taskId) });
      },
    }),
  };
};

export const useKbProposalCommands = (projectId: string) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      proposalId: string;
      decision: 'approve' | 'reject' | 'edit';
      reason?: string;
    }) =>
      endpoints.decideKbProposal(projectId, input.proposalId, {
        decision: input.decision,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.kbProposals(projectId) }),
  });
};

/**
 * The onboarding wizard's commands (WP-21, product/06).
 *
 * One hook rather than six, so a screen that walks the steps holds one object and every mutation
 * invalidates what it could have changed — the projects list after a create, the integration list
 * after a create or a test, the bindings and the configuration after a write.
 */
export const useOnboardingCommands = (mint?: MintKey) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  /**
   * One `Idempotency-Key` per **intent** rather than per request (PROGRESS backlog 53).
   *
   * A double-clicked "Create project" used to send two first requests under two fresh keys, so the
   * server's replay answer — which has existed since WP-21 — was never given a key to answer. The
   * key is held here, at the call site that owns the user's intent, minted on the first send and
   * released when that intent succeeds (`app/idempotency.ts`).
   */
  const intents = useIntentKeys(mint);
  return {
    createProject: useMutation({
      mutationFn: (input: { key: string; name: string; repo_url: string }) =>
        endpoints.createProject(input, intents.keyFor(['project.create', input])),
      onSuccess: async (_result, input) => {
        intents.release(['project.create', input]);
        await queryClient.invalidateQueries({ queryKey: [...queryKeys.projects] });
      },
    }),
    createIntegration: useMutation({
      mutationFn: (input: {
        type: 'task_management' | 'git' | 'communication' | 'logs' | 'errors';
        provider: string;
        name: string;
        config: Record<string, unknown>;
        secret_refs: Record<string, string>;
      }) => endpoints.createIntegration(input, intents.keyFor(['integration.create', input])),
      onSuccess: async (_result, input) => {
        intents.release(['integration.create', input]);
        await queryClient.invalidateQueries({ queryKey: [...queryKeys.integrations] });
      },
    }),
    testIntegration: useMutation({
      mutationFn: (integrationId: string) => endpoints.testIntegration(integrationId),
      // The probe writes `integrations.health`, which the integration list publishes.
      onSuccess: () => queryClient.invalidateQueries({ queryKey: [...queryKeys.integrations] }),
    }),
    /**
     * The **whole** binding set, each with its own configuration.
     *
     * `config` is `bindings.config` — the project's overlay on the account's settings — and it is
     * sent per item rather than omitted, because `PUT …/bindings` replaces the set: a caller that
     * dropped it would erase the notification channel WP-32 stores there every time somebody
     * pressed "Save bindings" on another screen. Both call sites therefore send back what they
     * read; the notifications control is the one that changes a value.
     */
    putBindings: useMutation({
      mutationFn: (input: {
        projectId: string;
        items: readonly { integration_id: string; config?: Record<string, unknown> }[];
      }) =>
        endpoints.putProjectBindings(input.projectId, {
          items: input.items.map((item) => ({
            integration_id: item.integration_id,
            ...(item.config === undefined ? {} : { config: item.config }),
          })),
        }),
      onSuccess: async (_result, input) => {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.projectBindings(input.projectId),
        });
      },
    }),
    writeConfig: useMutation({
      /**
       * `autonomy_level` is **optional**, because a feature toggle is not a dial change.
       *
       * The endpoint has always accepted the document without one (`updateProjectConfigRequestSchema`
       * marks it optional and its docblock says why: a caller editing the pipeline limits should not
       * have to restate the dial). Sending the current level with every toggle would re-materialise
       * the preset on a write that did not touch it, which is the opposite of BD-027:14.
       */
      mutationFn: (input: {
        projectId: string;
        config: Record<string, unknown>;
        autonomy_level?: 'observe' | 'assist' | 'supervised' | 'autonomous';
        base_hash?: string;
      }) =>
        endpoints.updateProjectConfig(input.projectId, {
          config: input.config as never,
          ...(input.autonomy_level === undefined ? {} : { autonomy_level: input.autonomy_level }),
          ...(input.base_hash === undefined ? {} : { base_hash: input.base_hash }),
        }),
      onSuccess: async (_result, input) => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectConfig(input.projectId) });
        await queryClient.invalidateQueries({ queryKey: [...queryKeys.projects] });
      },
    }),
    startDiscovery: useMutation({
      mutationFn: (projectId: string) =>
        endpoints.startDiscovery(projectId, intents.keyFor(['discovery.run', projectId])),
      onSuccess: async (_result, projectId) => {
        intents.release(['discovery.run', projectId]);
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectReadiness(projectId) });
      },
    }),
  };
};

/**
 * The settings commands — the dial and BD-010's budgets (WP-30).
 *
 * Separate from {@link useOnboardingCommands} because they are a different permission (the dial is
 * `project.autonomy.write`, a budget is `budget.write`, the wizard's config write is admin) and
 * because the settings screens use them without the wizard. They share its `Idempotency-Key`
 * discipline: one key per intent, released on success.
 */
export const useSettingsCommands = (mint?: MintKey) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  const intents = useIntentKeys(mint);
  return {
    setAutonomy: useMutation({
      mutationFn: (input: {
        projectId: string;
        autonomy: 'observe' | 'assist' | 'supervised' | 'autonomous';
        override_reason?: string;
      }) =>
        endpoints.setProjectAutonomy(
          input.projectId,
          {
            autonomy: input.autonomy,
            ...(input.override_reason === undefined
              ? {}
              : { override_reason: input.override_reason }),
          },
          intents.keyFor(['autonomy.write', input]),
        ),
      onSuccess: async (_result, input) => {
        intents.release(['autonomy.write', input]);
        // The dial, the project list's badge and the audit feed all move with one write.
        await queryClient.invalidateQueries({ queryKey: queryKeys.project(input.projectId) });
        await queryClient.invalidateQueries({ queryKey: [...queryKeys.projects] });
      },
    }),
    setProjectBudget: useMutation({
      mutationFn: (input: {
        projectId: string;
        window: 'day' | 'week' | 'month' | 'total';
        limit_usd: number | null;
      }) =>
        endpoints.putProjectBudget(
          input.projectId,
          { window: input.window, limit_usd: input.limit_usd },
          intents.keyFor(['budget.write', input]),
        ),
      onSuccess: async (_result, input) => {
        intents.release(['budget.write', input]);
        await queryClient.invalidateQueries({ queryKey: queryKeys.project(input.projectId) });
      },
    }),
    setOrgBudget: useMutation({
      mutationFn: (input: {
        window: 'day' | 'week' | 'month' | 'total';
        limit_usd: number | null;
      }) =>
        endpoints.putOrgBudget(
          { window: input.window, limit_usd: input.limit_usd },
          intents.keyFor(['org.budget.write', input]),
        ),
      onSuccess: async (_result, input) => {
        intents.release(['org.budget.write', input]);
        await queryClient.invalidateQueries({ queryKey: [...queryKeys.orgBudgets] });
      },
    }),
  };
};
