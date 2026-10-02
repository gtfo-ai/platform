/**
 * The resources a killed e2e run leaves behind, and the sweep that finds them (WP-96, PROGRESS
 * backlog 7 bullet 8 and standing rule 60; extended to the repository container and the network by
 * WP-116, backlog 329).
 *
 * `startDockerFixture` creates, per file, a network `agentic-e2e-<suffix>`, a repository container
 * `agentic-e2e-repo-<suffix>` on it and two named volumes `agentic-e2e-{ctl,cache}-<suffix>`, and
 * removes all four **by name** in its cleanup. A run that completes leaves nothing; a run killed
 * before `afterAll` (the host killing a worker for memory is how the orchestrator met it) leaves
 * exactly those four, which no label sweep saw while they carried no label — the volumes until
 * WP-96, the container and the network until WP-116 (one such container, `agentic-e2e-repo-qywhns`,
 * sat on the orchestrator's daemon for a day and was removed by hand). All four carry the harness
 * marker and the **pid** of the process that made them now, and every fixture sweeps at start.
 *
 * **What the sweep may remove is decided three ways, and all three must agree**, because it runs
 * on developer machines whose daemons hold other people's containers, networks and volumes:
 *
 *  1. the name is exactly this repository's shape for that kind ({@link HARNESS_SHAPES}), then the
 *     fixture's base-36 suffix and nothing else — never a substring match, which is what the
 *     daemon's own `name=` filter is;
 *  2. the resource carries {@link HARNESS_LABEL}, so one somebody named in our shape by hand is not
 *     ours;
 *  3. the pid in {@link HARNESS_PID_LABEL} is **not alive** — e2e files run in parallel, and a live
 *     file's resources are its own business until its cleanup runs.
 *
 * **The order is containers, then networks, then volumes.** The daemon refuses to remove a network
 * a container is still attached to, so a network swept before its repository container would be
 * refused and left for the next run; and a volume a removed container mounted is free afterwards.
 *
 * **The network's name test is the weakest of the three, stated**: its shape is
 * `agentic-e2e-<suffix>` with a one-to-eight character base-36 suffix, so `agentic-e2e-data` is
 * a name it admits. Only the marker and the dead creator keep such a network — and only the harness
 * writes the marker.
 *
 * **The residuals, stated**:
 *  - a resource left by a run older than its kind's labelling (WP-96 for the volumes, WP-116 for
 *    the container and the network) has no label and is never swept; so is one whose pid has since
 *    been reused by another process, until that process ends. Both fail towards keeping;
 *  - a stale network that another container is still attached to — a provider's `run-<id>`
 *    container or an `agentic-e2e-http-…`/`agentic-e2e-githttp-…` server a killed case started on
 *    it, none of which carries the marker — is refused by the daemon and left, and the sweep says
 *    nothing about it beyond not naming it in its answer.
 *
 * **What it does not handle, and fails the other way** (WP-96 review round 1): the liveness test
 * is `kill(pid, 0)` in *this* process's pid namespace. A daemon shared by several hosts (a remote
 * `DOCKER_HOST`) or a test process in a separate pid namespace (a container) reads another host's
 * live creator as dead. A live run's volume then survives only if a container still mounts it (the
 * daemon refuses the `rm`, which carries no `-f`), and a live run's network only while its
 * repository container is attached — but **the repository container itself is removed with `-f`**,
 * because its `git daemon` never exits on its own, so a sweep that removed only stopped containers
 * would remove nothing in the one case it exists for. Nothing in this repository runs the e2e tier
 * from a second host or pid namespace today.
 */

/** `agentic-e2e-ctl-<suffix>` / `agentic-e2e-cache-<suffix>`, the suffix as `uniqueSuffix` writes it. */
export const HARNESS_VOLUME = /^agentic-e2e-(?:ctl|cache)-[0-9a-z]{1,8}$/;

/** `agentic-e2e-repo-<suffix>`: the fixture repository's `git daemon` container. */
export const HARNESS_CONTAINER = /^agentic-e2e-repo-[0-9a-z]{1,8}$/;

/** `agentic-e2e-<suffix>`: the network the repository container and the runs share. */
export const HARNESS_NETWORK = /^agentic-e2e-[0-9a-z]{1,8}$/;

/** The kinds the sweep removes, **in the order it removes them** (see the module docblock). */
export const HARNESS_KINDS = ['container', 'network', 'volume'] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

/** Each kind's exact name shape — test 1 of the three. */
export const HARNESS_SHAPES: Readonly<Record<HarnessKind, RegExp>> = {
  container: HARNESS_CONTAINER,
  network: HARNESS_NETWORK,
  volume: HARNESS_VOLUME,
};

/** The marker label every harness resource carries (volumes since WP-96, the rest since WP-116). */
export const HARNESS_LABEL = 'com.agentic.e2e.harness';

/** The pid of the process that created the resource. */
export const HARNESS_PID_LABEL = 'com.agentic.e2e.pid';

export interface ListedResource {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * The `--label` arguments a harness resource is created with — the same two for a `volume create`,
 * a `network create` and a `docker run`.
 */
export const harnessLabels = (pid: number = process.pid): string[] => [
  '--label',
  `${HARNESS_LABEL}=true`,
  '--label',
  `${HARNESS_PID_LABEL}=${pid}`,
];

/** Whether `pid` names a live process; `EPERM` is a live process somebody else owns. */
export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The names of the resources of `kind` the sweep may remove — the module docblock's three tests. */
export const staleHarnessResources = (
  kind: HarnessKind,
  listed: readonly ListedResource[],
  isAlive: (pid: number) => boolean,
): string[] =>
  listed
    .filter((resource) => HARNESS_SHAPES[kind].test(resource.name))
    .filter((resource) => resource.labels[HARNESS_LABEL] === 'true')
    .filter((resource) => {
      const raw = resource.labels[HARNESS_PID_LABEL] ?? '';
      const pid = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
      return pid !== null && !isAlive(pid);
    })
    .map((resource) => resource.name)
    .sort();

type Docker = (
  args: readonly string[],
  options?: { allowFailure?: boolean },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** How each kind is listed, read and removed. The daemon's filters only narrow the listing. */
const COMMANDS: Readonly<
  Record<
    HarnessKind,
    {
      readonly list: readonly string[];
      readonly labels: (name: string) => readonly string[];
      readonly remove: (name: string) => readonly string[];
    }
  >
> = {
  container: {
    list: [
      'container',
      'ls',
      '-a',
      '--filter',
      'name=agentic-e2e-repo-',
      '--filter',
      `label=${HARNESS_LABEL}`,
      '--format',
      '{{.Names}}',
    ],
    labels: (name) => ['container', 'inspect', '--format', '{{json .Config.Labels}}', name],
    // `-f`: the `git daemon` never exits, so a killed run's container is still running (see the
    // module docblock for what that costs on a shared daemon). `-v` for the same reason the
    // fixture's own cleanup passes it.
    remove: (name) => ['container', 'rm', '-f', '-v', name],
  },
  network: {
    list: [
      'network',
      'ls',
      '--filter',
      'name=agentic-e2e-',
      '--filter',
      `label=${HARNESS_LABEL}`,
      '--format',
      '{{.Name}}',
    ],
    labels: (name) => ['network', 'inspect', '--format', '{{json .Labels}}', name],
    remove: (name) => ['network', 'rm', name],
  },
  volume: {
    list: [
      'volume',
      'ls',
      '-q',
      '--filter',
      'name=agentic-e2e-',
      '--filter',
      `label=${HARNESS_LABEL}`,
    ],
    labels: (name) => ['volume', 'inspect', '--format', '{{json .Labels}}', name],
    // No `-f`: a volume a container still mounts is refused, which is the one guard a misread pid
    // still meets.
    remove: (name) => ['volume', 'rm', name],
  },
};

/** What one sweep removed, per kind. */
export type SweptHarnessResources = Readonly<Record<HarnessKind, readonly string[]>>;

const sweepKind = async (
  docker: Docker,
  kind: HarnessKind,
  isAlive: (pid: number) => boolean,
): Promise<string[]> => {
  const commands = COMMANDS[kind];
  const listed = await docker(commands.list, { allowFailure: true });
  const resources: ListedResource[] = [];
  for (const name of listed.stdout.split('\n').filter((line) => HARNESS_SHAPES[kind].test(line))) {
    const inspected = await docker(commands.labels(name), { allowFailure: true });
    if (!inspected.ok) continue;
    const labels = JSON.parse(inspected.stdout || 'null') as Record<string, string> | null;
    resources.push({ name, labels: labels ?? {} });
  }
  const removed: string[] = [];
  for (const name of staleHarnessResources(kind, resources, isAlive)) {
    const result = await docker(commands.remove(name), { allowFailure: true });
    if (result.ok) removed.push(name);
  }
  return removed;
};

/**
 * Sweeps every kind in {@link HARNESS_KINDS}' order and returns the names removed. Each kind is
 * listed only after the kind before it was removed, so a network is read once its container is
 * gone.
 */
export const sweepStaleHarnessResources = async (
  docker: Docker,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<SweptHarnessResources> => {
  const swept: Record<HarnessKind, string[]> = { container: [], network: [], volume: [] };
  for (const kind of HARNESS_KINDS) {
    swept[kind] = await sweepKind(docker, kind, isAlive);
  }
  return swept;
};
