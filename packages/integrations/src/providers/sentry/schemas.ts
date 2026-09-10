/**
 * Sentry Web API payloads, validated at the ring edge (BD-022).
 *
 * Every schema here describes a *response*, so it is deliberately **non-strict**: `z.object`
 * strips unknown keys. That is the documented exception in CLAUDE.md ("opaque provider payloads"),
 * and it is the right direction for a vendor whose issue serializer grows fields every quarter —
 * the transcribed example below already carries `seerFixabilityScore` and `substatus`, neither of
 * which existed when this port was designed. What is *named* here is checked, and a named field of
 * the wrong type is an `invalid_response` at `parseProviderData`, never an `undefined` three
 * layers up.
 *
 * Field lists are transcribed from the published documentation, retrieved 2026-09-10:
 *  - issue:        <https://docs.sentry.io/api/events/retrieve-an-issue/>
 *  - issue list:   <https://docs.sentry.io/api/events/list-a-projects-issues/>
 *  - issue event:  <https://docs.sentry.io/api/events/retrieve-an-issue-event/>
 *  - organization: <https://docs.sentry.io/api/organizations/retrieve-an-organization/>
 */
import * as z from 'zod';

/**
 * Sentry publishes `"count": "150"` — a *string* — in both the issue and the issue-list examples,
 * while `userCount` is a number in the same document. Both forms are accepted and normalised, and
 * a value that is neither a finite non-negative integer becomes `0` rather than `NaN`: standing
 * rule 16, a guard against an untrusted producer must not read a field that producer can omit, and
 * `NaN` compares false against every ceiling.
 */
export const sentryCountSchema = z
  .union([z.number(), z.string()])
  .transform((value) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
  })
  .nullish();

/** `project` on an issue: the slug is what the port reports, the rest is context. */
export const sentryIssueProjectSchema = z.object({
  id: z.string().nullish(),
  name: z.string().nullish(),
  slug: z.string(),
  platform: z.string().nullish(),
});

/**
 * `assignedTo` is `null` or an actor object. The documented example is a user
 * (`{type, id, name, email}`); a team assignment carries the same shape with `type: "team"`.
 */
export const sentryActorSchema = z.object({
  type: z.string().nullish(),
  id: z.string().nullish(),
  name: z.string().nullish(),
  email: z.string().nullish(),
});

export const sentryReleaseSchema = z.object({
  version: z.string().nullish(),
  shortVersion: z.string().nullish(),
  dateCreated: z.string().nullish(),
  dateReleased: z.string().nullish(),
});

export const sentryIssueSchema = z.object({
  id: z.string(),
  shortId: z.string().nullish(),
  shareId: z.string().nullish(),
  title: z.string().nullish(),
  culprit: z.string().nullish(),
  permalink: z.string().nullish(),
  logger: z.string().nullish(),
  level: z.string().nullish(),
  status: z.string().nullish(),
  substatus: z.string().nullish(),
  statusDetails: z.record(z.string(), z.unknown()).nullish(),
  isPublic: z.boolean().nullish(),
  platform: z.string().nullish(),
  project: sentryIssueProjectSchema.nullish(),
  type: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  numComments: z.number().nullish(),
  assignedTo: sentryActorSchema.nullish(),
  count: sentryCountSchema,
  userCount: sentryCountSchema,
  firstSeen: z.string().nullish(),
  lastSeen: z.string().nullish(),
  firstRelease: sentryReleaseSchema.nullish(),
  lastRelease: sentryReleaseSchema.nullish(),
});

export type SentryIssue = z.output<typeof sentryIssueSchema>;

export const sentryIssueListSchema = z.array(sentryIssueSchema);

/** One `tags` entry on an event: `{"key": "browser", "value": "Chrome 83.0.4103"}`. */
export const sentryTagSchema = z.object({
  key: z.string(),
  value: z.string().nullish(),
});

/** One stack frame, as the `entries[].data.values[].stacktrace.frames[]` example prints it. */
export const sentryFrameSchema = z.object({
  function: z.string().nullish(),
  module: z.string().nullish(),
  filename: z.string().nullish(),
  absPath: z.string().nullish(),
  package: z.string().nullish(),
  lineNo: z.number().nullish(),
  colNo: z.number().nullish(),
  inApp: z.boolean().nullish(),
});

export const sentryStacktraceSchema = z.object({
  frames: z.array(sentryFrameSchema).nullish(),
  framesOmitted: z.unknown().nullish(),
  hasSystemFrames: z.boolean().nullish(),
});

export const sentryExceptionValueSchema = z.object({
  type: z.string().nullish(),
  value: z.string().nullish(),
  module: z.string().nullish(),
  stacktrace: sentryStacktraceSchema.nullish(),
  rawStacktrace: sentryStacktraceSchema.nullish(),
});

export type SentryExceptionValue = z.output<typeof sentryExceptionValueSchema>;

export const sentryExceptionEntrySchema = z.object({
  values: z.array(sentryExceptionValueSchema).nullish(),
});

export const sentryBreadcrumbSchema = z.object({
  timestamp: z.string().nullish(),
  category: z.string().nullish(),
  level: z.string().nullish(),
  message: z.string().nullish(),
  type: z.string().nullish(),
});

export type SentryBreadcrumb = z.output<typeof sentryBreadcrumbSchema>;

export const sentryBreadcrumbEntrySchema = z.object({
  values: z.array(sentryBreadcrumbSchema).nullish(),
});

/**
 * `entries` is a heterogeneous list — `exception`, `breadcrumbs`, `request`, `message`, … — and
 * the adapter reads two of them. `data` stays `unknown` here and is parsed by the entry schema
 * that matches `type`, so an entry kind nobody reads cannot fail the whole event (rule 20: this is
 * a *read*, and refusing a shape the vendor added later would turn every pre-fetch into a failure).
 */
export const sentryEntrySchema = z.object({
  type: z.string(),
  data: z.unknown(),
});

export const sentryEventSchema = z.object({
  id: z.string().nullish(),
  eventID: z.string().nullish(),
  groupID: z.string().nullish(),
  title: z.string().nullish(),
  message: z.string().nullish(),
  platform: z.string().nullish(),
  dateCreated: z.string().nullish(),
  dateReceived: z.string().nullish(),
  size: z.number().nullish(),
  tags: z.array(sentryTagSchema).nullish(),
  entries: z.array(sentryEntrySchema).nullish(),
  contexts: z.record(z.string(), z.unknown()).nullish(),
  release: sentryReleaseSchema.nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  culprit: z.string().nullish(),
  location: z.string().nullish(),
  projectID: z.string().nullish(),
});

export type SentryEvent = z.output<typeof sentryEventSchema>;

/** `GET /api/0/organizations/{org}/` — the read-only probe (`testConnection`). */
export const sentryOrganizationSchema = z.object({
  id: z.string().nullish(),
  slug: z.string(),
  name: z.string().nullish(),
  status: z.object({ id: z.string().nullish(), name: z.string().nullish() }).nullish(),
});

/** The `contexts.trace` block, which is where a Sentry event carries its distributed-trace ids. */
export const sentryTraceContextSchema = z.object({
  trace_id: z.string().nullish(),
  span_id: z.string().nullish(),
  parent_span_id: z.string().nullish(),
  op: z.string().nullish(),
});
