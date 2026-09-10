/**
 * What one Jira Cloud binding is configured with (TD-020, technical/06 § "Health and setup").
 *
 * Strict, because it is a boundary the settings UI and `.agentic/config.yml` both write, and
 * snake_case, because it is wire format (CLAUDE.md). `api_token` and `webhook_secret` are the
 * `secretFields` of the registration: the registry refuses to register a provider whose declared
 * secret field does not exist here, so a rename cannot silently downgrade a credential to plain
 * configuration (BD-002).
 *
 * The environment names an operator sets are the tool-native ones from TD-020 — `JIRA_SITE`,
 * `JIRA_USER_EMAIL`, `JIRA_API_TOKEN` (+ `_FILE`), `JIRA_WEBHOOK_SECRET` (+ `_FILE`) — and the
 * setup guide maps them onto these fields.
 */
import { nonEmptyStringSchema, urlSchema } from '@platform/contracts';
import * as z from 'zod';
import { DEFAULT_WEBHOOK_MAX_AGE_MS } from './webhook.js';

export const jiraCloudConfigSchema = z.strictObject({
  /** `https://acme-example.atlassian.net`. */
  site_url: urlSchema,
  /** The Atlassian account the API token belongs to. */
  user_email: z.email(),
  /** Secret. An Atlassian API token, never a password. */
  api_token: nonEmptyStringSchema,
  /**
   * Secret. The webhook's secret token; `null` when this binding has no webhook and is polled
   * instead (`capabilities().webhooks` is then false, and every delivery fails `verify`).
   */
  webhook_secret: nonEmptyStringSchema.nullish(),
  /** Project keys this binding reads. Empty means "whatever the webhook and the JQL deliver". */
  project_keys: z.array(nonEmptyStringSchema).default([]),
  /**
   * The pick-up rule a **webhook** announces a match with (product/08: a label or a mapped
   * status). The polling path takes its rule from the caller instead — `matchTickets(rule)`.
   *
   * `pickup_status` wins when both are set, because a status is the narrower statement: a project
   * that moves tickets into "Ready for agent" has said when the ticket is ready, where a label can
   * sit on a ticket for weeks before it is. Both empty means this binding announces no matches by
   * webhook and is polled for them.
   */
  pickup_label: nonEmptyStringSchema.nullish().default('agentic'),
  pickup_status: nonEmptyStringSchema.nullish().default(null),
  /** Replay window for inbound deliveries; see `webhook.ts` for why the default is a day. */
  webhook_max_age_ms: z.int().positive().default(DEFAULT_WEBHOOK_MAX_AGE_MS),
  /** Per-attempt HTTP timeout. Retries are the executor's, not the client's. */
  request_timeout_ms: z.int().positive().default(20_000),
});

export type JiraCloudConfig = z.infer<typeof jiraCloudConfigSchema>;

export const JIRA_CLOUD_SECRET_FIELDS = ['api_token', 'webhook_secret'] as const;
