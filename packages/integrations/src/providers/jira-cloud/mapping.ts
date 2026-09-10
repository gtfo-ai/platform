/**
 * The Jira Cloud wire shapes and their mapping onto the `TaskManagement` port's data — the BD-022
 * boundary of this provider.
 *
 * Every schema here describes a **documented** response of the Jira Cloud platform REST API v3.
 * The source is Atlassian's own published OpenAPI document,
 * `https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json` (retrieved 2026-09-10,
 * `info.version` `1001.0.0-SNAPSHOT-a6463b4310f8edea4a3e…`); each schema names the operation it
 * came from. `test/fixtures/http/jira-cloud/` holds the response examples from that same document,
 * with every value replaced by an obviously fake one (BD-002).
 *
 * ## Why these objects are not strict
 *
 * Boundary schemas in this repository are strict, with one stated exception — "opaque provider
 * payloads" (CLAUDE.md). A Jira issue is that exception twice over: `fields` carries every custom
 * field of the site (`customfield_10042`), and Atlassian adds response members without a version
 * bump. So each object here validates *what the adapter reads* and ignores the rest, which is
 * `z.object`'s behaviour, while the *platform's* own types (`ticketSchema`, the event payloads)
 * stay strict and are what the application ring actually receives.
 *
 * ## Two conversions that are not cosmetic
 *
 *  - **Timestamps.** Jira returns `2021-01-17T12:34:00.000+0000`; the platform's `isoDateTimeSchema`
 *    is `z.iso.datetime({offset:true})`, which rejects an offset without a colon (verified against
 *    zod 4.5.4 — `+0000` fails, `+00:00` and `Z` pass). Every Jira timestamp is therefore
 *    normalised to RFC 3339 before it can reach a payload.
 *  - **Rich text.** Descriptions and comment bodies are ADF and the port speaks markdown, so they
 *    go through `adfToMarkdown` — untrusted text throughout (BD-022).
 */

import type {
  ExternalIdentity,
  Ticket,
  TicketComment,
  TicketLink,
  TicketMatch,
} from '@platform/application';
import { isoDateTimeSchema, nonEmptyStringSchema } from '@platform/contracts';
import * as z from 'zod';
import { adfMarkerId, adfToMarkdown } from './adf.js';

export const PROVIDER_ID = 'jira-cloud';

// ── Scalars ──────────────────────────────────────────────────────────────────

/**
 * A Jira timestamp, normalised to the platform's wire format.
 *
 * `Date.parse` accepts Jira's `+0000` (it is a legal ECMAScript date-time string); the transform
 * re-emits it as `Z`. An unparsable value fails the `isoDateTimeSchema` pipe with a path rather
 * than throwing out of the transform, so it is reported as an `invalid_response` like any other
 * shape error.
 */
export const jiraDateTimeSchema = z
  .string()
  .transform((value) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  })
  .pipe(isoDateTimeSchema);

// ── Users (`UserDetails`, getIssue / getComments / myself) ───────────────────

export const jiraUserSchema = z.object({
  accountId: z.string().min(1).optional(),
  accountType: z.string().optional(),
  displayName: z.string().optional(),
  /** Present only when the account shares it (GDPR); the webhook user shape never has it. */
  emailAddress: z.string().optional(),
  active: z.boolean().optional(),
});
export type JiraUser = z.infer<typeof jiraUserSchema>;

/**
 * A Jira account as an `ExternalIdentity`.
 *
 * `verified` is **false** here on purpose: `externalIdentitySchema` documents it as "false until
 * the identity has been mapped to a platform user", and this function knows only Jira. The
 * inbound normaliser sets it from `InboundContext.resolveUser`, which is the only thing that can
 * answer that question (BD-022, Q10).
 */
export const identityOfUser = (user: JiraUser | null | undefined): ExternalIdentity | null => {
  const accountId = user?.accountId;
  if (accountId === undefined || accountId.length === 0) {
    return null;
  }
  const email = user?.emailAddress;
  return {
    provider: PROVIDER_ID,
    external_id: accountId,
    // An `emailAddress` that is not an email address is dropped rather than carried: the platform
    // schema requires `z.email()`, and a provider string is not trusted to be one (BD-022).
    email: email !== undefined && z.email().safeParse(email).success ? email : null,
    display_name: user?.displayName ?? null,
    verified: false,
  };
};

// ── Comments (`getComments`, `addComment`, `updateComment`) ──────────────────

export const jiraCommentSchema = z.object({
  id: nonEmptyStringSchema,
  self: z.string().optional(),
  author: jiraUserSchema.optional(),
  updateAuthor: jiraUserSchema.optional(),
  /** ADF; `renderedBody` is not requested, so this is the document itself. */
  body: z.unknown().optional(),
  created: jiraDateTimeSchema,
  updated: jiraDateTimeSchema.optional(),
});
export type JiraComment = z.infer<typeof jiraCommentSchema>;

export const jiraCommentPageSchema = z.object({
  comments: z.array(jiraCommentSchema).default([]),
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
});

// ── Issues (`getIssue`, `searchAndReconsileIssuesUsingJql`) ──────────────────

const jiraNamedSchema = z.object({ id: z.string().optional(), name: z.string().optional() });

const jiraLinkedIssueSchema = z.object({
  key: nonEmptyStringSchema,
  fields: z
    .object({ status: jiraNamedSchema.optional(), summary: z.string().optional() })
    .optional(),
});

export const jiraIssueLinkSchema = z.object({
  id: z.string().optional(),
  type: z
    .object({
      name: z.string().optional(),
      inward: z.string().optional(),
      outward: z.string().optional(),
    })
    .optional(),
  inwardIssue: jiraLinkedIssueSchema.optional(),
  outwardIssue: jiraLinkedIssueSchema.optional(),
});

export const jiraIssueFieldsSchema = z.object({
  summary: z.string().nullish(),
  description: z.unknown().optional(),
  issuetype: jiraNamedSchema.nullish(),
  status: jiraNamedSchema.nullish(),
  priority: jiraNamedSchema.nullish(),
  labels: z.array(z.string()).nullish(),
  updated: jiraDateTimeSchema.nullish(),
  created: jiraDateTimeSchema.nullish(),
  assignee: jiraUserSchema.nullish(),
  reporter: jiraUserSchema.nullish(),
  parent: z
    .object({
      key: nonEmptyStringSchema,
      fields: z.object({ summary: z.string().nullish() }).nullish(),
    })
    .nullish(),
  issuelinks: z.array(jiraIssueLinkSchema).nullish(),
});

export const jiraIssueSchema = z.object({
  id: z.string().optional(),
  key: nonEmptyStringSchema,
  self: z.string().optional(),
  fields: jiraIssueFieldsSchema,
});
export type JiraIssue = z.infer<typeof jiraIssueSchema>;

/**
 * An issue the adapter asked for `updated` on, which is every issue it maps.
 *
 * `Ticket.updated_at` and `TicketMatch.updated_at` are required by the port and drive the polling
 * cursor; a fallback (the epoch, "now") would turn a projection mistake into a ticket that looks
 * ancient or freshly touched, so a missing `updated` is an `invalid_response` instead.
 */
export const jiraIssueWithUpdatedSchema = jiraIssueSchema.extend({
  fields: jiraIssueFieldsSchema.extend({ updated: jiraDateTimeSchema }),
});
export type JiraIssueWithUpdated = z.infer<typeof jiraIssueWithUpdatedSchema>;

/** `GET /rest/api/3/search/jql` — token paging, `isLast` on the final page. */
export const jiraSearchResultSchema = z.object({
  issues: z.array(jiraIssueWithUpdatedSchema).default([]),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
});

// ── Transitions (`getTransitions`) ───────────────────────────────────────────

export const jiraTransitionSchema = z.object({
  id: nonEmptyStringSchema,
  name: z.string().optional(),
  /** The **status** the transition leads to. What a status mapping names (product/19 §6). */
  to: jiraNamedSchema.nullish(),
  /** Absent in Atlassian's own example, so "not stated" means available. */
  isAvailable: z.boolean().optional(),
});
export type JiraTransition = z.infer<typeof jiraTransitionSchema>;

export const jiraTransitionsSchema = z.object({
  transitions: z.array(jiraTransitionSchema).default([]),
});

// ── Remote links (`getRemoteIssueLinks`, `createOrUpdateRemoteIssueLink`) ────

export const jiraRemoteLinkSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  globalId: z.string().optional(),
  relationship: z.string().optional(),
  object: z.object({ url: z.string(), title: z.string().optional() }),
});

export const jiraCreatedIssueSchema = z.object({
  id: z.string().optional(),
  key: nonEmptyStringSchema,
  self: z.string().optional(),
});

/** `ErrorCollection` — the body of every 4xx (`errorMessages`, `errors`). */
export const jiraErrorCollectionSchema = z.object({
  errorMessages: z.array(z.string()).optional(),
  errors: z.record(z.string(), z.string()).optional(),
});

// ── URLs ─────────────────────────────────────────────────────────────────────

export const issueUrl = (siteUrl: string, key: string): string =>
  `${siteUrl.replace(/\/+$/, '')}/browse/${key}`;

export const commentUrl = (siteUrl: string, key: string, commentId: string): string =>
  `${issueUrl(siteUrl, key)}?focusedCommentId=${commentId}`;

// ── Mapping onto the port's data ─────────────────────────────────────────────

export const toTicketComment = (
  comment: JiraComment,
  context: { readonly siteUrl: string; readonly issueKey: string },
): TicketComment => ({
  id: comment.id,
  author: identityOfUser(comment.author) ?? {
    provider: PROVIDER_ID,
    external_id: 'unknown',
    email: null,
    display_name: null,
    verified: false,
  },
  body: adfToMarkdown(comment.body),
  created_at: comment.created,
  updated_at: comment.updated ?? null,
  marker_id: adfMarkerId(comment.body),
  url: commentUrl(context.siteUrl, context.issueKey, comment.id),
});

/**
 * Issue links, in the direction the *read* ticket sits in.
 *
 * Jira states a link once, with an `inward`/`outward` description and the other issue on the
 * matching side; the port's `kind` is that description (`is blocked by`, `blocks`) normalised to a
 * slug, so a rule written against `is_blocked_by` matches whichever side of the link this is.
 */
export const toTicketLinks = (issue: JiraIssue, siteUrl: string): TicketLink[] =>
  (issue.fields.issuelinks ?? []).flatMap((link): TicketLink[] => {
    const outward = link.outwardIssue;
    const inward = link.inwardIssue;
    const other = outward ?? inward;
    if (other === undefined) {
      return [];
    }
    const description =
      (outward === undefined ? link.type?.inward : link.type?.outward) ?? 'relates to';
    return [
      {
        kind: slugOf(description),
        key: other.key,
        url: issueUrl(siteUrl, other.key),
        state: other.fields?.status?.name ?? null,
      },
    ];
  });

/** `is blocked by` → `is_blocked_by`; `merge request` → `merge_request`. */
export const slugOf = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'relates_to';

export interface TicketMappingInput {
  readonly issue: JiraIssueWithUpdated;
  readonly siteUrl: string;
  readonly comments: readonly JiraComment[];
  readonly remoteLinks: readonly z.infer<typeof jiraRemoteLinkSchema>[];
  readonly epic: {
    readonly key: string;
    readonly title: string;
    readonly description: string;
  } | null;
  readonly siblings: readonly { key: string; title: string; state: string }[];
}

export const toTicket = (input: TicketMappingInput): Ticket => {
  const { issue, siteUrl } = input;
  return {
    ref: { provider: PROVIDER_ID, key: issue.key, url: issueUrl(siteUrl, issue.key) },
    issue_type: issue.fields.issuetype?.name ?? 'Task',
    title: issue.fields.summary ?? '',
    description: adfToMarkdown(issue.fields.description),
    status: issue.fields.status?.name ?? 'Unknown',
    priority: issue.fields.priority?.name ?? null,
    labels: [...(issue.fields.labels ?? [])],
    comments: input.comments.map((comment) =>
      toTicketComment(comment, { siteUrl, issueKey: issue.key }),
    ),
    links: [
      ...toTicketLinks(issue, siteUrl),
      ...input.remoteLinks.map(
        (link): TicketLink => ({
          kind: slugOf(link.relationship ?? 'relates to'),
          key: link.object.url,
          url: link.object.url,
          state: null,
        }),
      ),
    ],
    epic: input.epic,
    siblings: [...input.siblings],
    // `capabilities().attachments` is false: nothing here downloads or extracts attachment text.
    attachments_text: [],
    assignee: identityOfUser(issue.fields.assignee),
    reporter: identityOfUser(issue.fields.reporter),
    updated_at: issue.fields.updated,
  };
};

export const toTicketMatch = (issue: JiraIssueWithUpdated, siteUrl: string): TicketMatch => ({
  ref: { provider: PROVIDER_ID, key: issue.key, url: issueUrl(siteUrl, issue.key) },
  issue_type: issue.fields.issuetype?.name ?? 'Task',
  priority: issue.fields.priority?.name ?? null,
  epic: issue.fields.parent?.key ?? null,
  links: toTicketLinks(issue, siteUrl),
  updated_at: issue.fields.updated,
});
