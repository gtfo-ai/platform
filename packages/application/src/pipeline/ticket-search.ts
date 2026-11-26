/**
 * **The *Start a ticket* typeahead** — the tickets a person's typed query names, for the dialog that
 * starts one by hand (`startTicketManually`, product/04 S0).
 *
 * One read through the project's task-management binding and `IntegrationActionExecutor`
 * (`ticketReads.search`, audited as `search_tickets` and charged to the binding's rate budget like
 * every other tracker read), outside every transaction and outside any run (`noRunScopedSecrets`).
 * What it adds to the port's answer is the platform's own judgement:
 *
 *  - **the binding's declared scope again** (`ticketScope`) — the port promises it, and a manual
 *    start refuses a ticket outside it, so a suggestion the start would refuse is never offered;
 *  - **whether the start would start work** — `startable`, the very `intakeStatusDecision` the
 *    start makes over the binding's status policy, so the hint and the refusal cannot disagree. It
 *    is a hint: the start reads the ticket again and judges it then;
 *  - **the binding's redactor** over the two texts it shows, then the bounds again (a placeholder
 *    may be longer than the secret it replaced).
 *
 * Answers rather than throws for the two "there is nothing to ask" cases — no binding, a provider
 * that does not declare `ticketSearch` — so the caller can say which. A provider failure
 * (`IntegrationError`) propagates: the caller decides what the person sees.
 */
import {
  type Id,
  MAX_TICKET_SEARCH_QUERY_CHARS,
  MAX_TICKET_SEARCH_RESULTS,
  MAX_TICKET_SUGGESTION_TITLE_CHARS,
  type TicketSearchItem,
} from '@platform/contracts';
import { intakeStatusDecision } from '@platform/domain';
import {
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrationsPort,
  ticketReads,
} from './integrations.js';
import type { ProjectSettingsPort } from './settings.js';
import { boundStatusName } from './ticket-snapshot.js';

export type TicketSearchAnswer =
  | { readonly status: 'ok'; readonly items: readonly TicketSearchItem[] }
  /** The project binds no task-management integration: there is no tracker to ask. */
  | { readonly status: 'no_binding' }
  /** The bound provider does not declare `ticketSearch`: the dialog offers the plain key. */
  | { readonly status: 'unsupported' };

export interface TicketSearchForStartOptions {
  readonly integrations: PipelineIntegrationsPort;
  readonly settings: ProjectSettingsPort;
}

const cut = (value: string, max: number): string => [...value].slice(0, max).join('');

/**
 * @throws {RangeError} for a query past {@link MAX_TICKET_SEARCH_QUERY_CHARS} — the route refuses
 * it first (`400`); this is the second door, never a cut.
 */
export const searchTicketsForStart = async (
  options: TicketSearchForStartOptions,
  input: { readonly projectId: Id; readonly query: string },
): Promise<TicketSearchAnswer> => {
  const query = input.query.trim();
  if (query.length > MAX_TICKET_SEARCH_QUERY_CHARS) {
    throw new RangeError(
      `a ticket search query is at most ${MAX_TICKET_SEARCH_QUERY_CHARS} characters, got ${query.length}`,
    );
  }
  const settings = await options.settings.forProject(input.projectId);
  const integrations = await integrationsForProject(
    options.integrations,
    input.projectId,
    noRunScopedSecrets(),
  );
  const binding = integrations.taskManagement;
  if (binding === null) {
    return { status: 'no_binding' };
  }
  const hits = await ticketReads(integrations).search(query, MAX_TICKET_SEARCH_RESULTS, {
    projectId: input.projectId,
    taskId: null,
  });
  if (hits === null) {
    return { status: 'unsupported' };
  }
  const policy = settings.ticketStatusPolicy ?? null;
  const items = hits
    .filter((hit) => binding.port.ticketScope(hit.ref.key).kind !== 'out_of_scope')
    .slice(0, MAX_TICKET_SEARCH_RESULTS)
    .map(
      (hit): TicketSearchItem => ({
        ref: hit.ref,
        title: cut(binding.redactor.redactText(hit.title).value, MAX_TICKET_SUGGESTION_TITLE_CHARS),
        status: boundStatusName(binding.redactor.redactText(hit.status).value),
        status_category: hit.status_category,
        startable:
          policy === null ||
          intakeStatusDecision(hit.status, hit.status_category, policy).kind === 'take',
      }),
    );
  return { status: 'ok', items };
};
