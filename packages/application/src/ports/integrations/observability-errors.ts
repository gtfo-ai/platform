/**
 * The **ObservabilityErrors** type port — technical/06 § "ObservabilityErrors", product/08 §
 * "Observability — errors".
 *
 * Sentry is the first provider (WP-11). The platform uses it in two places: it pre-fetches the
 * linked issue's latest event into a bug task's Investigation context (WP-89), and — **only on a
 * binding that sets `resolve_on_merge`**, off by default (WP-111, PROGRESS backlog 302) — it
 * resolves the issues a bug task's ticket links when that task's merge request merges. The second
 * is the `resolve_on_merge` duty (`pipeline/resolve-on-merge.ts`): on `mr.merged` for a task on
 * the `bug` template, {@link ObservabilityErrorsPort.linkedIssues} over the task's stored ticket
 * snapshot, then {@link ObservabilityErrorsPort.resolve} once per linked issue — each through
 * `IntegrationActionExecutor`, audited against the binding, refused for a shadow task, and keyed
 * so a second merge event for the same task resolves nothing twice. It sends no release: the
 * platform does not know which release will carry the merge. `comment` and `linkMergeRequest`
 * are **not** called — Sentry documents neither (Q43), so the adapter refuses both.
 *
 * Everything an event carries — stack frames, breadcrumbs, tag values, the culprit — is attacker-
 * influenced text (BD-022). A crash report is one of the easiest places to plant an instruction,
 * so the port hands it to the platform as data and the prompts present it delimited.
 *
 * There is **no inbound normaliser here in v1.** product/08 lists `error.issue.created` as
 * optional and technical/02's catalogue has no such event; a normaliser would therefore have
 * nothing legal to emit. Issue-triggered tasks arrive with the event, not before it.
 */
import { isoDateTimeSchema, nonEmptyStringSchema, urlSchema } from '@platform/contracts';
import * as z from 'zod';
import type { AgentTooling, IntegrationPort } from './common.js';

// ── Data ─────────────────────────────────────────────────────────────────────

export const issueRefSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  /** Provider issue id — Sentry's numeric id as a string. */
  id: nonEmptyStringSchema,
  /** Human-facing short id (`PROJ-1AB`), when the provider has one. */
  short_id: nonEmptyStringSchema.nullish(),
  url: urlSchema,
});

export const issueLevelSchema = z.enum(['fatal', 'error', 'warning', 'info', 'debug']);
export const issueStatusSchema = z.enum(['unresolved', 'resolved', 'ignored']);

export const issueSchema = z.strictObject({
  ref: issueRefSchema,
  project: nonEmptyStringSchema,
  /** Untrusted (BD-022). */
  title: z.string(),
  culprit: z.string(),
  level: issueLevelSchema,
  status: issueStatusSchema,
  first_seen: isoDateTimeSchema,
  last_seen: isoDateTimeSchema,
  count: z.int().nonnegative(),
  user_count: z.int().nonnegative().nullish(),
  assigned_to: nonEmptyStringSchema.nullish(),
});

export const breadcrumbSchema = z.strictObject({
  timestamp: isoDateTimeSchema.nullish(),
  category: z.string().nullish(),
  level: z.string().nullish(),
  /** Untrusted (BD-022). */
  message: z.string(),
});

/**
 * The latest event of an issue.
 *
 * `tags` is a record with **provider-chosen keys** (`release`, `environment`, `server_name`, and
 * whatever the customer's SDK adds), one of the documented exceptions to the strict-object rule
 * (CLAUDE.md): an unexpected key here is the payload, not a mistake.
 */
export const errorEventSchema = z.strictObject({
  event_id: nonEmptyStringSchema,
  issue_id: nonEmptyStringSchema,
  timestamp: isoDateTimeSchema,
  /** Untrusted, and the single most injection-prone field in the platform (BD-022). */
  stack_trace: z.string(),
  message: z.string(),
  breadcrumbs: z.array(breadcrumbSchema),
  tags: z.record(z.string(), z.string()),
  release: nonEmptyStringSchema.nullish(),
  environment: nonEmptyStringSchema.nullish(),
  /** Correlation ids the logs provider can query on (`trace_id`, `request_id`). */
  correlation_ids: z.record(z.string(), z.string()),
});

export type IssueRef = z.infer<typeof issueRefSchema>;
export type Issue = z.infer<typeof issueSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type Breadcrumb = z.infer<typeof breadcrumbSchema>;

// ── Capabilities ─────────────────────────────────────────────────────────────

export interface ObservabilityErrorsCapabilities {
  readonly search: boolean;
  /** Commenting on an issue (`comment`). */
  readonly comments: boolean;
  /** Resolving, and whether "resolve in next release" is available. */
  readonly resolve: boolean;
  readonly resolveInRelease: boolean;
  /** Linking a merge request to the issue. */
  readonly linkMergeRequest: boolean;
  /** A hosted MCP server is offered for agents (SaaS) rather than a CLI script. */
  readonly mcp: boolean;
}

// ── The port ─────────────────────────────────────────────────────────────────

/**
 * How many linked issues {@link ObservabilityErrorsPort.linkedIssues} answers at most. A ticket that
 * pastes a thousand links is one ticket, and the scan must not become a list the caller has to
 * bound again (standing rule 41: bound once, where the list is made).
 */
export const MAX_LINKED_ISSUES = 20;

export interface ObservabilityErrorsPort extends IntegrationPort<ObservabilityErrorsCapabilities> {
  /**
   * The issues **of this binding** a piece of text links to — WP-89, the bug pre-fetch's first
   * question: *which issue is this ticket about?*
   *
   * Pure and synchronous: no request is made, so it is not an `IntegrationActionExecutor` call and
   * needs no audit row. The text is untrusted (a ticket's words, BD-022), which is why the answer is
   * an **id the provider issued** and never a URL the caller would dial: a link is recognised only
   * when it points at this binding's own instance (its host and, where the URL names one, its
   * organisation), so a ticket cannot make the platform read from anywhere the operator did not
   * bind. What *is* left to the ticket is **which** issue of that organisation is read — a residual
   * the pre-fetch states (`observability-prefetch.ts`).
   *
   * Ids are returned in order of first appearance, each once, and there are at most
   * {@link MAX_LINKED_ISSUES} of them. A provider whose issues have no URL form answers `[]`.
   */
  readonly linkedIssues: (text: string) => readonly { readonly id: string }[];

  /**
   * Whether this binding asked the platform to **resolve on merge** — the binding's
   * `resolve_on_merge` flag, `false` unless an operator set it (WP-111, PROGRESS backlog 302;
   * product/08 calls the resolve *"optional"*). Pure: the binding's own configuration, read where
   * the adapter was built, the shape `ObservabilityLogsPort.excerptSelector()` has.
   *
   * When it answers `true`, the `resolve_on_merge` duty calls {@link resolve} with no release for
   * every issue {@link linkedIssues} finds in a **bug** task's ticket snapshot, once the task's
   * merge request merges: one executor call, one `integration_actions` row, per linked issue. When
   * it answers `false`, a merge reads the binding and calls nothing.
   */
  readonly resolveOnMerge: () => boolean;

  readonly getIssue: (ref: { readonly id: string }) => Promise<Issue>;
  /** The latest event of an issue, or `null` when the retention window has dropped them all. */
  readonly getLatestEvent: (ref: { readonly id: string }) => Promise<ErrorEvent | null>;

  readonly searchIssues: (request: {
    readonly project: string;
    /** Provider query syntax; passed through verbatim, never interpolated from ticket text. */
    readonly query: string;
    readonly since?: string | null;
    readonly limit?: number;
  }) => Promise<readonly Issue[]>;

  readonly linkMergeRequest: (ref: { readonly id: string }, mrUrl: string) => Promise<void>;
  readonly comment: (
    ref: { readonly id: string },
    text: string,
  ) => Promise<{ readonly id: string }>;
  /**
   * Idempotent: resolving an already-resolved issue succeeds and changes nothing. Called on merge
   * for a bug task when {@link resolveOnMerge} answers `true` (WP-111), never otherwise.
   */
  readonly resolve: (
    ref: { readonly id: string },
    options?: { readonly inRelease?: string | null },
  ) => Promise<Issue>;

  /** What an agent may be given inside a run (technical/06 § "Agent tooling exposure"). */
  readonly agentTooling: () => AgentTooling;
}
