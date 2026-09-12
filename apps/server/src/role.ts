/**
 * `ROLE` — one image, several workloads (technical/01 § Containers, TD-002).
 *
 * The same container runs the HTTP API, the event dispatcher and pg-boss workers, the agent runner
 * and the knowledge indexer. `ROLE=all` runs everything, which is the single-process default a
 * self-hoster gets; splitting the roles across containers is the first step of technical/01's
 * scaling path and changes nothing but this variable.
 *
 * Two properties matter more than the table itself:
 *
 * - **Every role serves the ops endpoints.** `/healthz`, `/readyz`, `/metrics` and `/api/version`
 *   are how an orchestrator and Prometheus see a container at all, so a worker container that
 *   served nothing would be a container nothing could observe. The *API* surface — auth, `/api/*`,
 *   `/events` — is what `api` gates.
 * - **A role whose workload does not exist yet says so.** `indexer` is named by technical/01 and its
 *   job is not registered yet (WP-18). Rather than quietly starting a process that does nothing,
 *   `roleCapabilities` reports it as unimplemented and the composition root logs a warning naming the
 *   work package. A container that looks healthy and does no work is the failure mode this avoids.
 *
 * ## `runner` is the worker, and that is a statement about where a run happens (WP-15g)
 *
 * Until WP-15g this file reported `ROLE=runner` as *unimplemented (WP-12: Claude SDK runner)*, which
 * was stale the moment WP-12 landed — and the flag it set, `capabilities.runner`, **gated nothing**:
 * `runtime.ts` reads only `api` and `worker`, the pipeline is composed under `worker`, and
 * `roleIsIdle('runner')` was `true`, so the role started a process that served ops endpoints and
 * waited.
 *
 * What makes the role honest is not a flag but a fact: **a run executes inside the `stage.execute`
 * job**, which is a pg-boss queue the *worker* subscribes to (`pipeline/jobs.ts`). So the process that
 * runs agents is a worker, and `ROLE=runner` is a worker that says what it is there for. It is
 * deliberately **not** a narrower workload:
 *
 *  - gating the agent runner on the **role** would be a lottery. pg-boss hands a `stage.execute` job
 *    to any subscribed worker, so a deployment with `ROLE=worker` beside `ROLE=runner` would give half
 *    its agent stages to the process that composes no runner, and each of those would fail its run and
 *    escalate its task. Whether a process runs agents is therefore decided by **configuration** — the
 *    workspace provisioner and the model credential (`agent.ts`) — and never by `ROLE`;
 *  - a container that runs *only* agent stages needs per-queue subscription, which nothing in this
 *    build has and no work package owns. It is recorded as discovered work rather than implied by a
 *    role name.
 */

export const ROLES = ['all', 'api', 'worker', 'runner', 'indexer'] as const;

export type Role = (typeof ROLES)[number];

export interface RoleCapabilities {
  /** Serve the authenticated API: Better Auth, `/api/*`, and the SSE stream. */
  readonly api: boolean;
  /**
   * Run the outbox sweep, the event dispatcher, pg-boss workers and the maintenance cron — which
   * includes the `stage.execute` queue, and therefore every agent run.
   *
   * There is no separate `runner` flag: it gated nothing, and gating the agent runner on a role would
   * hand agent stages to whichever worker pg-boss picked (see this file's header). What decides
   * whether a process can run an agent is its *configuration*, read in `agent.ts`.
   */
  readonly worker: boolean;
  /** Build the knowledge index and code map (WP-16). */
  readonly indexer: boolean;
  /**
   * Work this role is supposed to do that no work package has built yet, as
   * `<capability> (<WP>)`. Empty for a role that is fully implemented.
   */
  readonly unimplemented: readonly string[];
}

const CAPABILITIES: Record<Role, Omit<RoleCapabilities, 'unimplemented'>> = {
  all: { api: true, worker: true, indexer: true },
  api: { api: true, worker: false, indexer: false },
  worker: { api: false, worker: true, indexer: false },
  // A worker, named for the workload an operator deploys it for: a run happens in the
  // `stage.execute` job, which is the worker's queue (WP-15g).
  runner: { api: false, worker: true, indexer: false },
  indexer: { api: false, worker: false, indexer: false },
};

/** Where each not-yet-built workload lands, so a warning can name it. */
const PENDING_WORK_PACKAGE = {
  indexer: 'indexer (WP-18: the knowledge indexer job is not registered)',
} as const;

export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);

export const roleCapabilities = (role: Role): RoleCapabilities => {
  const base = CAPABILITIES[role];
  const unimplemented: string[] = [];
  // `indexer` is the one capability nothing consumes: WP-16 built the indexer and WP-18 registers the
  // job, so the role is reported as unimplemented rather than being given a flag that gates nothing —
  // which is exactly what `runner` was until WP-15g.
  if (role === 'indexer' || role === 'all') {
    unimplemented.push(PENDING_WORK_PACKAGE.indexer);
  }
  return { ...base, unimplemented };
};

/**
 * True when the role has nothing to do in this build. `ROLE=indexer` today starts a process that
 * serves ops endpoints and waits — worth a warning, not a refusal: an operator splitting roles
 * ahead of the features landing should be able to write the compose file once.
 *
 * `ROLE=runner` is **no longer** one of them: it is a worker, so it dispatches events, runs every
 * pipeline job queue and executes agent stages when its configuration allows.
 */
export const roleIsIdle = (role: Role): boolean => {
  const capabilities = roleCapabilities(role);
  return !capabilities.api && !capabilities.worker;
};
