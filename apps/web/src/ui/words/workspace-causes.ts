/**
 * **Why a machine cannot start runs, in words** (S-28.12) — one sentence per cause of the
 * `workspace_unavailable` blocker (`classifyWorkspaceFailure` in `@platform/contracts`), each with
 * what to do on that computer. Lean on purpose: the worker's local page imports it directly
 * (`worker/import-graph.test.ts` names it), and the Workers screen reads it through
 * `ui/humanize.ts`.
 *
 * The raw first line of the error is shown beside it, as text, only where a person asks for it.
 */
import type { WorkspaceUnavailableCause } from '@platform/contracts';

export const WORKSPACE_CAUSE_WORDS: Readonly<Record<WorkspaceUnavailableCause, string>> = {
  docker_networks_exhausted:
    'Docker on this machine has no free network ranges, so a run’s private network cannot be created. Remove unused Docker networks — “docker network prune” removes the ones no container uses — then press Try again.',
  docker_unreachable:
    'Docker on this machine is not answering, so a run’s containers cannot be created. Start Docker (or restart Docker Desktop), then press Try again.',
  image_missing:
    'A run image could not be found or downloaded on this machine. Check that it reaches the image registry and has room for the images, then press Try again.',
  disk_full:
    'This machine is out of disk space, so a run’s workspace cannot be created. Free some space — “docker system prune” removes unused images and containers — then press Try again.',
  unknown:
    'A run’s workspace could not be created on this machine. The error is below; fix it on that computer, then press Try again.',
};

/** The short form a row or a task says after the machine's name: "Docker has no free network ranges". */
export const WORKSPACE_CAUSE_SHORT: Readonly<Record<WorkspaceUnavailableCause, string>> = {
  docker_networks_exhausted: 'Docker has no free network ranges',
  docker_unreachable: 'Docker is not answering',
  image_missing: 'a run image could not be downloaded',
  disk_full: 'the machine is out of disk space',
  unknown: 'a run’s workspace could not be created',
};
