/**
 * TanStack Query hooks, one per endpoint (technical/09 § "Real-time state").
 *
 * `staleTime: Infinity` on everything, deliberately: this app does not poll. The stream is the
 * invalidation signal (`realtime/query-bridge.ts`), and a background refetch interval on top of it
 * would hide a broken stream behind data that happens to be fresh — the failure that is hardest to
 * notice and worst to debug. If the stream is down, the connection badge in the header says so.
 */
import type { BusinessInterviewRequest } from '@platform/contracts';
import {
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError } from '../api/http.js';
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

/**
 * `GET /api/projects/:id/rediscovery` (WP-94) — the re-evaluate button's gate and its ceiling, from
 * the function the command decides with, so the button is off with the reason rather than a 409.
 */
export const useRediscoveryGate = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.rediscoveryGate(projectId ?? ''),
    queryFn: () => endpoints.rediscoveryGate(projectId ?? ''),
    enabled: projectId !== null,
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

/** `GET /api/projects/:id/shadow-batches` — the batches and whether another may start (WP-34). */
export const useShadowBatches = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.shadowBatches(projectId ?? ''),
    queryFn: () => endpoints.shadowBatches(projectId ?? ''),
    enabled: projectId !== null,
    ...FOREVER,
  });
};

/** `GET /api/shadow-batches/:id` — one batch's tickets and its computed aggregate (WP-34). */
export const useShadowBatch = (projectId: string | null, batchId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.shadowBatch(projectId ?? '', batchId ?? ''),
    queryFn: () => endpoints.shadowBatch(batchId ?? ''),
    enabled: projectId !== null && batchId !== null,
    ...FOREVER,
  });
};

/**
 * `POST /api/projects/:id/shadow-batches` (WP-34).
 *
 * The key is minted per **intent**, like every other command in this file: starting a batch creates
 * N tasks, so a double-click must not create 2N. `app/idempotency.ts` carries the argument.
 */
export const useShadowCommands = (mint?: MintKey) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  const intents = useIntentKeys(mint);
  return {
    startBatch: useMutation({
      mutationFn: (input: { projectId: string; ticket_keys: readonly string[] }) =>
        endpoints.startShadowBatch(
          input.projectId,
          { ticket_keys: [...input.ticket_keys] },
          intents.keyFor(['shadow.start', input]),
        ),
      onSuccess: async (_result, input) => {
        intents.release(['shadow.start', input]);
        await queryClient.invalidateQueries({ queryKey: queryKeys.project(input.projectId) });
      },
    }),
  };
};

/**
 * product/04's manual Start (WP-122): `POST /api/projects/:id/tasks` with a ticket key.
 *
 * One key per **intent** (`app/idempotency.ts`): a double-click must not record the match twice,
 * and a corrected key is a new intent. The answer names a recorded match, not a task — intake makes
 * the task — so the board's own read is invalidated and the project topic does the rest.
 */
export const useStartTask = (mint?: MintKey) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  const intents = useIntentKeys(mint);
  return useMutation({
    mutationFn: (input: { projectId: string; ticket_key: string }) =>
      endpoints.startTask(
        input.projectId,
        { ticket_key: input.ticket_key },
        intents.keyFor(['task.start', input]),
      ),
    onSuccess: async (_result, input) => {
      intents.release(['task.start', input]);
      await queryClient.invalidateQueries({ queryKey: queryKeys.project(input.projectId) });
    },
  });
};

/**
 * `GET /api/projects/:id/history-bootstraps` — the batches, the gate and the estimate (WP-35).
 *
 * `mergeRequests` is part of the query key, so moving the number re-asks the server for the
 * estimate rather than showing the previous one: product/06 step 3b's *"shows an estimated cost
 * before running"* is a figure about the batch the operator is about to start, and the arithmetic
 * is the server's (standing rule 9).
 */
export const useHistoryBootstraps = (projectId: string | null, mergeRequests: number | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.historyBootstraps(projectId ?? '', mergeRequests),
    queryFn: () => endpoints.historyBootstraps(projectId ?? '', mergeRequests),
    enabled: projectId !== null,
    ...FOREVER,
  });
};

/**
 * `POST /api/projects/:id/history-bootstraps` (WP-35).
 *
 * The key is minted per **intent**, like every other command in this file: starting a bootstrap
 * reads a project's whole merged history and spends a budget, so a double-click must not do it
 * twice. `app/idempotency.ts` carries the argument.
 */
export const useHistoryBootstrapCommands = (mint?: MintKey) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  const intents = useIntentKeys(mint);
  return {
    start: useMutation({
      mutationFn: (input: { projectId: string; merge_requests: number | null }) =>
        endpoints.startHistoryBootstrap(
          input.projectId,
          input.merge_requests === null ? {} : { merge_requests: input.merge_requests },
          intents.keyFor(['bootstrap.start', input]),
        ),
      onSuccess: async (_result, input) => {
        intents.release(['bootstrap.start', input]);
        await queryClient.invalidateQueries({ queryKey: queryKeys.project(input.projectId) });
      },
    }),
  };
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

/** `GET /api/org` — the organisation settings document (WP-93). */
export const useOrgSettings = () => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.orgSettings],
    queryFn: () => endpoints.orgSettings(),
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

/**
 * `GET /api/projects/:id/kb/health` (WP-95, PROGRESS backlog 37). `retry: false` for
 * `useProjectReadiness`'s reason: a 409 `kb_health_not_reported` is an answer — no pass has run
 * for this project yet — not a transport failure to poll through.
 */
export const useKbHealth = (projectId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.kbHealth(projectId ?? ''),
    queryFn: () => endpoints.kbHealth(projectId ?? ''),
    enabled: projectId !== null,
    retry: false,
    ...FOREVER,
  });
};

export const useTask = (taskId: string, enabled = true) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => endpoints.task(taskId),
    // `false` while a caller does not know the id yet — the run screen learns its task from the run.
    enabled,
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

/**
 * One artifact's body — WP-52, PROGRESS backlog 85.
 *
 * `enabled` is the disclosure on the task screen: the list shows every artifact and the body is
 * fetched only for the one a reader opened, which is why this is a query per artifact rather than a
 * field on `taskDetailResponseSchema`. `FOREVER` because an artifact version is immutable: a stage
 * re-run writes a new version and never overwrites one (technical/02's invariant).
 */
export const useArtifactBody = (taskId: string, artifactId: string | null) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.artifact(taskId, artifactId ?? 'none'),
    queryFn: () => endpoints.artifact(artifactId as string),
    enabled: artifactId !== null,
    // An answer from the server — the 409 `artifact_not_redacted` above all, and a 403 or a 404 —
    // is not retried: the body is immutable and the refusal is permanent, and since WP-46 the
    // Checks panel reads this query on every task page, where three retries were three seconds of
    // "reading…" in front of a refusal that had already arrived. A transport failure still is.
    retry: (failures, error) => !(error instanceof ApiError) && failures < 3,
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

/** `GET /api/runs/:id/settings` (WP-112): immutable once written, so read once per run. */
export const useRunSettings = (runId: string, enabled: boolean) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.runSettings(runId),
    queryFn: () => endpoints.runSettings(runId),
    enabled,
    ...FOREVER,
    // A run created before WP-91 answers `409 settings_not_recorded`, and that is an answer about
    // the row: asking again cannot change it, and the screen says it in words.
    retry: (failures, error) =>
      !(error instanceof ApiError && error.code === 'settings_not_recorded') && failures < 1,
  });
};

/** How often the run screen re-reads a command still waiting for the process holding the run. */
export const PENDING_RUN_COMMAND_POLL_MS = 3_000;

/**
 * `GET /api/runs/:id/commands` — every steer and take-over sent to this run and what became of it
 * (WP-85, TD-028 decision 9).
 *
 * A command is **accepted** by the process that answered and **applied or refused** by the process
 * holding the run, so the screen has to read the outcome rather than assume it. A refusal by the
 * run's ending arrives as the run's own domain event (which invalidates this key through the
 * `['run', id]` prefix); an application writes a transcript row, which the query bridge does not
 * route to Query — so while any command is still pending the read is repeated on a short interval,
 * and stops as soon as none is.
 */
export const useRunCommandLog = (runId: string) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.runCommandLog(runId),
    queryFn: () => endpoints.runCommandLog(runId),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.state === 'pending') === true
        ? PENDING_RUN_COMMAND_POLL_MS
        : false,
  });
};

/**
 * `GET /api/org/stats` — the delivery statistics (WP-41, product/16).
 *
 * `FOREVER` like every other read on this app: the SSE stream is the invalidation signal, and a
 * statistics screen that polled would hide a broken stream behind numbers that happen to be fresh.
 * Nothing invalidates this key today — no frame says *"a task was delivered"* — so the screen is
 * refreshed by a navigation or a reload, which is stated on it rather than implied.
 */
export const useOrgStats = (query: {
  readonly range?: string;
  readonly bucket?: string;
  readonly project_id?: string;
}) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.orgStats(query),
    queryFn: () => endpoints.orgStats(query),
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

/**
 * The provider-account mappings (WP-43). Admin-only on the server (`org.users.manage`), so a
 * non-admin gets a 403 and the section says so rather than drawing an empty list.
 */
export const useOrgIdentities = () => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.orgIdentities],
    queryFn: () => endpoints.orgIdentities(),
    // A 403 for a non-admin is an answer, not a transport failure worth asking twice.
    retry: false,
  });
};

/**
 * Accounts refused as `unmapped_identity` that nobody has mapped (WP-44, PROGRESS backlog 198) —
 * admin-only like the list beside them, and under its key prefix, so saving a mapping refreshes it.
 */
export const useIdentityCandidates = (enabled: boolean) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.identityCandidates],
    queryFn: () => endpoints.identityCandidates(),
    enabled,
    retry: false,
  });
};

/**
 * `GET /api/org/dead-letters` (WP-95, PROGRESS backlog 126): newest first, a page at a time — since
 * WP-114 (backlog 324) an infinite query that follows `next_cursor`, so *Show older* reaches the
 * oldest dead letter rather than stopping at the newest fifty. Admin-only on the server, so a
 * non-admin's 403 is an answer the section names — not retried, and not drawn as an empty list that
 * would read as "nothing is poisoned".
 */
export const useDeadLetters = () => {
  const { endpoints } = useServices();
  return useInfiniteQuery({
    queryKey: [...queryKeys.deadLetters],
    queryFn: ({ pageParam }) =>
      endpoints.deadLetters(pageParam === null ? {} : { cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
};

/**
 * `GET /api/org/failed-jobs` (WP-108, PROGRESS backlog 325): the jobs pg-boss gave up on, a page at
 * a time with *Show older* following `next_cursor` (WP-114, backlog 324). Admin-only like the dead
 * letters beside it, and not retried for the same reason.
 */
export const useFailedJobs = () => {
  const { endpoints } = useServices();
  return useInfiniteQuery({
    queryKey: [...queryKeys.failedJobs],
    queryFn: ({ pageParam }) =>
      endpoints.failedJobs(pageParam === null ? {} : { cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
};

/** One integration's refused or ignored deliveries, fetched when a reader opens them (WP-44). */
export const useRefusedDeliveries = (integrationId: string, enabled: boolean) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.refusedDeliveries(integrationId),
    queryFn: () => endpoints.refusedDeliveries(integrationId),
    enabled,
    retry: false,
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

/**
 * The integrations a **picker** may offer (WP-122, PROGRESS backlog 388): every live row, of one
 * type when the picker names one — never a retired one (WP-114), whose credential is destroyed and
 * whose bind, flag or write the server refuses `409 integration_retired`.
 *
 * One selector rather than a filter per screen: three pickers wrote `retired_at === null` by hand,
 * and a fourth that forgot it would offer a choice that answers 409. `integrations.tsx` keeps the
 * unfiltered read on purpose — it is the list that shows retired rows.
 */
export const bindableIntegrations = <
  T extends { readonly retired_at: string | null; readonly type: string },
>(
  items: readonly T[],
  type?: string,
): T[] =>
  items.filter(
    (integration) =>
      integration.retired_at === null && (type === undefined || integration.type === type),
  );

/** {@link useIntegrations} narrowed to what a picker may offer — {@link bindableIntegrations}. */
export const useBindableIntegrations = (type?: string) => {
  const integrations = useIntegrations();
  return {
    ...integrations,
    items: bindableIntegrations(integrations.data?.items ?? [], type),
  };
};

/**
 * The providers this build ships and each one's fields (WP-100) — build metadata, so it never goes
 * stale inside a session.
 */
export const useIntegrationProviders = () => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.integrationProviders],
    queryFn: () => endpoints.integrationProviders(),
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
    /**
     * WP-131 review round 1: raise this task's cap, then resume it through the existing resume
     * command — the raise moves no state, and a task paused for its budget waits for both.
     */
    raiseBudget: useMutation({
      mutationFn: async (capUsd: number) => {
        await endpoints.raiseTaskBudget(taskId, { cap_usd: capUsd });
        await endpoints.resumeTask(taskId, { reason: 'resumed after raising its cap' });
      },
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

/**
 * Take-over and hand-back (product/19 §19; WP-27's routes, WP-44's controls).
 *
 * Their own hook rather than members of {@link useTaskCommands}, because both carry the caller's
 * **per-intent** `Idempotency-Key` (`app/idempotency.ts`, backlog 53): the hand-back route requires
 * one — a hand-back creates a stage attempt and a run, so a double click would start two — and a
 * take-over's key makes a retried request answer from the attempt that performed it rather than
 * with the aggregate's refusal of a second one. Each key is released when its intent succeeds.
 */
export const useTakeOverCommands = (taskId: string, mint?: MintKey) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  const intents = useIntentKeys(mint);
  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
    await queryClient.invalidateQueries({ queryKey: [...queryKeys.inbox] });
  };
  return {
    takeOver: useMutation({
      mutationFn: (input: { tarball: boolean; reason?: string }) =>
        endpoints.takeOverTask(
          taskId,
          {
            tarball: input.tarball,
            ...(input.reason === undefined || input.reason === '' ? {} : { reason: input.reason }),
          },
          intents.keyFor(['task.take_over', taskId, input]),
        ),
      onSuccess: async (_result, input) => {
        intents.release(['task.take_over', taskId, input]);
        await invalidate();
      },
    }),
    handBack: useMutation({
      mutationFn: (input: { stage: string; summary: string }) =>
        endpoints.handBackTask(taskId, input, intents.keyFor(['task.hand_back', taskId, input])),
      onSuccess: async (_result, input) => {
        intents.release(['task.hand_back', taskId, input]);
        await invalidate();
      },
    }),
  };
};

/** The epic split's queue for one task (WP-40's route, WP-44's panel). */
export const useTaskBreakdown = (taskId: string, enabled: boolean) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: queryKeys.taskBreakdown(taskId),
    queryFn: () => endpoints.taskBreakdown(taskId),
    enabled,
    ...FOREVER,
  });
};

/**
 * Accept or reject some proposed children. The key is per **intent** — the decision, the reason and
 * the exact set of children — because the route requires one and a repeat would file a second set
 * of tickets in somebody else's tracker; a corrected selection is a new intent and a new key.
 */
export const useBreakdownDecision = (taskId: string, mint?: MintKey) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  const intents = useIntentKeys(mint);
  return useMutation({
    mutationFn: (input: {
      decision: 'accept' | 'reject';
      itemIds: readonly string[];
      reason?: string;
    }) => {
      const body = {
        decision: input.decision,
        item_ids: [...input.itemIds].sort(),
        ...(input.reason === undefined || input.reason === '' ? {} : { reason: input.reason }),
      };
      return endpoints.decideBreakdown(
        taskId,
        body,
        intents.keyFor(['task.breakdown.decide', taskId, body]),
      );
    },
    onSuccess: async (_result, input) => {
      intents.release([
        'task.breakdown.decide',
        taskId,
        {
          decision: input.decision,
          item_ids: [...input.itemIds].sort(),
          ...(input.reason === undefined || input.reason === '' ? {} : { reason: input.reason }),
        },
      ]);
      await queryClient.invalidateQueries({ queryKey: queryKeys.taskBreakdown(taskId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
    },
  });
};

export const useRunCommands = (runId: string) => {
  const { endpoints } = useServices();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
  return {
    // Accepted, not delivered (WP-85): the command log is what says whether the holder applied it.
    steer: useMutation({
      mutationFn: (message: string) => endpoints.steerRun(runId, { message }),
      onSuccess: async () => {
        await invalidate();
        await queryClient.invalidateQueries({ queryKey: queryKeys.runCommandLog(runId) });
      },
    }),
    // With a live lease the stop is recorded for the process holding the run (WP-101), so the run
    // still reads `running` and the command log is what says when it was applied.
    cancel: useMutation({
      mutationFn: (reason: string) => endpoints.cancelRun(runId, { reason }),
      onSuccess: async () => {
        await invalidate();
        await queryClient.invalidateQueries({ queryKey: queryKeys.runCommandLog(runId) });
      },
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
    /** The repair a `config_refusal` names (WP-100): it rewrites `config` and resets `health`. */
    patchIntegration: useMutation({
      mutationFn: (input: {
        integrationId: string;
        config: Record<string, unknown>;
        remove: readonly string[];
      }) =>
        endpoints.patchIntegration(input.integrationId, {
          config: input.config,
          ...(input.remove.length === 0 ? {} : { remove: [...input.remove] }),
        }),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: [...queryKeys.integrations] }),
    }),
    /**
     * Re-seal credentials (WP-114): field → the **name** of an environment variable the server
     * reads, never a value. One `Idempotency-Key` per intent, so a double-click is one re-seal.
     */
    resealIntegrationSecrets: useMutation({
      mutationFn: (input: { integrationId: string; secretRefs: Record<string, string> }) =>
        endpoints.resealIntegrationSecrets(
          input.integrationId,
          { secret_refs: input.secretRefs },
          intents.keyFor(['integration.secrets.write', input]),
        ),
      onSuccess: async (_result, input) => {
        intents.release(['integration.secrets.write', input]);
        await queryClient.invalidateQueries({ queryKey: [...queryKeys.integrations] });
      },
    }),
    /** Retire (WP-114): credentials destroyed, row kept and listed as retired. */
    retireIntegration: useMutation({
      mutationFn: (integrationId: string) => endpoints.retireIntegration(integrationId),
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
    /**
     * WP-63, Q94 (c): the button that stays. One key per intent — pressing it twice for the same
     * configuration is one export; the key is released on success, so a later press after a
     * settings change is a new one.
     */
    exportConfig: useMutation({
      mutationFn: (input: { projectId: string; base_hash?: string }) =>
        endpoints.exportProjectConfig(
          input.projectId,
          input.base_hash === undefined ? {} : { base_hash: input.base_hash },
          intents.keyFor(['config.export', input]),
        ),
      onSuccess: (_result, input) => {
        intents.release(['config.export', input]);
      },
    }),
    refreshConfig: useMutation({
      mutationFn: (projectId: string) => endpoints.refreshProjectConfig(projectId),
      onSuccess: async (_result, projectId) => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectConfig(projectId) });
      },
    }),
    startDiscovery: useMutation({
      mutationFn: (projectId: string) =>
        endpoints.startDiscovery(projectId, intents.keyFor(['discovery.run', projectId])),
      onSuccess: async (_result, projectId) => {
        intents.release(['discovery.run', projectId]);
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectReadiness(projectId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.rediscoveryGate(projectId) });
      },
    }),
    /**
     * WP-94, Q107 (a): a maintainer's re-evaluate. One key per intent — a double click is one run;
     * released on success, so a later re-evaluation is a new one. The gate is re-read afterwards,
     * which is what turns the button off while the run it started is in flight.
     */
    startRediscovery: useMutation({
      mutationFn: (projectId: string) =>
        endpoints.startRediscovery(projectId, intents.keyFor(['discovery.rerun', projectId])),
      onSuccess: async (_result, projectId) => {
        intents.release(['discovery.rerun', projectId]);
        await queryClient.invalidateQueries({ queryKey: queryKeys.rediscoveryGate(projectId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectReadiness(projectId) });
      },
    }),
    /**
     * WP-64: the business interview. One key per intent — the same answers submitted twice are one
     * interview, and the server answers the second with `performed: false`; released on success so
     * a later, edited submission is a new one. The proposal queue is what it writes to.
     */
    recordInterview: useMutation({
      mutationFn: (input: { projectId: string; answers: BusinessInterviewRequest['answers'] }) =>
        endpoints.recordInterview(
          input.projectId,
          { answers: input.answers },
          intents.keyFor(['interview.record', input]),
        ),
      onSuccess: async (_result, input) => {
        intents.release(['interview.record', input]);
        await queryClient.invalidateQueries({ queryKey: queryKeys.kbProposals(input.projectId) });
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
    mapIdentity: useMutation({
      mutationFn: (input: Parameters<typeof endpoints.mapIdentity>[0]) =>
        endpoints.mapIdentity(input),
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: [...queryKeys.orgIdentities] });
      },
    }),
    /**
     * `PATCH /api/org` (WP-93): one section at a time from the screen. A lowered maximum moves
     * every project's effective configuration and dial at the next read, so both are invalidated.
     */
    patchOrgSettings: useMutation({
      mutationFn: (input: Parameters<typeof endpoints.patchOrgSettings>[0]) =>
        endpoints.patchOrgSettings(input, intents.keyFor(['org.settings.write', input])),
      onSuccess: async (_result, input) => {
        intents.release(['org.settings.write', input]);
        await queryClient.invalidateQueries({ queryKey: [...queryKeys.orgSettings] });
        await queryClient.invalidateQueries({ queryKey: [...queryKeys.projects] });
        // Every project's reads (`['project', id, …]`): the dial and the effective configuration.
        await queryClient.invalidateQueries({ queryKey: ['project'] });
      },
    }),
    /**
     * `POST /api/org/dead-letters/:position/requeue` (WP-95). One key per intent, so a double click
     * is one re-queue on the server; the list is re-read either way, because a refusal (`409
     * event_not_dead_lettered`) means somebody else already re-queued it.
     */
    requeueDeadLetter: useMutation({
      mutationFn: (position: number) =>
        endpoints.requeueDeadLetter(
          position,
          intents.keyFor(['org.dead_letter.requeue', position]),
        ),
      onSuccess: (_result, position) => {
        intents.release(['org.dead_letter.requeue', position]);
      },
      onSettled: async () => {
        await queryClient.invalidateQueries({ queryKey: [...queryKeys.deadLetters] });
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
