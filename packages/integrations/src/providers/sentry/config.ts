/**
 * The Sentry binding's configuration (technical/06 § "Provider module layout", TD-020).
 *
 * One schema serves sentry.io, its regional hosts (`https://us.sentry.io`) and a self-hosted
 * instance: the only structural difference is `base_url`. Everything else here is a **cap**, and
 * the caps are the reason this file is longer than a base URL and a token.
 *
 * ## Why an error tracker needs caps at all
 *
 * A Sentry event is attacker-influenced text (BD-022) that the platform pre-fetches into a bug
 * task's Investigation context. Three of its members have no natural bound: the stack trace (a
 * runaway recursion produces tens of thousands of frames), the breadcrumb trail, and the tag set.
 * Handing an unbounded one to WP-16's context pack is a denial of service against the token
 * budget, and handing an unbounded one to `events.payload` is a denial of service against the
 * database. So the adapter truncates, marks what it dropped, and the marks are asserted.
 *
 * Secret fields carry no value here. The registry resolves them from the secret store and hands
 * them to `create` in `ProviderCreateInput.secrets`, keyed by these field names (BD-002).
 *
 * Sources, retrieved 2026-09-10:
 *  - <https://docs.sentry.io/api/> — the `/api/0/` prefix and the bearer scheme.
 *  - <https://docs.sentry.io/api/events/list-a-projects-issues/> — "limit … max 100".
 */
import * as z from 'zod';

/** Sentry organization and project slugs, as they appear in a `sentry.io/<org>/<project>` URL. */
const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'expected a Sentry slug such as "acme-example"');

export const sentryConfigSchema = z.strictObject({
  /**
   * `https://sentry.io`, a regional host, or the root of a self-hosted instance. The adapter
   * appends `/api/0`; a base URL that already carries it is rejected, because
   * `…/api/0/api/0/organizations/…` answers 404 in a way that reads like a missing organization.
   */
  base_url: z
    .url()
    .refine((value) => !/\/api\/\d+\/?$/.test(value), {
      message: 'give the instance root (https://sentry.io), not the /api/0 path',
    })
    .refine((value) => !value.endsWith('/'), { message: 'must not end with a slash' })
    .default('https://sentry.io'),
  /** The organization slug every issue path is namespaced by. */
  organization: slugSchema,
  /** Secret. The auth token, sent as `Authorization: Bearer …`. Value comes from the secret store. */
  auth_token: z.string().nullish(),
  /** Per-request timeout in milliseconds; 0 disables it (the replay harness has no network). */
  request_timeout_ms: z.int().nonnegative().max(600_000).default(30_000),

  // ── Caps (BD-022, and WP-16's token budget) ────────────────────────────────

  /** Highest `limit` a single `searchIssues` may ask for. Sentry documents a maximum of 100. */
  max_issues: z.int().positive().max(100).default(25),
  /** Frames kept from the innermost end of a stack trace; the rest are dropped with a marker. */
  max_stack_frames: z.int().positive().max(1000).default(50),
  /** Bytes kept of the rendered stack trace, after redaction. */
  max_stack_trace_bytes: z.int().positive().max(4_194_304).default(65_536),
  /** Breadcrumbs kept, newest last; the rest are dropped with a marker crumb. */
  max_breadcrumbs: z.int().positive().max(1000).default(25),
  /** Bytes kept of one breadcrumb message. */
  max_breadcrumb_bytes: z.int().positive().max(65_536).default(1_024),
  /** Tags kept, in the order Sentry sent them. */
  max_tags: z.int().positive().max(1000).default(50),
  /** Bytes kept of the event message and of the issue title. */
  max_message_bytes: z.int().positive().max(1_048_576).default(8_192),
  /**
   * Bytes kept of every **short** provider string: a tag name, a tag value, a breadcrumb's
   * `category` and `level`, a correlation id, a release, an environment, an assignee, a slug, an
   * id, a permalink.
   *
   * It is the review's third blocker in Sentry's shape. `max_tags` capped the tag *count* and
   * nothing capped a tag *value*, so a 2 MB `server_name` reached the port intact and a caller
   * counting `max_tags × something` was counting nothing.
   *
   * ## The bound, stated — and this paragraph is now a test rather than a promise
   *
   * It said "every field the adapter emits is bounded by a named cap" from review round 1, and it
   * was **false** for three rounds: `mapBreadcrumbs` emitted `category` and `level` raw, so at
   * these defaults — `max_breadcrumbs=25`, `max_breadcrumb_bytes=1024` — a 50-crumb trail of
   * 2,000,000-byte fields measured **100,027,762 bytes of JSON**. The defect survived because every
   * round audited the call sites that cap things instead of the members of the type being emitted
   * (standing rule 37, WP-11a). A docblock cannot hold this claim on its own, so
   * `providers/emitted-bounds.test.ts` drives every port method from a hostile document, walks the
   * answers and fails on any string past the largest named cap, and `mapping.test.ts` asserts the
   * breadcrumb sum at these very defaults — **including the 100,027,762 above**, so the number in
   * this paragraph is a test result and not a memory. (The figure this file quoted until WP-11a's
   * own review, "200,106,401 bytes at the shipped defaults", did not reproduce: it was measured at
   * 50 crumbs and a 2048-byte message cut, i.e. at *doubled* caps. The defect was the same one and
   * 100 MB is the same catastrophe; the sentence was wrong about where it was taken.)
   *
   * One issue is at most
   * `2 × max_message_bytes + 5 × max_field_bytes` — title and culprit, then `assigned_to`,
   * `project`, `ref.id`, `ref.short_id` and `ref.url`, the last four refused past
   * `max_field_bytes` rather than cut. One event is at most
   * `max_stack_trace_bytes + max_message_bytes
   *  + (max_breadcrumbs + 1) × (max_breadcrumb_bytes + 2 × max_field_bytes)
   *  + (max_tags + 1) × 2 × max_field_bytes
   *  + 8 × max_field_bytes`
   * — the breadcrumb term now counting a crumb's `category` and `level` beside its `message`, the
   * tag term counting the count-cap marker entry, and the last term being `event_id`, `issue_id`,
   * `release`, `environment` and the four correlation ids (`trace_id`, `span_id`, `request_id`,
   * `transaction_id`), whose *keys* are platform constants. Timestamps are ISO-8601 instants and
   * counts are integers. One health probe is at most `max_message_bytes`. There is no "plus one
   * marker per cap that fired" term: since review round 2 `capText` counts its own marker inside
   * the cap (`mapping.ts`), which is both a tighter bound and what makes the cap idempotent.
   *
   * A **text** field over the cap is truncated with a marker; an **identifier** over it (an id, a
   * slug, a permalink) is `invalid_response` instead, because a 1 kB issue id is not a long name,
   * it is a response this adapter should not be building URLs out of.
   */
  max_field_bytes: z.int().positive().max(65_536).default(1_024),
});

export type SentryConfig = z.output<typeof sentryConfigSchema>;
export type SentryConfigInput = z.input<typeof sentryConfigSchema>;

/** Config fields whose values live in the secret store, never in `integrations.config`. */
export const sentrySecretFields = ['auth_token'] as const;
