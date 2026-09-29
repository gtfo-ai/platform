/**
 * The bug template's observability pre-fetch — the linked Sentry issue's latest event and the log
 * lines around it, read before the **Investigator** runs (WP-89, PROGRESS backlog 143).
 *
 * product/08 promised it — *"the platform pre-fetches the linked issue's latest event (stack trace,
 * breadcrumbs, release, frequency, first/last seen) into the Investigation context"* and *"optional
 * pre-fetch of a small excerpt around the Sentry event timestamp filtered by request/trace id"* —
 * WP-11's plan row claimed it, and until this file nothing built it: Sentry and Loki were in no
 * registry the pipeline read, so a project's observability binding changed nothing but which skill
 * the investigator was provisioned with.
 *
 * ## Where it runs, and why it is fetched rather than stored
 *
 * In the `stage.execute` job, **between** its transactions and before the executor plans the run —
 * the shape `reviewedMergeRequestPaths` (WP-73) already has, and the one moment that is ordered
 * with respect to the prompt. The ticket-snapshot module's argument decides it: a
 * `pipeline.outbound` duty woken by `task.stage.entered` would be swept by the outbox *beside* the
 * `stage.execute` job the same transition enqueued, so nothing would order its write before the
 * planner's read — the criterion would hold by luck. Here the fetch and the plan are two lines of
 * one job.
 *
 * It is **not stored on the task**, which is the other half of the decision. Q61 (1) chose a
 * stored snapshot for the ticket for two reasons, and neither carries over. *Reproducibility*: the
 * assembled prompt is stored per run since WP-52 (`runs.user_prompt`, redacted at the write), so
 * the audit already holds exactly what the investigator was shown. *Provider latency in every
 * stage*: this read happens at **one** stage per bug task (and again only if that stage is re-entered,
 * when a fresh "latest event" is what the second attempt should see), each call bounded by the
 * binding's `request_timeout_ms` — at most three reads, so up to 90 s of the worker slot at the
 * 30 s default when every provider is slow. A column would have bought a migration, a writer beside the stage
 * executor (backlog 18's shape) and a staleness rule for data whose whole point is to be latest.
 *
 * ## Which issue
 *
 * The one the ticket **links**: the errors port's `linkedIssues` scans the ticket snapshot's title,
 * description and comments for a link to *the binding's own* instance and organisation and answers
 * issue ids (the Sentry adapter's rules are in `sentry/links.ts`). The first is read; the count is
 * announced in the marker so the model knows when there were others. **Residual, stated rather than
 * implied:** the ticket is untrusted (BD-022), so a ticket author chooses *which issue of the bound
 * organisation* the investigator is shown — never which host is dialled, whose credential is used or
 * which organisation is read. That is an issue the binding's own token could read, surfaced into a
 * task of a project bound to that organisation; an operator who binds one Sentry organisation to
 * two projects has made its issues readable to both.
 *
 * ## Which log lines
 *
 * Only when the logs binding names an `excerptSelector()` (the operator's, per binding — which
 * streams hold a project's logs is not the platform's to guess nor the ticket's to choose), only
 * when an event was read, and only when that event carries a trace or request id to filter by: a
 * window of {@link LOG_EXCERPT_WINDOW_MS} either side of the event, at most
 * {@link LOG_EXCERPT_LINES} lines. An unfiltered window of a busy service is noise the investigator
 * can fetch itself with `logcli`, and product/08 says *"filtered by request/trace id"*.
 *
 * ## Failure is advisory, and it is said (standing rule 20)
 *
 * An inbound read that makes a prompt better fails **open**: a binding that will not load, a
 * provider that refuses, a network failure — each is logged with the task and the binding type, the
 * block for that binding carries `status="unavailable"`, and the stage runs. The one error that is
 * rethrown is `TransactionOpenError`, because that is a moved call rather than a provider being down
 * (the ticket snapshot's round-1 lesson: one `catch` that absorbs it disarms WP-15d's guard).
 *
 * ## Bounded and redacted
 *
 * Redacted **here**, with the redactor the loader composed for the binding (its own credentials,
 * then the platform's pattern rules — TD-012 steps 1 and 2), because the executor redacts its audit
 * row and hands back the result unredacted (standing rule 13). **Cut in the assembler**, once, at
 * `MAX_ERROR_EVENT_EXCERPT_CHARS` / `MAX_LOG_EXCERPT_CHARS`, whose docblock carries the derivation
 * (criterion 2) — redact then cut, because an exact-match redactor cannot find a secret a cap has
 * halved. What this module renders is linear in what the adapters emit, and the adapters are
 * bounded by their own configured caps.
 */
import type { Id, TicketSnapshot } from '@platform/contracts';
import type { PipelineStage, PromptObservabilityExcerpt } from '@platform/domain';
import { TransactionOpenError } from '../events/open-transaction.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { ErrorEvent, Issue } from '../ports/integrations/observability-errors.js';
import type { LogQueryResult } from '../ports/integrations/observability-logs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  errorReads,
  logReads,
  noRunScopedSecrets,
  type ObservabilityBinding,
  type ObservabilityPortByType,
  type ObservabilityType,
  observabilityForProject,
  type PipelineIntegrationsPort,
} from './integrations.js';
import type { StoredTask } from './store.js';

/** How far either side of the event the log excerpt reaches: ten minutes in all. */
export const LOG_EXCERPT_WINDOW_MS = 5 * 60 * 1000;
/**
 * How many lines the excerpt asks for — `MAX_LOG_EXCERPT_CHARS` (8 000) over fifty lines is 160
 * characters a line, an ordinary structured log line. Never above the binding's `maxLines`.
 */
export const LOG_EXCERPT_LINES = 50;
/** The correlation ids a log line is filtered by, in the order they are preferred. */
export const LOG_CORRELATION_KEYS = ['trace_id', 'request_id'] as const;

export interface ObservabilityPrefetchOptions {
  readonly integrations: PipelineIntegrationsPort;
  readonly logger?: Logger;
}

interface CallContext {
  readonly projectId: Id;
  readonly taskId: Id;
}

/** Whether this stage gets the pre-fetch: the Investigator's, which only the bug template has. */
export const wantsObservabilityPrefetch = (stage: PipelineStage): boolean =>
  stage.kind === 'agent' && stage.role === 'investigator';

const rethrowMovedCall = (error: unknown): void => {
  if (error instanceof TransactionOpenError) {
    throw error;
  }
};

/**
 * One binding, or `null` for none — and `'unavailable'` for one that would not load, which is the
 * difference rule 20 exists for: *absent* adds no block, *broken* adds a block that says so.
 */
const resolve = async <TType extends ObservabilityType>(
  options: ObservabilityPrefetchOptions,
  context: CallContext,
  type: TType,
): Promise<ObservabilityBinding<ObservabilityPortByType[TType]> | null | 'unavailable'> => {
  try {
    return await observabilityForProject(
      options.integrations,
      context.projectId,
      type,
      // Outside a run: nothing on this path holds a minted credential (Q55).
      noRunScopedSecrets(),
    );
  } catch (error) {
    rethrowMovedCall(error);
    (options.logger ?? silentLogger).warn(
      { project_id: context.projectId, task_id: context.taskId, binding_type: type, err: error },
      'an observability binding could not be loaded; the investigation runs without its excerpt',
    );
    return 'unavailable';
  }
};

/** The ticket text a link is looked for in: title, description and every comment the snapshot kept. */
const ticketText = (snapshot: TicketSnapshot): string =>
  [snapshot.title, snapshot.description, ...snapshot.comments.map((comment) => comment.body)].join(
    '\n',
  );

/**
 * The event as the investigator reads it. The labels are platform words **inside** the data block,
 * where a stack frame that writes `--- breadcrumbs ---` can misplace a line and do nothing else.
 */
export const renderErrorEvent = (issue: Issue, event: ErrorEvent | null): string => {
  const summary = [
    `issue: ${issue.ref.short_id ?? issue.ref.id}`,
    `url: ${issue.ref.url}`,
    `title: ${issue.title}`,
    `culprit: ${issue.culprit}`,
    `level: ${issue.level}`,
    `status: ${issue.status}`,
    `events: ${issue.count}`,
    ...(issue.user_count == null ? [] : [`users: ${issue.user_count}`]),
    `first_seen: ${issue.first_seen}`,
    `last_seen: ${issue.last_seen}`,
  ];
  if (event === null) {
    return [...summary, '', 'latest event: none — the provider holds no event for this issue'].join(
      '\n',
    );
  }
  const tags = Object.entries(event.tags).map(([name, value]) => `${name}: ${value}`);
  const crumbs = event.breadcrumbs.map(
    (crumb) =>
      `${crumb.timestamp ?? '-'} ${crumb.level ?? '-'} ${crumb.category ?? '-'} ${crumb.message}`,
  );
  return [
    ...summary,
    '',
    `latest event: ${event.event_id} at ${event.timestamp}`,
    ...(event.release == null ? [] : [`release: ${event.release}`]),
    ...(event.environment == null ? [] : [`environment: ${event.environment}`]),
    '',
    'message:',
    event.message,
    '',
    'stack trace:',
    event.stack_trace,
    ...(crumbs.length === 0 ? [] : ['', '--- breadcrumbs ---', ...crumbs]),
    ...(tags.length === 0 ? [] : ['', '--- tags ---', ...tags]),
  ].join('\n');
};

/** The log lines, oldest first, one per line, with the query that found them. */
export const renderLogExcerpt = (
  query: {
    readonly selector: string;
    readonly filter: string;
    readonly from: string;
    readonly to: string;
  },
  result: LogQueryResult,
): string => {
  const lines = result.streams
    .flatMap((stream) => stream.lines)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .map((line) => `${line.timestamp} ${line.line}`);
  return [
    `selector: ${query.selector}`,
    `filter: ${query.filter}`,
    `window: ${query.from} to ${query.to}`,
    '',
    ...lines,
  ].join('\n');
};

const redacted = (text: string, redactor: SecretRedactor): { value: string; count: number } =>
  redactor.redactText(text);

interface ErrorsOutcome {
  readonly excerpt: PromptObservabilityExcerpt | null;
  readonly event: ErrorEvent | null;
}

const errorsExcerpt = async (
  options: ObservabilityPrefetchOptions,
  context: CallContext,
  snapshot: TicketSnapshot | null,
): Promise<ErrorsOutcome> => {
  const binding = await resolve(options, context, 'errors');
  if (binding === null) {
    return { excerpt: null, event: null };
  }
  const empty = (status: PromptObservabilityExcerpt['status'], issueLinks?: number) => ({
    excerpt: {
      kind: 'error_event' as const,
      status,
      body: '',
      ...(issueLinks === undefined ? {} : { issueLinks }),
    },
    event: null,
  });
  if (binding === 'unavailable') {
    return empty('unavailable');
  }
  if (snapshot === null) {
    return empty('no_ticket_text');
  }
  const links = binding.port.linkedIssues(ticketText(snapshot));
  const first = links[0];
  if (first === undefined) {
    return empty('no_issue_link', 0);
  }
  try {
    const reads = errorReads(binding);
    const issue = await reads.issue(first.id, context);
    const event = await reads.latestEvent(first.id, context);
    const body = redacted(renderErrorEvent(issue, event), binding.redactor);
    (options.logger ?? silentLogger).info(
      {
        project_id: context.projectId,
        task_id: context.taskId,
        issue_links: links.length,
        event: event !== null,
        redaction_count: body.count,
      },
      'the linked issue was pre-fetched for the investigation',
    );
    return {
      excerpt: { kind: 'error_event', status: 'read', body: body.value, issueLinks: links.length },
      event,
    };
  } catch (error) {
    rethrowMovedCall(error);
    (options.logger ?? silentLogger).warn(
      { project_id: context.projectId, task_id: context.taskId, err: error },
      'the linked issue could not be read; the investigation runs without the event',
    );
    return empty('unavailable', links.length);
  }
};

const correlationOf = (event: ErrorEvent): string | null => {
  for (const key of LOG_CORRELATION_KEYS) {
    const value = event.correlation_ids[key];
    if (value !== undefined && value !== '') return value;
  }
  return null;
};

const logsExcerpt = async (
  options: ObservabilityPrefetchOptions,
  context: CallContext,
  event: ErrorEvent | null,
): Promise<PromptObservabilityExcerpt | null> => {
  const binding = await resolve(options, context, 'logs');
  if (binding === null) {
    return null;
  }
  const empty = (status: PromptObservabilityExcerpt['status']): PromptObservabilityExcerpt => ({
    kind: 'log_excerpt',
    status,
    body: '',
  });
  if (binding === 'unavailable') {
    return empty('unavailable');
  }
  const selector = binding.port.excerptSelector();
  if (selector === null) {
    return empty('not_configured');
  }
  if (event === null) {
    return empty('no_event');
  }
  const filter = correlationOf(event);
  if (filter === null) {
    return empty('no_correlation_id');
  }
  try {
    const capabilities = binding.port.capabilities();
    const half = Math.min(LOG_EXCERPT_WINDOW_MS, Math.floor(capabilities.maxRangeMs / 2));
    const at = Date.parse(event.timestamp);
    const query = {
      selector,
      filter,
      from: new Date(at - half).toISOString(),
      to: new Date(at + half).toISOString(),
    };
    const result = await logReads(binding).range(
      { ...query, limit: Math.min(LOG_EXCERPT_LINES, capabilities.maxLines) },
      context,
    );
    const body = redacted(renderLogExcerpt(query, result), binding.redactor);
    return {
      kind: 'log_excerpt',
      status: 'read',
      body: body.value,
      lines: result.line_count,
      limitReached: result.truncated,
    };
  } catch (error) {
    rethrowMovedCall(error);
    (options.logger ?? silentLogger).warn(
      { project_id: context.projectId, task_id: context.taskId, err: error },
      'the log excerpt could not be read; the investigation runs without it',
    );
    return empty('unavailable');
  }
};

/**
 * The excerpts for this stage, or `undefined` when it gets none.
 *
 * `undefined` — not `[]` — for every stage that is not the Investigator's **and** for a project with
 * neither binding, so the job hands the planner nothing and the prompt is the one it always was
 * (criterion 1). Never throws for a provider or a binding; rethrows `TransactionOpenError`.
 *
 * @param snapshot the ticket's words as the job has them after `ensureTicketSnapshot` — the only
 * source of the link.
 */
export const prefetchObservability = async (
  options: ObservabilityPrefetchOptions,
  stored: StoredTask,
  stage: PipelineStage,
  snapshot: TicketSnapshot | null,
): Promise<readonly PromptObservabilityExcerpt[] | undefined> => {
  if (!wantsObservabilityPrefetch(stage)) {
    return undefined;
  }
  const context: CallContext = { projectId: stored.task.projectId, taskId: stored.task.id };
  const errors = await errorsExcerpt(options, context, snapshot);
  const logs = await logsExcerpt(options, context, errors.event);
  const excerpts = [errors.excerpt, logs].filter(
    (excerpt): excerpt is PromptObservabilityExcerpt => excerpt !== null,
  );
  return excerpts.length === 0 ? undefined : excerpts;
};
