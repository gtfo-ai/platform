/**
 * `ROLE` — one image, several workloads (technical/01 § Containers, TD-002).
 *
 * The same container runs the HTTP API, the event dispatcher and pg-boss workers, the agent runner
 * and the knowledge indexer. `ROLE=all` runs everything, which is the single-process default a
 * self-hoster gets; splitting the roles across containers is the first step of technical/01's
 * scaling path and changes nothing but this variable.
 *
 * **That sentence was asserted by nothing until WP-72** (PROGRESS backlog 38): every process any
 * tier had started was `ROLE=all`. `test/e2e/topology/two-processes.e2e.test.ts` now starts the
 * roles as separate processes on one database and asserts the crossings through them, and it found
 * the one thing the variable did *not* change on its own: `ROLE=api` held no job client, so a command
 * it answered was never performed by the worker beside it. It holds an enqueue-only one now
 * (`enqueue-only-jobs.ts`).
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
 * What makes the role honest is not a flag but a fact. Since WP-276 (TD-031 decisions 3 and 13) the
 * `stage.execute` job **ends at the offer** and every worker subscribes it, and a run executes in the
 * **server claimant** (`@platform/application`'s `pipeline/claimant.ts`), which a worker composes only
 * when it is configured to run agents — the workspace provisioner and the model credential
 * (`agent.ts`). So `ROLE=runner` is a worker that says what it is there for, and it is deliberately
 * **not** a narrower workload: whether a process claims runs is its **configuration**, never its
 * `ROLE` (TD-028's 2026-11-04 amendment), which `test/e2e/topology/two-processes.e2e.test.ts` holds
 * as a table — a `runner` and a `worker` with a runner both read `claimants: server`, either without
 * one `none`.
 */

/*
 * ## A held inbound connection belongs to the role that serves `/webhooks/*` (WP-43)
 *
 * Slack's Socket Mode connection is an inbound door, so it lives where the other inbound doors
 * live: `ROLE=api` and `ROLE=all` hold one per Slack account that selects it, and every other role
 * holds none and **names** each such account in its log. It is decided by construction —
 * `runtime.ts` hands the connection supervisor the webhook ingress, which exists exactly when
 * `api` is true — so there is no flag here to keep in step. Two `api` replicas hold two
 * connections; Slack sends each payload to one of them, and the `inbox` dedup key is the backstop
 * for a payload it sends twice (`@platform/application`'s `inbound-connections.ts`).
 */

export const ROLES = ['all', 'api', 'worker', 'runner', 'indexer'] as const;

export type Role = (typeof ROLES)[number];

export interface RoleCapabilities {
  /** Serve the authenticated API: Better Auth, `/api/*`, and the SSE stream. */
  readonly api: boolean;
  /**
   * Run the outbox sweep, the event dispatcher, pg-boss workers and the maintenance cron — which
   * includes the `stage.execute` queue (plans, offers and gates since WP-276).
   *
   * There is no separate `runner` flag: what decides whether a process **claims and runs** an agent
   * run is its *configuration*, read in `agent.ts` (see this file's header).
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
  // A worker, named for the workload an operator deploys it for: a worker configured with a
  // launcher composes the server claimant, which runs the runs (WP-276).
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
