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
 * `JIRA_USER_EMAIL`, `JIRA_CLOUD_ID`, `JIRA_API_TOKEN` (+ `_FILE`), `JIRA_WEBHOOK_SECRET`
 * (+ `_FILE`) — and the setup guide maps them onto these fields.
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

/** The longest label this binding accepts (Jira's label field is bounded at 255 characters). */
export const MAX_JIRA_LABEL_LENGTH = 255;

/**
 * A site's **cloud ID** (`GET https://<site>.atlassian.net/_edge/tenant_info` answers it as
 * `cloudId`): a UUID, hex digits in the 8-4-4-4-12 groups and nothing else. It is interpolated into
 * the path of every URL this binding's credential is sent to (`jiraApiBaseUrl`), so the shape is
 * refused here rather than escaped there: no `/`, `?`, `#`, `.` or `%` can reach that path.
 */
export const jiraCloudIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message:
      'a Jira cloud ID is a UUID such as 1a11d016-8984-4c3e-b9ab-142dd06acb1b (https://<site>.atlassian.net/_edge/tenant_info answers it as cloudId)',
  });

/**
 * The Atlassian API gateway's host (`https://api.atlassian.com/ex/jira/<cloudId>/…`): where every
 * call goes when the binding names a `cloud_id`. An Atlassian **service account's** scoped API token
 * is accepted only there, never on `<site>.atlassian.net` — "Tokens must always use the Platform API
 * Gateway URLs beginning with `api.atlassian.com`" (support.atlassian.com, *Manage API tokens for
 * service accounts*, retrieved 2026-11-25).
 */
export const JIRA_API_GATEWAY_HOST = 'api.atlassian.com';

/**
 * The REST v3 root every call of this binding is addressed to, with its trailing slash — the one
 * answer to "where does this binding call", so the client's base URL, the host the executor's
 * egress allow-list judges (`IntegrationRef.host`) and the host a refused body names cannot
 * disagree.
 *
 *  - no `cloud_id`: `<site_url>/rest/api/3/`, as every binding before service accounts;
 *  - a `cloud_id`: `https://api.atlassian.com/ex/jira/<cloud_id>/rest/api/3/`.
 *
 * Links a person opens (a ticket, a comment) are **not** built from this: they stay on `site_url`.
 */
export const jiraApiBaseUrl = (config: Pick<JiraCloudConfig, 'site_url' | 'cloud_id'>): string =>
  typeof config.cloud_id === 'string'
    ? `https://${JIRA_API_GATEWAY_HOST}/ex/jira/${config.cloud_id.toLowerCase()}/rest/api/3/`
    : `${config.site_url.replace(/\/+$/, '')}/rest/api/3/`;

/**
 * The URLs a configuration document makes this provider call that are **not** written in it as a
 * URL — read by the write-time host check (`ProviderCatalogueEntry.derivedEgressUrlsOf`), whose
 * sweep only sees strings that parse as one. A `cloud_id` is a UUID, so without this the create would
 * admit a gateway binding on a deployment that never declared `api.atlassian.com`, and the operator
 * would learn it from the first failed call instead of from the form.
 *
 * Over an **unvalidated** document (the write checks hosts before it parses), so any non-empty
 * string counts: the host it implies is the gateway's whatever the value, and the parse refuses a
 * malformed one right after.
 */
export const jiraDerivedEgressUrls = (config: Readonly<Record<string, unknown>>): string[] =>
  typeof config.cloud_id === 'string' && config.cloud_id.trim() !== ''
    ? [`https://${JIRA_API_GATEWAY_HOST}/`]
    : [];

/**
 * A Jira label: Jira does not accept a label containing a space, so a label with any whitespace
 * is refused here, when the binding is saved, rather than by the tracker at the first claim.
 */
export const jiraLabelSchema = z
  .string()
  .min(1)
  .max(MAX_JIRA_LABEL_LENGTH)
  .regex(/^\S+$/, { message: 'a Jira label cannot contain spaces' });

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
    /**
     * The Atlassian account the API token belongs to — a person-shaped bot account, or an
     * Atlassian **service account** (`…@serviceaccount.atlassian.com`). Required in both modes:
     * the client always sends `Basic base64(user_email:api_token)` (`client.ts`).
     */
    user_email: z.email(),
    /**
     * The site's cloud ID; set it for an Atlassian **service account** (`setup-guide.md` § "Service
     * account"). Absent (the default), calls go to `site_url` as they always have. Present, every
     * REST call goes to the API gateway, `https://api.atlassian.com/ex/jira/<cloud_id>/rest/api/3/`,
     * because a service account's scoped token is refused anywhere else — and the links a person
     * opens still use `site_url`. The deployment must then declare `api.atlassian.com` in
     * `APP_INTEGRATION_HOSTS`.
     */
    cloud_id: jiraCloudIdSchema.nullish().default(null),
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
     * The label the platform puts on a ticket **while a task holds it** (BACKLOG 1611): added when
     * the task claims the ticket, removed when it releases it, so a person reading Jira sees that the
     * platform **owns** it — a task is open for it, running or waiting for a person; it never says an
     * agent is running now. Off (`null`) by default. One edit-issue `update` operation, never a
     * rewrite of the ticket's labels, so every other label stays as it is.
     *
     * Never the pick-up label (refused below, compared case-insensitively as JQL compares labels): a
     * label the claim adds must not be a label the pick-up rule matches on.
     */
    claim_label: jiraLabelSchema.nullish().default(null),
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
    if (
      typeof binding.claim_label === 'string' &&
      typeof binding.pickup_label === 'string' &&
      binding.claim_label.toLowerCase() === binding.pickup_label.toLowerCase()
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['claim_label'],
        message:
          'claim_label names the label pickup_label names; the label a claim adds cannot be the label tickets are picked up by — choose another (e.g. "agentic-owned")',
      });
    }
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
    // S-28.4: `pickup_status` always starts work, so it cannot also mean a ticket is finished.
    for (const [index, name] of (lifecycle.closed ?? []).entries()) {
      if (lifecycleStatusKey(name) === pickupKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifecycle', 'closed', index],
          message: `closed[${index}] names the status pickup_status names; the status work is picked up from cannot also mean a ticket is finished`,
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
    // TD-029 amendment G (S-28.24): a status that passes QA is not the one work is picked up from.
    for (const [index, name] of (lifecycle.qa_pass ?? []).entries()) {
      if (lifecycleStatusKey(name) === pickupKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifecycle', 'qa_pass', index],
          message: `qa_pass[${index}] names the status pickup_status (the pick_up_from slot) names; the status work is picked up from cannot also pass QA`,
        });
      }
    }
  });

export type JiraCloudConfig = z.infer<typeof jiraCloudConfigSchema>;

export const JIRA_CLOUD_SECRET_FIELDS = ['api_token', 'webhook_secret'] as const;
