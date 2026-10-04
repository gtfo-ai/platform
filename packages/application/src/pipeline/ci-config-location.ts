/**
 * **Where a project's CI configuration lives, for the planner's write-time path guard** — WP-147,
 * PROGRESS backlog 442's last half.
 *
 * The CI gate's tamper check has protected the provider-named CI path since WP-143
 * (`withCiConfigPath`); the write-time guard did not, because the plan phase had no provider read.
 * This is that read: the git binding's `repositorySettings().ciConfig` through
 * `IntegrationActionExecutor` (audited, rate-limited), outside any transaction — the stage executor
 * plans between its two transactions, and `integrationsForProject` refuses to resolve a binding
 * inside one.
 *
 * **A provider refusal stops the plan, retryably** (WP-147 review round 1). The reader throws
 * {@link CiConfigLocationUnavailableError}; the stage executor's plan step does not catch it, so the
 * `stage.execute` job fails before any run row exists and pg-boss retries it — and a job that spends
 * its retries is the stranded-stage sweep's (`JOB_EXHAUSTION`, WP-108: re-enqueued once, then the task
 * escalates). A run therefore never starts with the provider's CI path silently unprotected. The
 * refusal's text is the provider's (BD-022): the error carries it redacted with the binding's
 * redactor and bounded. A binding that fails to *load*, and any other throw, propagate unchanged
 * (rule 20). The provider's own `unknown` answer (GitLab omits `ci_config_path` for a token that may
 * not read the code) is an answer, not a failure: the planner logs that it adds no path.
 */
import type { Id } from '@platform/contracts';
import { IntegrationError } from '../ports/integrations/common.js';
import type { CiConfigLocation } from '../ports/integrations/git-provider.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrationsPort,
} from './integrations.js';

/** The bound on a refusal's message. */
export const MAX_CI_LOCATION_REASON_CHARS = 400;

/** The provider would not say where the CI configuration lives; the message is redacted. */
export class CiConfigLocationUnavailableError extends Error {
  override readonly name = 'CiConfigLocationUnavailableError';
}

export const createCiConfigLocationReader =
  (options: { readonly integrations: PipelineIntegrationsPort }) =>
  async (projectId: Id, taskId: Id): Promise<CiConfigLocation | null> => {
    const resolved = await integrationsForProject(
      options.integrations,
      projectId,
      noRunScopedSecrets(),
    );
    const git = resolved.git;
    if (git === null) {
      return null;
    }
    try {
      return await gitReads(resolved).ciConfigLocation({ projectId, taskId });
    } catch (error) {
      if (!(error instanceof IntegrationError)) throw error;
      throw new CiConfigLocationUnavailableError(
        git.redactor
          .redactText(
            `the git provider could not say where the CI configuration lives (${error.message}), so the write-time path guard cannot protect it; the stage is retried`,
          )
          .value.slice(0, MAX_CI_LOCATION_REASON_CHARS),
      );
    }
  };
