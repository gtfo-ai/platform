/**
 * `KnowledgeIndexer` as the background job technical/07 specifies — WP-18a.
 *
 * > `KnowledgeIndexer` job (pg-boss, singleton per project) … The platform reads it from the
 * > **default branch** (BD-025) at task start and after every merge (`mr.merged` /
 * > `default_branch.moved`).
 *
 * WP-16 built the indexer and deliberately wired no job, because nothing could give it a tree to
 * read; TD-026 decided where the tree comes from (a platform-side bare mirror) and this is the
 * wiring: a queue, two trigger handlers and a worker. It is in the application ring for the reason
 * `pipeline/runtime.ts` is — *which handler listens to which event, and which queue drives which
 * job, is the product* — and it owns no adapter: the `VaultSource` is composed by `apps/server`.
 *
 * ## Singleton per project, spelled `stately`
 *
 * The queue takes `singletonKey: project:<id>` under policy **`stately`**: at most one job *active*
 * and one *queued* per key. That is the reading of "singleton per project" that survives the
 * criterion — *two triggers while one run is in flight produce one run* — and the alternatives were
 * both measured against it. Policy `singleton` caps only the active side, so a burst of five merges
 * would queue five identical runs. Policy `exclusive` admits nothing at all while a job is live,
 * which **loses** the merge that arrived a millisecond after a run started reading: that run's tree
 * predates the merge, and nothing would ever come back for it. `stately` keeps exactly one trailing
 * job, and because a job is a wake-up rather than a message (TD-004: re-validate on fire) the
 * trailing run re-reads the branch head and picks up everything the first one missed.
 *
 * ## The two triggers, and why each carries what it does
 *
 * **`task.created` is "task start".** The alternatives are worse in a way worth writing down:
 * `task.stage.entered` fires once per stage, so a task would trigger five index runs where
 * technical/07 asks for one; `task.queued` is emitted only when a task *waits*. `task.created` is
 * emitted once, by the intake saga, before any stage runs — which is the point, because the first
 * stage's context pack is the first reader of the index.
 *
 * **`mr.merged` is enqueued without a commit, and `default_branch.moved` with one.** `mr.merged`'s
 * payload carries the *source* branch and no target (`mergeRequestRefSchema`), so the platform
 * cannot tell from the event whether the merge landed on the default branch — and pinning
 * `merge_commit_sha` would make every merge into a feature branch fail the adapter's ancestry guard
 * and report `vault_unavailable`, which reads as a fault rather than as "that merge was not about
 * the knowledge base". Unpinned, such a merge finds the same commit and the run reports `unchanged`.
 *
 * **`unchanged` is cheap, not free, and the difference is worth knowing before you add a trigger.**
 * `KnowledgeIndexer` compares `kb_index_state.commit_sha` **after** `vault.read` has returned, so an
 * unchanged run has already paid for a `git remote update`, an `ls-tree` of the whole repository and
 * a `cat-file --batch` of every vault document; what it saves is the parse and the write
 * transaction. Moving the comparison in front of the read would mean asking the vault for a *head*
 * without a snapshot — a second port method, on a port TD-026 deliberately left unchanged — and it
 * would also skip the fetch that makes the answer current, which is the one thing the after-merge
 * trigger exists for. So the cost is stated rather than optimised, and it bounds how often a
 * trigger may reasonably be added: this is per project, serialised by the queue's singleton key.
 *
 * `default_branch.moved.new_head` **is** the default branch's head by definition, so it is pinned:
 * the run then indexes exactly the commit the platform was told about, or refuses if the mirror
 * cannot produce it.
 *
 * ## What it refuses to do
 *
 * It never turns a read failure into an empty index — that is the indexer's rule and this module
 * keeps out of its way — and it never invents a project. A job whose project row has vanished
 * completes without work rather than throwing: a deleted project is not a failed job, and pg-boss
 * would retry it twice before anyone saw the reason.
 */
import type { Id } from '@platform/contracts';
import type { EventHandler } from '../events/handler.js';
import type { EnqueueResult, JobHandler, Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { KnowledgeIndexer } from './indexer.js';

/** Why a run was asked for — a log field, and the only thing that distinguishes two wake-ups. */
export type KnowledgeIndexReason = 'task_started' | 'merged' | 'default_branch_moved' | 'requested';

/** `knowledge.index` payload — snake_case, like every other payload on the wire. */
export interface KnowledgeIndexData {
  readonly project_id: string;
  /** Pin the read to a commit; absent means the default branch's head (BD-025). */
  readonly commit_sha?: string;
  readonly reason: KnowledgeIndexReason;
  readonly [key: string]: unknown;
}

/** What the job has to know about the project, re-read when it fires rather than carried. */
export interface KnowledgeIndexProject {
  /** `projects.key` — prefixed onto every chunk, so a hit says which project it came from. */
  readonly projectKey: string;
  /** `projects.knowledge_dir`, default `.agentic/knowledge`. */
  readonly knowledgeDir: string;
}

export interface KnowledgeIndexJobOptions {
  readonly indexer: KnowledgeIndexer;
  /**
   * The project's key and knowledge directory, or `null` when it no longer has a row.
   *
   * A function rather than a port: it is one `projects` read, the composition root already holds
   * the pool, and a port would be a third implementation of "select from projects" (the shape
   * `PipelineIntegrationsLoaderOptions.gitProjectPath` uses for the same reason).
   */
  readonly project: (projectId: Id) => Promise<KnowledgeIndexProject | null>;
  readonly logger?: Logger;
}

/** `project:<id>` — the key the queue's policy applies to. One index run per project at a time. */
export const knowledgeIndexKey = (projectId: string): string => `project:${projectId}`;

export const declareKnowledgeQueues = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue({
    name: JOB_QUEUES.knowledgeIndex,
    // See the header: `stately` is the only policy that both collapses a burst and keeps the
    // trailing wake-up a re-read needs.
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: true,
    // A first index clones the repository, which is a network operation against a monorepo in the
    // worst case; the 15-minute default would declare that job lost while git was still working.
    expireInSeconds: 60 * 60,
  });
};

/**
 * Asks for one index run of one project.
 *
 * It returns the {@link EnqueueResult} rather than swallowing it, and that is what makes "singleton
 * per project" testable through the function production calls instead of through a hand-built
 * enqueue beside it (standing rule 35): `coalesced` here is the queue saying *there is already a run
 * scheduled for this project*, which is a success.
 */
export const enqueueKnowledgeIndex = async (
  jobs: Jobs,
  request: {
    readonly projectId: Id;
    readonly reason: KnowledgeIndexReason;
    readonly commitSha?: string;
  },
): Promise<EnqueueResult> =>
  jobs.enqueue<KnowledgeIndexData>({
    queue: JOB_QUEUES.knowledgeIndex,
    singletonKey: knowledgeIndexKey(request.projectId),
    data: {
      project_id: request.projectId,
      reason: request.reason,
      ...(request.commitSha === undefined ? {} : { commit_sha: request.commitSha }),
    },
  });

export const knowledgeIndexHandler =
  (options: KnowledgeIndexJobOptions): JobHandler<KnowledgeIndexData> =>
  async (job) => {
    const logger = options.logger ?? silentLogger;
    const projectId = job.data.project_id as Id;
    const project = await options.project(projectId);
    if (project === null) {
      logger.warn(
        { project_id: projectId, reason: job.data.reason },
        'knowledge index job fired for a project that no longer has a row; nothing indexed',
      );
      return;
    }

    const report = await options.indexer.index({
      projectId,
      projectKey: project.projectKey,
      knowledgeDir: project.knowledgeDir,
      ...(typeof job.data.commit_sha === 'string' ? { commitSha: job.data.commit_sha } : {}),
    });

    const fields = {
      project_id: projectId,
      trigger: job.data.reason,
      status: report.status,
      commit_sha: report.commitSha,
      documents: report.documents,
      chunks: report.chunks,
      invalid: report.invalid.length,
      removed: report.removed.length,
      reason: report.reason,
    };
    if (report.status === 'vault_unavailable') {
      // Not a thrown error: a vault that cannot be read is a *reported* state (the index is left
      // in place), and throwing would spend two pg-boss retries re-reading a mirror whose remote
      // is down before the reason reached anybody.
      logger.warn(fields, 'knowledge index run could not read the vault; the index is unchanged');
      return;
    }
    logger.info(fields, 'knowledge index run finished');
  };

/** TD-005's core band, behind the pipeline's own transitions: the index is a projection. */
export const KNOWLEDGE_INDEX_TRIGGER_PRIORITY = 90;

export const KNOWLEDGE_INDEX_TASK_HANDLER = 'knowledge.index.task-start';
export const KNOWLEDGE_INDEX_MERGE_HANDLER = 'knowledge.index.merge';

export interface KnowledgeTriggerOptions {
  readonly jobs: Jobs;
  readonly logger?: Logger;
}

/**
 * The enqueue, deferred to after the commit.
 *
 * `Jobs.enqueue` does not join the handler's transaction, so an enqueue written inline is a job
 * that exists even when the handler that decided on it rolled back. `afterCommit` is at-most-once
 * (TD-004), which is exactly why the job re-reads the project and the branch head when it fires.
 */
const enqueueAfterCommit = (
  options: KnowledgeTriggerOptions,
  request: {
    readonly projectId: Id;
    readonly reason: KnowledgeIndexReason;
    readonly commitSha?: string;
  },
  afterCommit: (callback: () => Promise<void>) => void,
): void => {
  afterCommit(async () => {
    await enqueueKnowledgeIndex(options.jobs, request);
    (options.logger ?? silentLogger).debug(
      { project_id: request.projectId, trigger: request.reason },
      'knowledge index requested',
    );
  });
};

/**
 * The two handlers, in priority order — exported as one list so a composition root cannot register
 * half of them (the shape `costHandlers` uses).
 */
export const knowledgeTriggerHandlers = (
  options: KnowledgeTriggerOptions,
): readonly EventHandler[] => [
  {
    name: KNOWLEDGE_INDEX_TASK_HANDLER,
    priority: KNOWLEDGE_INDEX_TRIGGER_PRIORITY,
    eventTypes: ['task.created'],
    handle: async (context) => {
      const event = context.event.event;
      if (event.type !== 'task.created') return;
      enqueueAfterCommit(
        options,
        { projectId: event.payload.project_id, reason: 'task_started' },
        context.afterCommit,
      );
    },
  },
  {
    name: KNOWLEDGE_INDEX_MERGE_HANDLER,
    priority: KNOWLEDGE_INDEX_TRIGGER_PRIORITY,
    eventTypes: ['mr.merged', 'default_branch.moved'],
    handle: async (context) => {
      const event = context.event.event;
      if (event.type === 'default_branch.moved') {
        enqueueAfterCommit(
          options,
          {
            projectId: event.payload.project_id,
            reason: 'default_branch_moved',
            commitSha: event.payload.new_head,
          },
          context.afterCommit,
        );
        return;
      }
      if (event.type !== 'mr.merged') return;
      enqueueAfterCommit(
        options,
        { projectId: event.payload.project_id, reason: 'merged' },
        context.afterCommit,
      );
    },
  },
];

export interface KnowledgeIndexRuntimeOptions extends KnowledgeIndexJobOptions {
  readonly jobs: Jobs;
}

export interface KnowledgeIndexRuntime {
  /** Registered on the `EventBus` by the composition root. */
  readonly handlers: readonly EventHandler[];
  /** Declares the queue and starts the worker. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const createKnowledgeIndexRuntime = (
  options: KnowledgeIndexRuntimeOptions,
): KnowledgeIndexRuntime => {
  const workers: JobWorker[] = [];
  return {
    handlers: knowledgeTriggerHandlers({
      jobs: options.jobs,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
    start: async () => {
      await declareKnowledgeQueues(options.jobs);
      workers.push(
        await options.jobs.work<KnowledgeIndexData>({
          queue: JOB_QUEUES.knowledgeIndex,
          handler: knowledgeIndexHandler(options),
          // One. The queue is singleton per project, and a second worker in this process would only
          // ever run a *different* project's index — at the cost of a second pooled connection held
          // across a clone. It is a throughput knob nothing has measured a need for.
          concurrency: 1,
        }),
      );
    },
    stop: async () => {
      const stopping = workers.splice(0, workers.length);
      for (const worker of stopping) {
        await worker.stop();
      }
    },
  };
};
