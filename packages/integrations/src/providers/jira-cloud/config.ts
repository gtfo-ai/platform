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
import {
  DEFAULT_TICKET_POLL_INTERVAL_SECONDS,
  MAX_TICKET_POLL_INTERVAL_SECONDS,
  MIN_TICKET_POLL_INTERVAL_SECONDS,
} from '@platform/application';
import {
  httpUrlSchema,
  LIFECYCLE_SINGLE_SLOTS,
  lifecycleStatusKey,
  nonEmptyStringSchema,
  ticketLifecycleSchema,
} from '@platform/contracts';
import * as z from 'zod';
import { DEFAULT_WEBHOOK_MAX_AGE_MS } from './webhook.js';

export const jiraCloudConfigSchema = z
  .strictObject({
    /**
     * `https://acme-example.atlassian.net`.
     *
     * `httpUrlSchema` rather than the shared `urlSchema` since WP-51: that one is `z.url()`, which
     * accepts `javascript:`, `data:`, `vbscript:` and `file:` (Q49), and this value is handed to the
     * client this binding's API token is built into. The **host** is the other half and is not a
     * schema's to know: it is checked against `APP_INTEGRATION_HOSTS` when the row is written and
     * again when the call is made (`createIntegrationEgressPolicy`).
     */
    site_url: httpUrlSchema,
    /** The Atlassian account the API token belongs to. */
    user_email: z.email(),
    /** Secret. An Atlassian API token, never a password. */
    api_token: nonEmptyStringSchema,
    /**
     * Secret. The webhook's secret token; `null` when this binding has no webhook
     * (`capabilities().webhooks` is then false, and every delivery fails `verify`). **Such a binding
     * starts tickets only if it polls** (`poll_enabled`, WP-87): without either, nothing tells the
     * platform a ticket is ready. Reads and writes the pipeline makes through it work either way.
     */
    webhook_secret: nonEmptyStringSchema.nullish(),
    /** Project keys this binding reads. Empty means "whatever the webhook and the JQL deliver". */
    project_keys: z.array(nonEmptyStringSchema).default([]),
    /**
     * The pick-up rule a webhook announces a match with **and** the rule the ticket poller asks
     * `matchTickets` for (product/08: a label or a mapped status; WP-87), so a polled match and a
     * webhook match mean one thing. `matchTickets(rule)` itself takes its rule from the caller — the
     * poller passes this one through `pollPlan()`, and the history bootstrap passes its own.
     *
     * `pickup_status` wins when both are set, because a status is the narrower statement: a project
     * that moves tickets into "To pick up" has said when the ticket is ready, where a label can
     * sit on a ticket for weeks before it is. Both empty means this binding picks up no ticket, by
     * webhook or by poll (`pollPlan()` is then `null` even with `poll_enabled`).
     */
    pickup_label: nonEmptyStringSchema.nullish().default('agentic'),
    /**
     * The lifecycle's **`pick_up_from`** slot (TD-029 decision 1): it stays here, beside `lifecycle`,
     * rather than moving into the block, so a binding written before M10 means what it meant.
     */
    pickup_status: nonEmptyStringSchema.nullish().default(null),
    /**
     * The project's ticket lifecycle (BD-031, TD-029 decision 1, WP-172 criterion 6) — **the**
     * `ticketLifecycleSchema` of `@platform/contracts`, embedded rather than re-declared, so a slot
     * added there is a slot this binding accepts. Absent means no slot is mapped and nothing claims
     * (the block's own docblock). A slot that names `pickup_status` is refused below, compared as the
     * block compares its own slots (`lifecycleStatusKey`).
     */
    lifecycle: ticketLifecycleSchema.optional(),
    /**
     * Whether this binding **polls** for tickets (WP-87, technical/06 § "Inbound: webhooks and
     * polling") — off by default, and the switch an operator with no public URL turns on instead of
     * the webhook, or beside it as a safety net: a polled match is deduplicated against a webhook
     * match of the same ticket, so both together never start it twice. The key's name is the
     * platform's (`TICKET_POLL_CONFIG_KEYS`), because the poll sweep reads it without building this
     * adapter.
     */
    poll_enabled: z.boolean().default(false),
    /** Seconds between two polls of this binding; product/08's 60 by default. */
    poll_interval_seconds: z
      .int()
      .min(MIN_TICKET_POLL_INTERVAL_SECONDS)
      .max(MAX_TICKET_POLL_INTERVAL_SECONDS)
      .default(DEFAULT_TICKET_POLL_INTERVAL_SECONDS),
    /** Replay window for inbound deliveries; see `webhook.ts` for why the default is a day. */
    webhook_max_age_ms: z.int().positive().default(DEFAULT_WEBHOOK_MAX_AGE_MS),
    /** Per-attempt HTTP timeout. Retries are the executor's, not the client's. */
    request_timeout_ms: z.int().positive().default(20_000),
  })
  .superRefine((binding, ctx) => {
    const pickup = binding.pickup_status;
    const lifecycle = binding.lifecycle;
    if (typeof pickup !== 'string' || lifecycle === undefined) {
      return;
    }
    const pickupKey = lifecycleStatusKey(pickup);
    for (const slot of LIFECYCLE_SINGLE_SLOTS) {
      const name = lifecycle[slot];
      if (name !== undefined && lifecycleStatusKey(name) === pickupKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifecycle', slot],
          message: `the ${slot} slot names the status pickup_status (the pick_up_from slot) names; each slot is a different status`,
        });
      }
    }
    for (const [index, name] of (lifecycle.returned ?? []).entries()) {
      if (lifecycleStatusKey(name) === pickupKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifecycle', 'returned', index],
          message: `returned[${index}] names the status pickup_status (the pick_up_from slot) names; a returned status is never another slot's`,
        });
      }
    }
  });

export type JiraCloudConfig = z.infer<typeof jiraCloudConfigSchema>;

export const JIRA_CLOUD_SECRET_FIELDS = ['api_token', 'webhook_secret'] as const;
