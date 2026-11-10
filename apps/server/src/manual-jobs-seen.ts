/**
 * **The manual CI jobs seen in a project's recent task pipelines** (S-28.7, the M28 ruling) — what
 * the *Manual CI jobs* settings card offers a choice for (`GET /api/projects/:project_id/ci/manual-jobs`).
 *
 * The platform has no list of a project's jobs except the pipelines its tasks ran, so this reads the
 * **latest pipeline** of at most {@link MAX_MANUAL_JOBS_SEEN_HEADS} recent task heads — the head CI
 * judged (`tasks.ci_head_sha`) or else the merge request's recorded head — through the same git read
 * the CI gate makes (`gitReads(...).pipelineStatus`, through `IntegrationActionExecutor`), outside
 * every transaction and outside any run. A job seen at `manual` in any of them is offered once by
 * name; every name seen in them, whatever its status, is returned too, so a choice for a name no
 * pipeline has is flagged *never seen* (BACKLOG 1474).
 *
 * **Bounded and cached**: five reads at most per request, and an answer is kept per project for
 * {@link MANUAL_JOBS_SEEN_TTL_MS}, so opening the settings page repeatedly does not read GitLab
 * repeatedly. A head whose read fails (the provider refused it, or a transient outage) is counted
 * in `heads_unread` rather than failing the whole answer; a project with no git binding is refused
 * by name, and a binding that cannot be built answers `unavailable`.
 *
 * Every job name and stage is provider text (BD-022): redacted by the binding's redactor, then cut
 * at `MAX_GATE_WAIT_HELD_JOB_CHARS`, as the CI gate cuts the names it records.
 */
import {
  boundedJobName,
  gitReads,
  IntegrationError,
  integrationsForProject,
  type Logger,
  noRunScopedSecrets,
  type PipelineIntegrationsPort,
  type PipelineStatus,
} from '@platform/application';
import {
  type Id,
  MAX_JOB_NAMES_SEEN,
  MAX_MANUAL_JOBS_SEEN,
  MAX_MANUAL_JOBS_SEEN_HEADS,
  type ManualJobsSeenResponse,
} from '@platform/contracts';
import { BindingLoadError } from '@platform/integrations';

/** How long one project's answer is kept. */
export const MANUAL_JOBS_SEEN_TTL_MS = 60_000;

/** One recent task head: the task, and the commit whose latest pipeline is read. */
export interface RecentTaskHead {
  readonly taskId: Id;
  readonly headSha: string;
}

export type ManualJobsSeenAnswer =
  | { readonly status: 'ok'; readonly seen: Omit<ManualJobsSeenResponse, 'can_save'> }
  | { readonly status: 'no_binding' }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface ManualJobsSeenReader {
  readonly read: (projectId: Id) => Promise<ManualJobsSeenAnswer>;
}

/**
 * Whether a job reads like a deployment — a **hint** for the person choosing, never a rule: the
 * platform starts only what a person set to `run`.
 */
export const looksLikeDeploy = (name: string, stage: string | null): boolean =>
  /deploy|release|publish|rollout|production|prod\b|staging/i.test(`${name} ${stage ?? ''}`);

type Job = PipelineStatus['jobs'][number];

/** The answer for the pipelines read — pure, so the bounds and the merge are unit-tested. */
export const manualJobsSeenOf = (
  pipelines: readonly Pick<PipelineStatus, 'jobs'>[],
  unread: number,
  redact: (text: string) => string,
): Omit<ManualJobsSeenResponse, 'can_save'> => {
  const byName = new Map<string, ManualJobsSeenResponse['jobs'][number]>();
  const names = new Set<string>();
  for (const pipeline of pipelines) {
    const inThis = new Set<string>();
    for (const job of pipeline.jobs as readonly Job[]) {
      const name = boundedJobName(job.name, redact);
      if (name.length === 0) continue;
      names.add(name);
      if (job.status !== 'manual' || inThis.has(name)) continue;
      inThis.add(name);
      const stage = job.stage === null ? null : boundedJobName(job.stage, redact) || null;
      const known = byName.get(name);
      byName.set(
        name,
        known === undefined
          ? {
              name,
              stage,
              blocking: !job.allow_failure,
              trigger: job.trigger === true,
              deploy_like: looksLikeDeploy(name, stage),
              seen_in: 1,
            }
          : {
              ...known,
              // Blocking anywhere is blocking: the choice matters most where it holds a pipeline.
              blocking: known.blocking || !job.allow_failure,
              trigger: known.trigger || job.trigger === true,
              seen_in: known.seen_in + 1,
            },
      );
    }
  }
  return {
    jobs: [...byName.values()].slice(0, MAX_MANUAL_JOBS_SEEN),
    names_seen: [...names].sort().slice(0, MAX_JOB_NAMES_SEEN),
    heads_read: pipelines.length,
    heads_unread: unread,
  };
};

const MAX_REASON_CHARS = 1_024;

export const createManualJobsSeenReader = (options: {
  readonly integrations: PipelineIntegrationsPort;
  /** The project's most recent task heads, newest first, at most `limit`. */
  readonly recentHeads: (projectId: Id, limit: number) => Promise<readonly RecentTaskHead[]>;
  readonly logger: Logger;
  readonly now?: () => number;
}): ManualJobsSeenReader => {
  const now = options.now ?? Date.now;
  const cache = new Map<Id, { readonly at: number; readonly answer: ManualJobsSeenAnswer }>();
  return {
    read: async (projectId) => {
      const cached = cache.get(projectId);
      if (cached !== undefined && now() - cached.at < MANUAL_JOBS_SEEN_TTL_MS) {
        return cached.answer;
      }
      let answer: ManualJobsSeenAnswer;
      try {
        const integrations = await integrationsForProject(
          options.integrations,
          projectId,
          noRunScopedSecrets(),
        );
        const git = integrations.git;
        if (git === null) {
          answer = { status: 'no_binding' };
        } else {
          const heads = (await options.recentHeads(projectId, MAX_MANUAL_JOBS_SEEN_HEADS)).slice(
            0,
            MAX_MANUAL_JOBS_SEEN_HEADS,
          );
          const pipelines: PipelineStatus[] = [];
          let unread = 0;
          for (const head of heads) {
            try {
              const status = await gitReads(integrations).pipelineStatus(head.headSha, {
                projectId,
                taskId: head.taskId,
              });
              if (status !== null) pipelines.push(status);
            } catch (error) {
              if (!(error instanceof IntegrationError)) throw error;
              unread += 1;
              options.logger.warn(
                { project_id: projectId, task_id: head.taskId, code: error.code },
                'a recent task head’s pipeline could not be read for the manual jobs list',
              );
            }
          }
          answer = {
            status: 'ok',
            seen: manualJobsSeenOf(
              pipelines,
              unread,
              (text) => git.redactor.redactText(text).value,
            ),
          };
        }
      } catch (error) {
        if (!(error instanceof BindingLoadError) && !(error instanceof IntegrationError)) {
          throw error;
        }
        answer = {
          status: 'unavailable',
          reason: `the git binding could not be read: ${error.message}`.slice(0, MAX_REASON_CHARS),
        };
        // A refusal is not cached: the next open asks again.
        return answer;
      }
      // Only an answer is kept: a project with no git binding may be bound a moment later.
      if (answer.status === 'ok') {
        cache.set(projectId, { at: now(), answer });
      }
      return answer;
    },
  };
};
