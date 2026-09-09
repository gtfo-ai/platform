/**
 * The **ObservabilityErrors** type port — technical/06 § "ObservabilityErrors", product/08 §
 * "Observability — errors".
 *
 * Sentry is the first provider (WP-11). The platform uses it in two places: it pre-fetches the
 * linked issue's latest event into a bug task's Investigation context, and it comments on (or
 * resolves) the issue when the fix merges.
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

export interface ObservabilityErrorsPort extends IntegrationPort<ObservabilityErrorsCapabilities> {
  getIssue(ref: { readonly id: string }): Promise<Issue>;
  /** The latest event of an issue, or `null` when the retention window has dropped them all. */
  getLatestEvent(ref: { readonly id: string }): Promise<ErrorEvent | null>;

  searchIssues(request: {
    readonly project: string;
    /** Provider query syntax; passed through verbatim, never interpolated from ticket text. */
    readonly query: string;
    readonly since?: string | null;
    readonly limit?: number;
  }): Promise<readonly Issue[]>;

  linkMergeRequest(ref: { readonly id: string }, mrUrl: string): Promise<void>;
  comment(ref: { readonly id: string }, text: string): Promise<{ readonly id: string }>;
  /** Idempotent: resolving an already-resolved issue succeeds and changes nothing. */
  resolve(
    ref: { readonly id: string },
    options?: { readonly inRelease?: string | null },
  ): Promise<Issue>;

  /** What an agent may be given inside a run (technical/06 § "Agent tooling exposure"). */
  agentTooling(): AgentTooling;
}
