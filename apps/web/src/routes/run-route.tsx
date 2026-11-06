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
import { ProjectFrame } from '../app/project-frame.js';
import { useRunProjectKey } from '../app/run-frame.js';
import { RunDetailScreen } from '../features/run-detail.js';

/**
 * The run's page inside its project's frame (S-25.4): the project's header and tabs around it, as
 * every page under `/projects/$key` has, with the URL unchanged. The shell reads the same
 * `useRunProjectKey`, so it draws the breadcrumb and drops the organisation's row exactly when this
 * draws the frame; until the run and the projects reads answer, the page is unframed.
 */
export const RunRoute = (): ReactElement => {
  const { runId } = useParams({ from: '/authenticated/runs/$runId' });
  const projectKey = useRunProjectKey();
  const screen = <RunDetailScreen runId={runId} projectKey={projectKey} />;
  return projectKey === null ? (
    screen
  ) : (
    <ProjectFrame projectKey={projectKey}>{screen}</ProjectFrame>
  );
};
