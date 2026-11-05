/**
 * Whether this platform **needs a worker** to run anything — the signal Home's checklist and the
 * Agents page use to say *Connect a worker* (S-23.20, the worker UX review § 3.7 and O2).
 *
 * The cheap existing read is a project's execution setting (`GET /api/projects/:id/execution`): its
 * `server_claimant` is the **instance's** — whether any server runner is claiming runs now — and its
 * `mode` the project's. The platform needs a worker for that project when nothing on the server
 * would run it: no server runner and a mode that admits workers, or a mode of workers only.
 * `server_only` with no server runner is a different problem (nothing helps but a server runner),
 * so it is not a worker's step.
 *
 * Read for **one** project — the oldest, which is the one Home's checklist follows — so the signal
 * costs one read however many projects there are. With no project there is no read, and the answer
 * is "not known" (`null`): before a project exists there is nothing a worker could run anyway.
 */
import type { ProjectExecutionResponse } from '@platform/contracts';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../api/keys.js';
import { useServices } from '../app/services.js';

/** Nothing on the server would run this project's stages: a worker has to. */
export const needsWorkerFor = (execution: ProjectExecutionResponse): boolean =>
  execution.mode === 'workers_only' ||
  (execution.server_claimant === 'none' && execution.mode !== 'server_only');

/**
 * `true`/`false` once the project's execution read answered, `'pending'` while it is in flight and
 * `null` when there is nothing to read or the read failed — a failed read never claims a need.
 */
export const useWorkerNeed = (projectId: string | null): boolean | 'pending' | null => {
  const { endpoints } = useServices();
  // `useProjectExecution`'s query (one cache entry), not retried: a failed read is "not known",
  // which hides the step at once rather than holding a checklist on a retry.
  const execution = useQuery({
    queryKey: queryKeys.projectExecution(projectId ?? ''),
    queryFn: () => endpoints.projectExecution(projectId ?? ''),
    enabled: projectId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (projectId === null || execution.isError) {
    return null;
  }
  return execution.data === undefined ? 'pending' : needsWorkerFor(execution.data);
};

/**
 * `GET /api/workers`, asked only when `enabled` — the same query as `useWorkers` (one cache entry),
 * so a page that needs the list only on a workers-only platform asks nothing on a server-run one.
 */
export const useWorkersWhen = (enabled: boolean) => {
  const { endpoints } = useServices();
  return useQuery({
    queryKey: [...queryKeys.workers],
    queryFn: () => endpoints.workers(),
    enabled,
  });
};
