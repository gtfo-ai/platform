/**
 * The lazy half of `/runs/$runId`.
 *
 * It exists as its own module because `lazyRouteComponent` needs a dynamic import boundary, and the
 * boundary has to be *outside* the module that builds the route tree — otherwise the tree's own
 * import pulls the transcript renderer into the initial graph and the split buys nothing. The
 * bundle budget check (`scripts/bundle-budget.mjs`) measures exactly that graph, so a regression
 * here fails the build rather than growing quietly.
 */
import { useParams } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ProjectBands, pageWidth } from '../app/project-frame.js';
import { useRunFrame } from '../app/run-frame.js';
import { RunDetailScreen } from '../features/run-detail.js';
import { cx } from '../ui/cx.js';

/**
 * The run's page inside its project's frame (S-25.4): the project's header and tabs above it, as
 * every page under `/projects/$key` has, with the URL unchanged. The shell reads the same
 * `useRunFrame`, so it draws the breadcrumb and no organisation row exactly when this draws the
 * bands.
 *
 * **The screen keeps its place in the tree** (review of PR #80): the bands are the first child,
 * present or not, and the screen is always the second, in the same `<div>` — so the frame arriving
 * after the run (or never, for a project the caller cannot list) never remounts the screen and
 * never drops what a person was typing into the steer box.
 */
export const RunRoute = (): ReactElement => {
  const { runId } = useParams({ from: '/authenticated/runs/$runId' });
  const frame = useRunFrame();
  const project = frame.kind === 'framed' ? frame.project : null;
  return (
    <div className="flex flex-col">
      {project === null ? null : <ProjectBands project={project} />}
      <div
        {...(project === null ? {} : { 'data-project-page': '' })}
        className={cx(pageWidth(true), 'py-6')}
      >
        <RunDetailScreen runId={runId} projectKey={project?.key ?? null} />
      </div>
    </div>
  );
};
