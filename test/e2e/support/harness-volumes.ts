/**
 * The `agentic-e2e-{ctl,cache}-<suffix>` volumes a killed e2e run leaves behind, and the sweep that
 * finds them (WP-96, PROGRESS backlog 7 bullet 8, standing rule 60).
 *
 * `startDockerFixture` creates two named volumes per file and removes them **by name** in its
 * cleanup, so a run that completes leaves nothing — and a run killed before `afterAll` (the host
 * killing a worker for memory is how the orchestrator met it) leaves exactly those two, which no
 * label sweep sees because they carried no label. They are labelled now, with the harness marker
 * and the **pid** of the process that made them, and every fixture sweeps at start.
 *
 * **What the sweep may remove is decided three ways, and all three must agree**, because it runs
 * on developer machines whose daemons hold other people's volumes:
 *
 *  1. the name is exactly this repository's shape — `agentic-e2e-ctl-` or `agentic-e2e-cache-`,
 *     then the fixture's base-36 suffix and nothing else — never a substring match, which is what
 *     the daemon's own `name=` filter is;
 *  2. the volume carries {@link HARNESS_LABEL}, so a volume somebody named in our shape by hand
 *     is not ours;
 *  3. the pid in {@link HARNESS_PID_LABEL} is **not alive** — e2e files run in parallel, and a
 *     live file's volumes are its own business until its cleanup runs.
 *
 * **The residual, stated**: a volume left by a run older than WP-96 has no label and is never
 * swept; so is one whose pid has since been reused by another process, until that process ends.
 * Both fail towards keeping a volume, which is the direction rule 60 asks for.
 *
 * **What it does not handle, and fails the other way** (WP-96 review round 1): the liveness test
 * is `kill(pid, 0)` in *this* process's pid namespace. A daemon shared by several hosts (a remote
 * `DOCKER_HOST`) or a test process in a separate pid namespace (a container) reads another host's
 * live creator as dead, and would remove a live run's volume — unless it is mounted: a volume a
 * container still uses survives, because the daemon refuses the `rm` (no `-f`), and the sweep
 * says nothing about it. Nothing in this repository runs the e2e tier either way today.
 */

/** `agentic-e2e-ctl-<suffix>` / `agentic-e2e-cache-<suffix>`, the suffix as `uniqueSuffix` writes it. */
export const HARNESS_VOLUME = /^agentic-e2e-(?:ctl|cache)-[0-9a-z]{1,8}$/;

/** The marker label every harness volume carries since WP-96. */
export const HARNESS_LABEL = 'com.agentic.e2e.harness';

/** The pid of the process that created the volume. */
export const HARNESS_PID_LABEL = 'com.agentic.e2e.pid';

export interface ListedVolume {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** The `--label` arguments a harness volume is created with. */
export const harnessVolumeLabels = (pid: number = process.pid): string[] => [
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

/** The names of the volumes the sweep may remove — see the module docblock for the three tests. */
export const staleHarnessVolumes = (
  volumes: readonly ListedVolume[],
  isAlive: (pid: number) => boolean,
): string[] =>
  volumes
    .filter((volume) => HARNESS_VOLUME.test(volume.name))
    .filter((volume) => volume.labels[HARNESS_LABEL] === 'true')
    .filter((volume) => {
      const raw = volume.labels[HARNESS_PID_LABEL] ?? '';
      const pid = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
      return pid !== null && !isAlive(pid);
    })
    .map((volume) => volume.name)
    .sort();

type Docker = (
  args: readonly string[],
  options?: { allowFailure?: boolean },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * Lists the candidates, applies {@link staleHarnessVolumes} and removes what it names; returns the
 * names removed. The daemon's filters only narrow the listing — the decision is the function's.
 */
export const sweepStaleHarnessVolumes = async (
  docker: Docker,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<string[]> => {
  const listed = await docker(
    ['volume', 'ls', '-q', '--filter', 'name=agentic-e2e-', '--filter', `label=${HARNESS_LABEL}`],
    { allowFailure: true },
  );
  const volumes: ListedVolume[] = [];
  for (const name of listed.stdout.split('\n').filter((line) => HARNESS_VOLUME.test(line))) {
    const inspected = await docker(['volume', 'inspect', '--format', '{{json .Labels}}', name], {
      allowFailure: true,
    });
    if (!inspected.ok) continue;
    const labels = JSON.parse(inspected.stdout || 'null') as Record<string, string> | null;
    volumes.push({ name, labels: labels ?? {} });
  }
  const stale = staleHarnessVolumes(volumes, isAlive);
  const removed: string[] = [];
  for (const name of stale) {
    const result = await docker(['volume', 'rm', name], { allowFailure: true });
    if (result.ok) removed.push(name);
  }
  return removed;
};
