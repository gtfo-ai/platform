/**
 * Which project's frame a run's page sits in (S-25.4, product/10's 2026-11-06 amendment: *"Run
 * pages sit inside their project's frame"*).
 *
 * `/runs/$runId` keeps its URL — every link to a run names it, and an installed worker or a chat
 * message may too — so the project is not in the address: it is the run's own `project_id`,
 * resolved to the key through the projects read the shell already holds. The shell (breadcrumb,
 * no organisation row) and the run route (the project's header and tabs around the page) ask this
 * one hook, so the two never disagree about whether the page is framed. While either read is still
 * on its way — or the run's project is not one the caller can read — the answer is `null` and the
 * page is drawn as before, in the organisation's frame.
 */
import { useParams } from '@tanstack/react-router';
import { useProjects, useRun } from './queries.js';

/** The project key the run's page is framed by, or `null` (not a run page, or not resolved). */
export const useRunProjectKey = (): string | null => {
  const runId = useParams({ strict: false, select: (params) => params.runId });
  const run = useRun(runId ?? '', runId !== undefined);
  const projects = useProjects();
  if (runId === undefined || run.data === undefined) {
    return null;
  }
  const projectId = run.data.project_id;
  return projects.data?.items.find((project) => project.id === projectId)?.key ?? null;
};
