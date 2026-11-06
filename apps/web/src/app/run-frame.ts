/**
 * Which project's frame a run's page sits in (S-25.4, product/10's 2026-11-06 amendment: *"Run
 * pages sit inside their project's frame"*).
 *
 * `/runs/$runId` keeps its URL — every link to a run names it, and an installed worker or a chat
 * message may too — so the project is not in the address: it is the run's own `project_id`,
 * resolved through the projects read the shell already holds. The shell (breadcrumb, which nav row)
 * and the run route (the project's header and tabs above the page) ask this one hook, so the two
 * never disagree about whether the page is framed.
 *
 * **Three answers on a run's page, and the page never moves between them** (review of PR #80):
 * `pending` while the run or the projects read is on its way — the shell draws **no** navigation
 * row, rather than the organisation's row it would take back a moment later — then `framed` (the
 * run's project) or `unframed` (a read that failed, or a project the caller cannot list: the
 * organisation's frame, as before). The run route keeps its screen in one place in the tree across
 * all three, so the screen is never remounted and a steer being typed survives the frame arriving.
 */
import { useParams } from '@tanstack/react-router';
import { useProjects, useRun } from './queries.js';

/** One project of the projects read. */
export type FramedProject = NonNullable<ReturnType<typeof useProjects>['data']>['items'][number];

export type RunFrame =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'framed'; readonly project: FramedProject }
  | { readonly kind: 'unframed' };

/** `none` off a run's page; on one, `pending`, then `framed` or `unframed`. */
export const useRunFrame = (): RunFrame => {
  const runId = useParams({ strict: false, select: (params) => params.runId });
  const run = useRun(runId ?? '', runId !== undefined);
  const projects = useProjects();
  if (runId === undefined) {
    return { kind: 'none' };
  }
  if (run.isError || projects.isError) {
    return { kind: 'unframed' };
  }
  if (run.data === undefined || projects.data === undefined) {
    return { kind: 'pending' };
  }
  const projectId = run.data.project_id;
  const project = projects.data.items.find((item) => item.id === projectId);
  return project === undefined ? { kind: 'unframed' } : { kind: 'framed', project };
};
