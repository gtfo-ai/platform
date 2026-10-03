/**
 * The resources a killed e2e run leaves behind, and the sweep that finds them (WP-96, PROGRESS
 * backlog 7 bullet 8 and standing rule 60; extended to the repository container and the network by
 * WP-116, backlog 329; to the two HTTP servers and to whatever is attached to a stale network by
 * WP-128, backlogs 394 and 395).
 *
 * `startDockerFixture` creates, per file, a network `agentic-e2e-<suffix>`, a repository container
 * `agentic-e2e-repo-<suffix>` on it and two named volumes `agentic-e2e-{ctl,cache}-<suffix>`, and
 * removes all four **by name** in its cleanup; a case may add an HTTP server
 * (`agentic-e2e-http-<suffix>`, `agentic-e2e-githttp-<suffix>`) on the same network, which its own
 * `stop()` removes. A run that completes leaves nothing; a run killed before `afterAll` (the host
 * killing a worker for memory is how the orchestrator met it) leaves exactly those, which no label
 * sweep saw while they carried no label — the volumes until WP-96, the repository container and the
 * network until WP-116, the two servers until WP-128 (one such container, `agentic-e2e-repo-qywhns`,
 * sat on the orchestrator's daemon for a day and was removed by hand). All of them carry the harness
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
 * **The order is containers, then what is attached to a stale network, then networks, then what
 * mounts a stale volume, then volumes.** The daemon refuses to remove a network a container is
 * still attached to, so a network swept before its containers would be refused and left for the
 * next run; and it refuses a volume a container (running or not) still mounts.
 *
 * **What is attached to a stale network is removed when it is ours** (WP-128, backlog 395, option
 * (b) of the ruling). A killed file's network can still hold a provider's containers — the run's
 * egress sidecar is attached to it, and so is anything a case started there — which carry
 * `com.agentic.run` and no harness marker, so the container kind cannot name them; and while one is
 * attached, the network's `rm` is refused. The network itself passed all three tests below (our
 * exact shape, our marker, a dead creator), so its containers that carry `com.agentic.run` or the
 * harness marker are removed with `-f -v` before it; one with neither label is left, and so is the
 * network then. **No creator label is put on
 * the provider's objects** — the network they are attached to is the join. A stale **volume** is
 * treated the same way, for the same reason: the provider's `export` helper is kept when a tarball
 * is wanted, mounts the fixture's cache volume, and carries `com.agentic.run` with no instance
 * label — measured, it held a dead-created cache volume on the first `verify:e2e` over this row.
 *
 * **The network's name test is the weakest of the three, stated**: its shape is
 * `agentic-e2e-<suffix>` with a one-to-eight character base-36 suffix, so `agentic-e2e-data` is
 * a name it admits. Only the marker and the dead creator keep such a network — and only the harness
 * writes the marker.
 *
 * **The residuals, stated**:
 *  - a resource left by a run older than its kind's labelling (WP-96 for the volumes, WP-116 for
 *    the repository container and the network, WP-128 for the two servers) has no label and is
 *    never swept; so is one whose pid has since been reused by another process, until that process
 *    ends. Both fail towards keeping;
 *  - none for a killed file's provider objects that are **not** attached to its network — the run
 *    container itself (it sits on its own `run-<id>` network only), that network and the run's
 *    volumes — **but only because of the next paragraph**: until WP-128 the next completed
 *    fixture's cleanup removed them, together with every other instance's (backlog 398), and since
 *    a cleanup removes only its own instance's objects, nothing else would.
 *
 * **A dead fixture's own run objects are removed by its instance label** (WP-128). The provider
 * writes `com.agentic.instance=<its control volume>` on every container, network and volume of a
 * run (WP-103), and a fixture's control volume is `agentic-e2e-ctl-<suffix>` — a harness volume the
 * three tests already decide about. So for every control volume the sweep finds stale, it first
 * removes the `com.agentic.run` objects labelled with that instance, exactly as the fixture's own
 * cleanup would have ({@link removeInstanceRunObjects}). A product instance's objects carry its own
 * control volume's name, which no marked, dead-created `agentic-e2e-ctl-…` volume shares, so they
 * are never named.
 *
 * **What it does not handle, and fails the other way** (WP-96 review round 1): the liveness test
 * is `kill(pid, 0)` in *this* process's pid namespace. A daemon shared by several hosts (a remote
 * `DOCKER_HOST`) or a test process in a separate pid namespace (a container) reads another host's
 * live creator as dead. A live run's volume then survives only if a container still mounts it (the
 * daemon refuses the `rm`, which carries no `-f`), and a live run's network only while its
 * repository container is attached — but **the repository container itself is removed with `-f`**,
 * because its `git daemon` never exits on its own, so a sweep that removed only stopped containers
 * would remove nothing in the one case it exists for — and since WP-128 so are its two HTTP
 * servers, whatever is attached to its network, and its provider's run objects by its instance
 * label. Nothing in this repository runs the e2e tier from a second host or pid namespace today.
 */

/** `agentic-e2e-ctl-<suffix>` / `agentic-e2e-cache-<suffix>`, the suffix as `uniqueSuffix` writes it. */
export const HARNESS_VOLUME = /^agentic-e2e-(?:ctl|cache)-[0-9a-z]{1,8}$/;

/**
 * The harness's long-running containers: `agentic-e2e-repo-<suffix>`, the fixture repository's
 * `git daemon`; `agentic-e2e-http-<suffix>`, the egress case's HTTP target; and
 * `agentic-e2e-githttp-<suffix>`, the credentialled git server (the last two since WP-128, backlog
 * 394).
 */
export const HARNESS_CONTAINER = /^agentic-e2e-(?:repo|http|githttp)-[0-9a-z]{1,8}$/;

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
      'name=agentic-e2e-',
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

/**
 * What one sweep removed, per kind — plus `instanceRuns`, the provider objects of the dead
 * fixtures' instances, and `attached`, the containers of any name removed because they were
 * attached to a stale network or mounted a stale volume (both WP-128, backlogs 398 and 395).
 */
export type SweptHarnessResources = Readonly<
  Record<HarnessKind, readonly string[]> & {
    readonly instanceRuns: readonly string[];
    readonly attached: readonly string[];
  }
>;

const removeAll = async (
  docker: Docker,
  names: readonly string[],
  remove: (name: string) => readonly string[],
): Promise<string[]> => {
  const removed: string[] = [];
  for (const name of names) {
    const result = await docker(remove(name), { allowFailure: true });
    if (result.ok) removed.push(name);
  }
  return removed;
};

/** The label the provider writes on every object of a run (`WORKSPACE_LABELS.run`). */
export const RUN_LABEL = 'com.agentic.run';
/** Which instance's launcher made it — the provider's control volume (`WORKSPACE_LABELS.instance`). */
export const INSTANCE_LABEL = 'com.agentic.instance';

/** The listing that names exactly one instance's run objects of a kind. */
const instanceFilter = (instance: string): string[] => [
  '--filter',
  `label=${RUN_LABEL}`,
  '--filter',
  `label=${INSTANCE_LABEL}=${instance}`,
];

/**
 * Removes the run objects **one instance** made — containers, then networks, then volumes, for
 * the order reason the module docblock gives — and returns their names (WP-128, PROGRESS backlog
 * 398).
 *
 * The filter is the instance label's exact value, which the daemon matches exactly (unlike
 * `name=`, a substring), beside the run label. It is what a fixture's cleanup removes of the
 * provider's objects, and what the start sweep removes for a fixture that died; it never names an
 * object another instance made, a product instance's included — which is what the cleanup did
 * until WP-128, measured beside a disposable instance's held run (PROGRESS, WP-128's notes). An
 * object with the run label and **no** instance label (one made before WP-103) is not named
 * either, which fails towards keeping.
 */
export const removeInstanceRunObjects = async (
  docker: Docker,
  instance: string,
): Promise<string[]> => {
  const removed: string[] = [];
  const lines = (stdout: string) => stdout.split('\n').filter((line) => line.length > 0);
  const containers = await docker(
    ['container', 'ls', '-a', ...instanceFilter(instance), '--format', '{{.Names}}'],
    { allowFailure: true },
  );
  removed.push(...(await removeAll(docker, lines(containers.stdout), COMMANDS.container.remove)));
  const networks = await docker(
    ['network', 'ls', ...instanceFilter(instance), '--format', '{{.Name}}'],
    { allowFailure: true },
  );
  removed.push(...(await removeAll(docker, lines(networks.stdout), COMMANDS.network.remove)));
  const volumes = await docker(
    ['volume', 'ls', ...instanceFilter(instance), '--format', '{{.Name}}'],
    { allowFailure: true },
  );
  // `-f`, as the fixture's cleanup has always passed it for these: its containers are gone by now.
  removed.push(
    ...(await removeAll(docker, lines(volumes.stdout), (name) => ['volume', 'rm', '-f', name])),
  );
  return removed;
};

/** A stale control volume names a dead fixture's instance; the cache volume names none. */
const HARNESS_CONTROL_VOLUME = /^agentic-e2e-ctl-[0-9a-z]{1,8}$/;

/** The names of every resource of `kind` the three tests admit. */
const staleOfKind = async (
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
  return staleHarnessResources(kind, resources, isAlive);
};

/**
 * Every container attached to a stale `network`, or mounting a stale `volume`, by name — the
 * containers that resource's `rm` would be refused for — **that carries `com.agentic.run` or the
 * harness marker**. `-a`: a stopped container holds its endpoint and its mount too. A container
 * with neither label is somebody else's (someone ran `docker run --network agentic-e2e-…` by hand)
 * and is left; the network's or volume's `rm` is then refused and it is left too.
 */
const attachedTo = async (
  docker: Docker,
  kind: 'network' | 'volume',
  name: string,
): Promise<string[]> => {
  const listed = await docker(
    ['container', 'ls', '-a', '--filter', `${kind}=${name}`, '--format', '{{.Names}}'],
    { allowFailure: true },
  );
  if (!listed.ok) return [];
  const ours: string[] = [];
  for (const container of listed.stdout.split('\n').filter((line) => line.length > 0)) {
    const inspected = await docker(COMMANDS.container.labels(container), { allowFailure: true });
    if (!inspected.ok) continue;
    const labels = (JSON.parse(inspected.stdout || 'null') ?? {}) as Record<string, string>;
    if (labels[RUN_LABEL] !== undefined || labels[HARNESS_LABEL] === 'true') ours.push(container);
  }
  return ours;
};

/**
 * Sweeps every kind in {@link HARNESS_KINDS}' order and returns the names removed. Each kind is
 * listed only after the kind before it was removed, and the containers attached to a stale network
 * or mounting a stale volume are removed just before it (see the module docblock), so its `rm`
 * meets nothing attached.
 */
export const sweepStaleHarnessResources = async (
  docker: Docker,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<SweptHarnessResources> => {
  const swept = {
    instanceRuns: [] as string[],
    container: [] as string[],
    attached: [] as string[],
    network: [] as string[],
    volume: [] as string[],
  };
  // First what each dead fixture's provider made, named by its stale control volume — before the
  // harness's own kinds, whose network a run's sidecar may still be attached to.
  const deadInstances = (await staleOfKind(docker, 'volume', isAlive)).filter((name) =>
    HARNESS_CONTROL_VOLUME.test(name),
  );
  for (const instance of deadInstances) {
    swept.instanceRuns.push(...(await removeInstanceRunObjects(docker, instance)));
  }
  for (const kind of HARNESS_KINDS) {
    const stale = await staleOfKind(docker, kind, isAlive);
    if (kind === 'network' || kind === 'volume') {
      for (const name of stale) {
        swept.attached.push(
          ...(await removeAll(
            docker,
            await attachedTo(docker, kind, name),
            COMMANDS.container.remove,
          )),
        );
      }
    }
    swept[kind] = await removeAll(docker, stale, COMMANDS[kind].remove);
  }
  return swept;
};
