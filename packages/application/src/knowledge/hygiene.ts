/**
 * The nightly KB hygiene pass — technical/07 § "Librarian pipeline" step 6 (WP-18b).
 *
 * ## What it does
 *
 * Two things, per project, and both are deliberately small:
 *
 *  1. **It writes a health report** (`kb_health_reports`, migration 0018) from the index —
 *     `computeKbHealth` in the domain ring decides what a finding is, and its docblock says which
 *     of technical/07's kinds cannot be computed in this build and why.
 *  2. **It re-asks for an apply pass** for every project with a proposal that was decided and never
 *     applied. That is the recovery for the one loss that costs a human's decision: the apply
 *     wake-up is enqueued through `afterCommit` (at-most-once, TD-004) and from an API process that
 *     may hold no job runtime at all, so without this a maintainer's approval could sit in the
 *     queue for ever with nothing to move it.
 *
 * ## What it must never do, and where that line is
 *
 * **It does not write to the repository, and it does not delete a document.** No git call is made
 * from this module — it holds no `PipelineIntegrationsPort` at all, which is the structural version
 * of the promise rather than a rule somebody has to remember — and it issues no delete of any kind:
 * `kb_documents` is replaced only by an index run (BD-012: the index is derived and rebuildable),
 * and a *page* is only ever removed by a human's commit. product/05 is explicit that a deprecated
 * page is kept and that contradictions are flagged rather than resolved, so the strongest thing a
 * pass can do to a page a human wrote is **mention it in a report**.
 *
 * ## One job, every project
 *
 * A cron fires once for the deployment (pg-boss's own singleton per schedule) and the handler walks
 * the projects, bounded by {@link MAX_PROJECTS_PER_PASS}. Per-project jobs would be the other
 * shape; this one is chosen because the work is a few queries per project and a fan-out would put N
 * jobs on a queue every night for a report nobody is waiting on. The bound is what keeps the pass
 * from becoming unbounded work on a large instance, and a pass that hits it says so.
 */
import type { Id } from '@platform/contracts';
import type { Clock, IdSource } from '@platform/domain';
import { computeKbHealth, MAX_HEALTH_DOCUMENT_TOKENS, MAX_HEALTH_FINDINGS } from '@platform/domain';
import type { CronScheduleDefinition, JobHandler, Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { enqueueKnowledgeApply } from './apply.js';
import type { KnowledgeProposalStore } from './ports.js';

/** How many projects one pass reports on. */
export const MAX_PROJECTS_PER_PASS = 200;

/** The cron key, so two schedules on one queue cannot collide. */
export const KNOWLEDGE_HYGIENE_CRON_KEY = 'nightly';

/**
 * 03:15, in the instance's configured zone.
 *
 * Not midnight: every other nightly thing in the world runs at midnight, and the pass reads the
 * index a merge may still be rebuilding. The minute is odd for the same reason.
 */
export const KNOWLEDGE_HYGIENE_CRON = '15 3 * * *';

export interface KnowledgeHygieneOptions {
  readonly unitOfWork: UnitOfWork;
  readonly proposals: KnowledgeProposalStore;
  readonly jobs: Jobs;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** Projects to report on, newest first, bounded by the caller's own limit. */
  readonly projects: (limit: number) => Promise<readonly Id[]>;
  readonly logger?: Logger;
}

export interface HygieneReport {
  readonly projects: number;
  readonly findings: number;
  readonly dropped: number;
  /** Projects whose apply pass was re-requested — the recovery, counted rather than implied. */
  readonly reapplied: number;
}

/** One nightly pass. Exported beside the handler so a test can read the report. */
export const runKnowledgeHygiene = async (
  options: KnowledgeHygieneOptions,
): Promise<HygieneReport> => {
  const projects = await options.projects(MAX_PROJECTS_PER_PASS);
  const today = options.clock.now().slice(0, 10);
  let findings = 0;
  let dropped = 0;

  for (const projectId of projects) {
    const inputs = await options.proposals.readHealthInputs(projectId);
    const report = computeKbHealth(
      { documents: inputs.documents, danglingLinks: inputs.danglingLinks },
      {
        today,
        maxDocumentTokens: MAX_HEALTH_DOCUMENT_TOKENS,
        maxFindings: MAX_HEALTH_FINDINGS,
      },
    );
    findings += report.findings.length;
    dropped += report.dropped;
    await options.unitOfWork.transaction(async (scope) => {
      await options.proposals.writeHealthReport(scope.tx, {
        id: options.ids.next(),
        projectId,
        commitSha: inputs.commitSha,
        documents: inputs.documents.length,
        findings: report.findings,
        source: 'hygiene',
        createdAt: options.clock.now(),
      });
    });
  }

  // The recovery, over every project rather than only the ones reported on above: a project with a
  // stalled decision and no indexed document still needs its apply pass.
  const waiting = await options.proposals.projectsAwaitingApply(MAX_PROJECTS_PER_PASS);
  for (const projectId of waiting) {
    await enqueueKnowledgeApply(options.jobs, { projectId, reason: 'sweep' });
  }

  return { projects: projects.length, findings, dropped, reapplied: waiting.length };
};

export const knowledgeHygieneHandler =
  (options: KnowledgeHygieneOptions): JobHandler =>
  async () => {
    const logger = options.logger ?? silentLogger;
    const report = await runKnowledgeHygiene(options);
    logger.info(
      {
        projects: report.projects,
        findings: report.findings,
        dropped_findings: report.dropped,
        reapplied: report.reapplied,
        capped: report.projects >= MAX_PROJECTS_PER_PASS,
      },
      'knowledge hygiene pass finished',
    );
  };

export const knowledgeHygieneSchedule = (timezone: string): CronScheduleDefinition => ({
  queue: JOB_QUEUES.knowledgeHygiene,
  cron: KNOWLEDGE_HYGIENE_CRON,
  timezone,
  key: KNOWLEDGE_HYGIENE_CRON_KEY,
});

export const declareKnowledgeHygieneQueue = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue({
    name: JOB_QUEUES.knowledgeHygiene,
    // `stately`: one pass at a time for the whole deployment, and a second schedule tick while one
    // is running folds onto a single trailing job rather than queueing N nightly passes.
    policy: 'stately',
    retryLimit: 1,
    retryDelaySeconds: 300,
    expireInSeconds: 30 * 60,
  });
};
