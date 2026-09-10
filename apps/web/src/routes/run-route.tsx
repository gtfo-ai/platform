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
import { RunDetailScreen } from '../features/run-detail.js';

export const RunRoute = (): ReactElement => {
  const { runId } = useParams({ from: '/authenticated/runs/$runId' });
  return <RunDetailScreen runId={runId} />;
};
