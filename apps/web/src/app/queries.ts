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

export const useProjectBudgets = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.projectBudgets(projectId ?? ''),
    queryFn: () => endpoints.projectBudgets(projectId ?? ''),
    enabled: projectId !== null,
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
