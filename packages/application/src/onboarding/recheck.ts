/**
 * The readiness **re-check after a merge** — product/17 *"re-checked after every merged task
 * (cheap: mostly file and CI-event inspection)"*, WP-64 (PROGRESS backlog 46).
 *
 * `readiness_evaluations.source` has named a second producer since WP-21 (`recheck`) and this is
 * it: one job, one pure fold (`recheckReadiness`), one transaction through the same
 * `ReadinessStore.record` discovery uses — so the row and the narrow `projects.readiness_level`
 * write land together, exactly as they do for discovery.
 *
 * ## The trigger is the index run that read a new commit, not `mr.merged` itself
 *
 * `knowledge/index-job.ts` indexes the default branch after every `mr.merged` and
 * `default_branch.moved` (and at every task start), and hands its `afterIndex` hook the commit it
 * read and what it found. The composition root enqueues this job when the run **indexed a commit
 * it had not read** ({@link shouldRecheckAfterIndex}) — the default branch moved, which is what a
 * merged task is from the platform's side. That is *"task.merged-shaped"* and correctly ordered: R12
 * is scored from the index, so a re-check woken by the merge event directly would race the index
 * run and score the previous commit's vault. The file read is **pinned to the same commit** the
 * index read. Keyed on what the run found rather than on why it ran, because the index queue is
 * `stately` per project and collapses a merge into a queued task-start run; and a merge into a
 * branch other than the default one reads the same commit (`unchanged`) and writes no row.
 *
 * ## What it re-answers, and what it carries
 *
 * `READINESS_CRITERIA[].recheck` is the stated split: R9, R11 and R12 are the platform's and are
 * asked again; R8 is read from `CLAUDE.md`/`AGENTS.md` at the merged commit through the platform's
 * mirror (`RepositoryFileSource`, no checkout); R10 and R13 pass on a named file at the same commit
 * and otherwise carry (WP-94, backlog 231); R3 passes on an observed merge-request pipeline event
 * and otherwise carries; the other seven need a run and are **carried** with evidence that says so.
 * It never starts a run — product/17's *"cheap"* is the whole constraint; a maintainer who wants the
 * seven answered again starts discovery again (`rediscovery.ts`, Q107 (a)).
 *
 * ## A project nobody evaluated is not re-checked
 *
 * A re-check re-checks: with no previous evaluation there is nothing to carry seven criteria from,
 * and a row written anyway would turn `GET …/readiness`'s honest `409 readiness_not_evaluated` into
 * a 200 whose seven carried rows are all "not reported". So it is skipped by name.
 *
 * ## The residual, stated
 *
 * The job is not idempotent: a pg-boss retry after the commit writes a second `recheck` row with the
 * same answers (harmless — `latest` orders by instant). And two re-checks for two merges run one at
 * a time on this queue's single worker, but a *retried* older one could commit after a newer one
 * and briefly be the latest; the next merge's re-check corrects it. Neither can raise a level the
 * repository has not earned, because every answer is re-derived from what the commit holds.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Clock, IdSource } from '@platform/domain';
import {
  AGENT_INSTRUCTIONS_PATHS,
  type AgentInstructionsFile,
  agentInstructionsReadiness,
  mergeRequestConventionReadiness,
  mergeRequestPipelineReadiness,
  READINESS_CI_WINDOW_DAYS,
  READINESS_TREE_PATHS,
  secretScanningReadiness,
} from '@platform/domain';
import type { RepositoryFileEntry, RepositoryFileSource } from '../config/repository-config.js';
import type { EventStore } from '../ports/event-store.js';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { type ReadinessObservations, recheckReadiness } from './evaluate-readiness.js';
import type { PlatformReadinessProbe, ReadinessStore } from './ports.js';
import { readinessEvaluatedEventFor } from './readiness-event.js';

/** The `onboarding.discovery` queue's second payload — `kind` tells the two apart. */
export interface ReadinessRecheckData {
  readonly kind: 'readiness_recheck';
  readonly project_id: string;
  /** The commit the index run read; the file read is pinned to it. */
  readonly commit_sha: string;
  readonly [key: string]: unknown;
}

/**
 * The provider's CI events the platform already stored — R3's only evidence.
 *
 * A count rather than the events: the criterion asks *whether* any was observed, and the answer
 * names how many.
 */
export interface ReadinessCiEvents {
  /** `ci.pipeline.finished` events for this project that carry a merge request, since `since`. */
  mergeRequestPipelinesSince(projectId: Id, since: IsoDateTime): Promise<number>;
}

export interface ReadinessRecheckOptions {
  readonly unitOfWork: UnitOfWork;
  /** The project stream's next sequence, for `readiness.evaluated` (backlog 228). */
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  readonly readiness: ReadinessStore;
  readonly signals: PlatformReadinessProbe;
  readonly files: RepositoryFileSource;
  readonly ciEvents: ReadinessCiEvents;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** `projects.knowledge_dir`, or `null` when the project no longer has a row. */
  readonly project: (projectId: Id) => Promise<{ readonly knowledgeDir: string } | null>;
  readonly logger?: Logger;
}

export interface ReadinessRecheckReport {
  readonly status: 'recorded' | 'skipped';
  readonly reason: string | null;
  readonly previousLevel: number | null;
  readonly level: number | null;
}

const skipped = (reason: string, previousLevel: number | null = null): ReadinessRecheckReport => ({
  status: 'skipped',
  reason,
  previousLevel,
  level: null,
});

/** `RepositoryFileEntry` → the domain's shape, which never carries a blob id or a mode. */
const asInstructionsFile = (entry: RepositoryFileEntry | undefined): AgentInstructionsFile => {
  if (entry === undefined || entry.kind === 'absent') return { kind: 'absent' };
  if (entry.kind === 'not_a_file') return { kind: 'not_a_file' };
  if (entry.kind === 'oversized') return { kind: 'oversized', bytes: entry.bytes };
  return { kind: 'file', text: entry.text };
};

const DAY_MS = 24 * 60 * 60 * 1_000;

/** R10 and R13 from the named files (WP-94, backlog 231): each a pass or `null`, never a fail. */
const treeObservations = (
  files: Readonly<Partial<Record<string, RepositoryFileEntry>>>,
  commitSha: string,
): Pick<ReadinessObservations, 'mergeRequestConventions' | 'secretScanning'> => {
  const tree = Object.fromEntries(
    READINESS_TREE_PATHS.map((path) => [path, asInstructionsFile(files[path])]),
  );
  return {
    mergeRequestConventions: mergeRequestConventionReadiness({ files: tree, commitSha }),
    secretScanning: secretScanningReadiness({ files: tree, commitSha }),
  };
};

/** One re-check. Exported beside the handler so a test can drive it and read the report. */
export const recheckProjectReadiness = async (
  options: ReadinessRecheckOptions,
  data: ReadinessRecheckData,
): Promise<ReadinessRecheckReport> => {
  const projectId = data.project_id as Id;
  const project = await options.project(projectId);
  if (project === null) {
    return skipped('the project no longer has a row');
  }
  const previous = await options.readiness.latest(projectId);
  if (previous === null) {
    return skipped(
      'the project has never been evaluated, so there is nothing to re-check; discovery records the first evaluation',
    );
  }

  // Every read happens here, outside any transaction: the probe asks the git provider (R9), and
  // `integrationsForProject` refuses to run inside one.
  const signals = await options.signals.read(projectId);
  // One read for R8's two files and R10's and R13's named paths (WP-94), pinned to the same commit.
  const read = await options.files.read({
    projectId,
    paths: [...AGENT_INSTRUCTIONS_PATHS, ...READINESS_TREE_PATHS],
    commitSha: data.commit_sha,
  });
  const now = options.clock.now();
  const since = new Date(Date.parse(now) - READINESS_CI_WINDOW_DAYS * DAY_MS).toISOString();
  const pipelines = await options.ciEvents.mergeRequestPipelinesSince(
    projectId,
    since as IsoDateTime,
  );

  const observations: ReadinessObservations = {
    agentInstructions:
      read.status === 'ok'
        ? agentInstructionsReadiness({
            files: {
              'CLAUDE.md': asInstructionsFile(read.files['CLAUDE.md']),
              'AGENTS.md': asInstructionsFile(read.files['AGENTS.md']),
            },
            knowledgeDir: project.knowledgeDir,
            commitSha: read.commitSha,
          })
        : null,
    mergeRequestPipelines: mergeRequestPipelineReadiness(pipelines),
    ...(read.status === 'ok' ? treeObservations(read.files, read.commitSha) : {}),
  };
  if (read.status === 'unavailable') {
    (options.logger ?? silentLogger).warn(
      { project_id: projectId, commit_sha: data.commit_sha, reason: read.reason },
      'the readiness re-check could not read the repository files; R8, R10 and R13 are carried from the previous evaluation',
    );
  }

  const evaluation = recheckReadiness({
    id: options.ids.next(),
    projectId,
    evaluatedAt: now,
    previous,
    signals,
    observations,
  });
  const streamSeq = await options.eventStore.nextStreamSequence('project', projectId);
  await options.unitOfWork.transaction(async (scope) => {
    await options.readiness.record(scope.tx, evaluation);
    // One event per recorded row, in the row's transaction (backlog 228, `readiness-event.ts`).
    await scope.events.append([
      readinessEvaluatedEventFor({
        id: options.ids.next(),
        evaluation,
        streamSeq,
        component: 'readiness_recheck',
        occurredAt: now,
      }),
    ]);
  });
  return {
    status: 'recorded',
    reason: null,
    previousLevel: previous.level,
    level: evaluation.level,
  };
};

/** Asks for one re-check of one project at one commit — what the index run's hook calls. */
export const enqueueReadinessRecheck = async (
  jobs: Jobs,
  request: { readonly projectId: Id; readonly commitSha: string },
): Promise<void> => {
  await jobs.enqueue<ReadinessRecheckData>({
    queue: JOB_QUEUES.discoveryRecord,
    data: {
      kind: 'readiness_recheck',
      project_id: request.projectId,
      commit_sha: request.commitSha,
    },
  });
};

/**
 * Whether an index run should be followed by a re-check: it **indexed a commit it had not read** —
 * the default branch moved, which is a merge seen from the platform's side (product/17's *"after
 * every merged task"*). Not the run's *reason*: the index queue collapses a merge into a queued
 * task-start run, and the reason would then lose it. An `unchanged` run (a merge into another
 * branch, or a task starting on a branch that did not move) re-checks nothing, so no row repeats
 * the previous one.
 */
export const shouldRecheckAfterIndex = (run: { readonly status: string }): boolean =>
  run.status === 'indexed';

/** Logs the report; a skip is a state, never a throw (it would spend two pg-boss retries). */
export const runReadinessRecheck = async (
  options: ReadinessRecheckOptions,
  data: ReadinessRecheckData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const report = await recheckProjectReadiness(options, data);
  const fields = {
    project_id: data.project_id,
    commit_sha: data.commit_sha,
    status: report.status,
    previous_level: report.previousLevel,
    readiness_level: report.level,
    reason: report.reason,
  };
  if (report.status === 'skipped') {
    logger.info(fields, 'the readiness re-check recorded nothing');
    return;
  }
  logger.info(fields, 'readiness re-checked after a merge');
};
