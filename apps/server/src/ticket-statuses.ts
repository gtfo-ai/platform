/**
 * **The tracker's statuses, read for a person** — WP-181 rulings (a) and (b), TD-029 decisions 1
 * and 2, BD-031 ruling 7.
 *
 * Two readers in `apps/server`, one read: `GET …/ticket-statuses` (the pick list the wizard and the
 * project settings offer, WP-182) and the lifecycle check at `PUT …/bindings`, which validates the
 * names a block maps against the set the tracker answers. Both go through
 * `IntegrationActionExecutor` as a **read** (`ticketReads(...).statuses`, audited as
 * `list_statuses`), from an HTTP request — outside every transaction and outside any run, so no
 * run-scoped credential is in scope (`noRunScopedSecrets()`).
 *
 * The saved binding is read through `integrationsForProject`; the binding a write is about to save
 * through `proposedTaskManagementFor`, built from the account the request names with the overlay the
 * request carries, so a request that also changes `project_keys` is checked against the tracker it
 * will read.
 *
 * ## What "unavailable" covers
 *
 * A provider's refusal (`IntegrationError`, including a provider that declares no `listStatuses`
 * and a union past `MAX_TICKET_STATUSES`) and a binding that cannot be built (`BindingLoadError`:
 * an undecryptable credential, a configuration its schema refuses) are both *the tracker cannot be
 * read* — a named `503 lifecycle_statuses_unavailable` at both doors, never an empty list (rule 20:
 * an empty pick list would read as a tracker with no statuses). Anything else is a fault and
 * propagates. The reason quotes the error's message, which the adapters build redacted (the Jira
 * client redacts every string it carries, `BindingLoadError` names paths, never values) and which
 * is cut here to 1 024 characters.
 */
import {
  IntegrationError,
  integrationsForProject,
  type Logger,
  noRunScopedSecrets,
  type PipelineIntegrations,
  type PipelineIntegrationsPort,
  type ProjectBinding,
  proposedTaskManagementFor,
  ticketReads,
} from '@platform/application';
import {
  type ExternalIdentity,
  type Id,
  MAX_TICKET_STATUSES,
  type TicketStatus,
} from '@platform/contracts';
import { BindingLoadError } from '@platform/integrations';

/** What a statuses read answers. */
export type TicketStatusesAnswer =
  | { readonly status: 'ok'; readonly items: readonly TicketStatus[] }
  /** The project has no task-management binding: there is no tracker to ask. */
  | { readonly status: 'no_binding' }
  /** The tracker could not be read; `reason` says why, in the platform's words. */
  | { readonly status: 'unavailable'; readonly reason: string };

/** What the binding's own account is (`selfIdentity`), for Q118's readiness note. */
export type BindingAccountAnswer =
  | { readonly status: 'ok'; readonly identity: ExternalIdentity }
  | { readonly status: 'no_binding' }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface TicketStatusReader {
  /** The project's saved task-management binding's statuses. */
  readonly current: (projectId: Id) => Promise<TicketStatusesAnswer>;
  /** The statuses of the binding a write is about to save (`forProposedTaskManagement`). */
  readonly proposed: (projectId: Id, binding: ProjectBinding) => Promise<TicketStatusesAnswer>;
  /**
   * The own account (`selfIdentity`, a read through the executor) of the binding a write is about
   * to save — stored by the write for Q118 (a)'s readiness note, so the readiness read makes no
   * provider call (WP-181 review round 2). Refusals answer `unavailable`.
   */
  readonly proposedAccount: (
    projectId: Id,
    binding: ProjectBinding,
  ) => Promise<BindingAccountAnswer>;
}

const MAX_REASON_CHARS = 1_024;

const readFrom = async (
  integrations: PipelineIntegrations,
  projectId: Id,
): Promise<TicketStatusesAnswer> => {
  const items = await ticketReads(integrations).statuses({ projectId, taskId: null });
  if (items === null) {
    return { status: 'no_binding' };
  }
  if (items.length > MAX_TICKET_STATUSES) {
    // The adapters refuse past the bound; an adapter that did not is refused here rather than
    // published past the DTO's own `.max` (WP-181 criterion (7)).
    return {
      status: 'unavailable',
      reason: `the tracker answered ${items.length} statuses, more than the ${MAX_TICKET_STATUSES} the platform reads`,
    };
  }
  return { status: 'ok', items: items.map((item) => ({ ...item })) };
};

export const createTicketStatusReader = (options: {
  readonly integrations: PipelineIntegrationsPort;
  readonly logger: Logger;
}): TicketStatusReader => {
  const guarded = async <TAnswer>(
    projectId: Id,
    perform: () => Promise<TAnswer>,
  ): Promise<TAnswer | { readonly status: 'unavailable'; readonly reason: string }> => {
    try {
      return await perform();
    } catch (error) {
      if (!(error instanceof IntegrationError) && !(error instanceof BindingLoadError)) {
        throw error;
      }
      options.logger.warn(
        { project_id: projectId, err: error },
        'the tracker’s statuses could not be read',
      );
      const code = error instanceof IntegrationError ? ` (${error.code})` : '';
      return {
        status: 'unavailable',
        reason: `the tracker could not be read${code}: ${error.message}`.slice(0, MAX_REASON_CHARS),
      };
    }
  };
  return {
    current: async (projectId) =>
      guarded(projectId, async () =>
        readFrom(
          await integrationsForProject(options.integrations, projectId, noRunScopedSecrets()),
          projectId,
        ),
      ),
    proposedAccount: async (projectId, binding) =>
      guarded(projectId, async (): Promise<BindingAccountAnswer> => {
        const identity = await ticketReads(
          await proposedTaskManagementFor(
            options.integrations,
            projectId,
            binding,
            noRunScopedSecrets(),
          ),
        ).selfIdentity({ projectId, taskId: null });
        return identity === null ? { status: 'no_binding' } : { status: 'ok', identity };
      }),
    proposed: async (projectId, binding) =>
      guarded(projectId, async () =>
        readFrom(
          await proposedTaskManagementFor(
            options.integrations,
            projectId,
            binding,
            noRunScopedSecrets(),
          ),
          projectId,
        ),
      ),
  };
};
