/**
 * The providers a running instance registers for the **pipeline** (BD-017, WP-15a).
 *
 * `createIntegrationRegistry` has existed since WP-07 and nothing ever called it outside a test:
 * the registry is where "this build knows about GitLab" is written down, and until a loader read
 * the `bindings` table there was nobody to say it to. This is that list.
 *
 * ## Why two and not five
 *
 * The pipeline holds a git provider and a task manager (`PipelineIntegrations`), and the loader
 * builds exactly those two. Registering Slack, Sentry and Loki here as well would be five entries
 * of which three are constructed by nothing — a set the code is parameterised over and the tests
 * are not, which is standing rule 68's shape. They are registered by the composition root that
 * consumes them (the digest job, the bug-task pre-fetch), in the work package that builds it.
 *
 * ## The duplication this composition carries, stated rather than discovered later
 *
 * WP-09's GitLab adapter deliberately keeps `IntegrationActionExecutor` **outside** itself
 * (`gitlab/provider.ts`: "Putting the executor *inside* the adapter would … which is the whole of
 * standing rule 14"), and the pipeline wraps every call in the executor itself
 * (`pipeline/integrations.ts`). WP-08's Jira adapter does the opposite: it takes an executor and
 * wraps its own calls. So a ticket write through a Jira binding passes through **two** executors —
 * two `integration_actions` rows for one action, and two rate-limit acquisitions from one budget.
 * Nothing is unsafe (the outer executor refuses a shadow mutation before the inner one is reached),
 * and nothing here can fix it: the fix is Jira adopting GitLab's shape, which is an adapter change
 * with its own contract suite. It is filed in `docs/technical/PROGRESS.md` under discovered work.
 */
import type { IntegrationActionExecutor } from '@platform/application';
import type { Clock } from '@platform/domain';
import { gitlabProviderRegistration } from '../providers/gitlab/index.js';
import { fixedActionContext } from '../providers/jira-cloud/index.js';
import { createJiraCloudRegistration } from '../providers/jira-cloud/registration.js';
import { createIntegrationRegistry, type IntegrationRegistry } from '../registry.js';

export interface PipelineProviderRegistryOptions {
  /**
   * The executor Jira's adapter wraps its own calls in — see the duplication note above.
   *
   * It is the same instance the pipeline uses, deliberately: two executors would mean two
   * idempotency stores and two rate-limit budgets for one account, which is worse than two rows.
   */
  readonly executor: IntegrationActionExecutor;
  readonly clock: Clock;
}

export const createPipelineProviderRegistry = (
  options: PipelineProviderRegistryOptions,
): IntegrationRegistry =>
  createIntegrationRegistry([
    gitlabProviderRegistration,
    createJiraCloudRegistration({
      executor: options.executor,
      clock: options.clock,
      // The task and the mode a call belongs to are carried by the *outer* executor, which the
      // pipeline calls with the task's own `mode` (`pipeline/integrations.ts`). This inner context
      // therefore never decides whether a mutation happens — the outer guard has already refused a
      // shadow task's mutation before `perform` runs — and `normal` is what a call that reached
      // here was allowed to be.
      actionContext: fixedActionContext('normal'),
    }),
  ]);
