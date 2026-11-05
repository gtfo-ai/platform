/**
 * **The worker's launcher does not answer** (backlog 980): the page comes up whether or not the
 * launcher does — the first-run wizard included — and says so here. The worker asks the launcher
 * again by itself and claims as soon as it answers; until then it takes no work.
 */
import type { WorkerLocalState } from '@platform/contracts';
import type { ReactElement } from 'react';
import { Flash } from '../ui/flash.js';

export const LAUNCHER_NOTICE_TITLE = 'This worker’s launcher does not answer';

export const LauncherNotice = ({
  state,
}: {
  readonly state: Pick<WorkerLocalState, 'launcher'>;
}): ReactElement | null =>
  state.launcher !== 'unreachable' ? null : (
    <Flash tone="warning" title={LAUNCHER_NOTICE_TITLE}>
      The launcher starts each run’s container, so this worker takes no work until it answers. It is
      asked again by itself; <code>docker compose logs launcher</code> says why it is not answering.
    </Flash>
  );
