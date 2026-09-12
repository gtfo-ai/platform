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
 * - **A role whose workload does not exist yet says so**, and `indexer` stopped being one at WP-18a.
 *   Its job — `knowledge.index`, singleton per project — is registered by every process that
 *   composes the worker half (`knowledge.ts`), for the reason `runner` is a worker: pg-boss hands a
 *   job to **any** subscribed worker, so a capability that gated the index on a role name would
 *   leave a `ROLE=worker` process taking index jobs it had composed nothing for. `ROLE=indexer` is
 *   therefore a worker named for the workload an operator deploys it for, exactly like `runner`, and
 *   a container that looks healthy while doing no work is no longer what this role produces. What is
 *   still missing is **per-queue subscription** — a process that runs *only* index jobs — which
 *   nothing in this build has and which is recorded as discovered work rather than implied by a
 *   name.
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
  /**
   * Build the knowledge index and code map (WP-16, wired at WP-18a).
   *
   * Reported rather than gating: the index runs in the `knowledge.index` job, which is a worker
   * queue, so what decides whether a process indexes is `worker` plus its *configuration*
   * (`APP_KNOWLEDGE_MIRROR_ROOT` and the `git` binary, both named in the start-up log when absent)
   * — never the role name. See this file's header.
   */
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
  // The same, for the `knowledge.index` job (WP-18a). It was `worker: false` while nothing
  // registered that queue, which made the role a process that served ops endpoints and waited.
  indexer: { api: false, worker: true, indexer: true },
};

export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);

export const roleCapabilities = (role: Role): RoleCapabilities => ({
  ...CAPABILITIES[role],
  /**
   * Empty for every role in this build — WP-18a registered the last workload a role named and could
   * not run. The field stays: it is how the next role-named-before-its-work-package says so, and
   * `runtime.ts` already logs it.
   */
  unimplemented: [],
});

/**
 * True when the role has nothing to do in this build — **no role in it today**.
 *
 * It is kept rather than deleted, and the warning with it: a role named ahead of its work package is
 * how both `runner` (until WP-15g) and `indexer` (until WP-18a) started a process that served ops
 * endpoints and waited, and an operator splitting roles ahead of the features landing should learn
 * that from a log line rather than from an idle container. Both are workers now: they dispatch
 * events and run the job queues their name is about.
 */
export const roleIsIdle = (role: Role): boolean => {
  const capabilities = roleCapabilities(role);
  return !capabilities.api && !capabilities.worker;
};
