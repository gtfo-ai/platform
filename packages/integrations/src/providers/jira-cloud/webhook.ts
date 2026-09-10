/**
 * The inbound half of the Jira Cloud provider: signature verification, the dedup key and the
 * normaliser (technical/06 § "Inbound: webhooks and polling", BD-022, TD-024).
 *
 * ## What Atlassian documents, and where each fact comes from
 *
 * All of it from `https://developer.atlassian.com/cloud/jira/platform/webhooks/` (retrieved
 * 2026-09-10):
 *
 *  - **`X-Hub-Signature`**, "formatted as `method=signature`, as defined by WebSub". The HMAC is
 *    over the payload **bytes**, UTF-8, with the webhook's secret token. The page publishes a test
 *    vector — secret `It's a Secret to Everybody`, payload `Hello World!`, method `sha256`,
 *    signature `sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9` — and
 *    `webhook.test.ts` asserts this implementation reproduces it. That is the one part of this
 *    file that is verified against Atlassian's own arithmetic rather than against our reading of
 *    a sentence.
 *  - **`X-Atlassian-Webhook-Identifier`**: "unique within a Jira Cloud tenant and is the same
 *    across retries" — exactly the dedup key `InboundNormaliser.deliveryKey` asks for.
 *  - **The envelope**: `timestamp`, `webhookEvent`, `issue_event_type_name`, `user`, `issue`,
 *    `changelog`, and `comment` for comment events. The `issue` is "the same shape returned from
 *    the Jira REST API when an issue is retrieved with NO expand parameters"; the `user` is the
 *    REST user "without the `locale`, `emailAddress`, `groups` and `applicationRoles` fields" —
 *    so an inbound actor never carries an email, and `resolveUser` sees `email: null`.
 *  - **Event names**: `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted`,
 *    `comment_created`, `comment_updated`, `comment_deleted`, and the rest.
 *
 * Atlassian's own example payload spells the user's account id **`accoundId`**. That is a typo in
 * the documentation (every other user shape in the API spells it `accountId`), so this schema
 * reads `accountId`; the fixture records both the typo and the decision.
 *
 * ## The three questions, and what fails each
 *
 *  1. *Is it authentic?* — `verify`. Constant-time, and false rather than an exception for every
 *     failure mode: no header, an unparsable header, an unsupported method, a wrong-length
 *     signature, a right-length wrong signature, a tampered body, a binding that holds **no
 *     secret at all** (see below), and — see further below — a delivery older than the replay
 *     window.
 *  2. *Have I seen it?* — `deliveryKey`, the identifier header.
 *  3. *What does it mean?* — `normalise`, which either produces catalogue events or says exactly
 *     why it produced none.
 *
 * ### No secret means reject, not "compare against `HMAC('', body)`"
 *
 * A binding configured without `webhook_secret` can verify nothing, and the dangerous way to say
 * that is to hand the verifier an empty key: `HMAC-SHA256('', body)` is a perfectly well-defined
 * digest that **anybody can compute**, so an attacker signs his own forgery with the empty key and
 * `verify` returns true. WP-08 review round 1 forged exactly that. The check therefore lives here,
 * in the function that answers the authenticity question, and not in the caller that consults
 * `capabilities().webhooks` — that wrapper was the only working guard and deleting it killed no
 * test, so it is gone and this is the single authority (standing rules 3 and 9). `webhook.test.ts`
 * drives this function directly with an empty secret, with `null`, and with the field **absent**,
 * which review round 2 found reaching a `TypeError` rather than a refusal.
 *
 * ### The replay window is ours, not Atlassian's
 *
 * Nothing in Jira's scheme binds a signature to a time: a body captured once stays valid for ever,
 * and the identifier header is attacker-controlled, so dedup alone does not stop a replay of a
 * *different* tenant's captured delivery. `verify` therefore also rejects a delivery whose
 * envelope `timestamp` is outside `maxAgeMs` of the injected clock. The default is 24 hours,
 * chosen against Jira's *documented* retry policy — "up to five times … between 5 and 15 minutes
 * after the previous one", and after 30 minutes of failure "a single attempt per webhook until we
 * record a successful delivery" — so a legitimate retry of a delivery the platform was down for is
 * never thrown away, while a captured body stops working the next day. A body with no parsable
 * `timestamp` fails closed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type ExternalIdentity,
  type IgnoredDelivery,
  type InboundContext,
  type InboundNormaliser,
  IntegrationError,
  type NormalisedDelivery,
  type NormalisedEvent,
  type SecretRedactor,
  type TaskManagementInboundEvent,
  type WebhookDelivery,
} from '@platform/application';
import type { JsonObject } from '@platform/contracts';
import type { Clock } from '@platform/domain';
import * as z from 'zod';
import { adfToMarkdown } from './adf.js';
import {
  identityOfUser,
  issueUrl,
  jiraIssueWithUpdatedSchema,
  jiraUserSchema,
  PROVIDER_ID,
  toTicketLinks,
} from './mapping.js';

export const SIGNATURE_HEADER = 'x-hub-signature';
export const DELIVERY_HEADER = 'x-atlassian-webhook-identifier';
export const RETRY_HEADER = 'x-atlassian-webhook-retry';

/** The only HMAC method Jira uses today. The page warns it "might start using another". */
const SUPPORTED_METHOD = 'sha256';

/** 24 hours. See the module docblock for why it is not tighter and not looser. */
export const DEFAULT_WEBHOOK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── 1. Authenticity ──────────────────────────────────────────────────────────

export const signWebhookBody = (secret: string, body: string): string =>
  `${SUPPORTED_METHOD}=${createHmac(SUPPORTED_METHOD, secret).update(body, 'utf8').digest('hex')}`;

/**
 * Compares two signature strings without leaking where they differ.
 *
 * `timingSafeEqual` throws on differing lengths, so the length is compared first — which is not a
 * leak, because the length of a hex SHA-256 digest is public and constant.
 */
const equalsInConstantTime = (provided: string, expected: string): boolean => {
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
};

export interface WebhookVerifierOptions {
  /**
   * `null`, `undefined` or empty is "this binding cannot verify anything", never "verify with no
   * key". All three are one refusing path in {@link verifyJiraDelivery}: a missing credential is
   * no more a credential than an empty one (standing rule 18), and a type is not a boundary
   * (standing rule 14) — a JavaScript caller can omit this field, and used to reach a `TypeError`.
   */
  readonly secret: string | null | undefined;
  readonly clock: Clock;
  readonly maxAgeMs?: number;
}

/** The envelope timestamp, in epoch milliseconds, or `null` when there is not a usable one. */
const timestampOf = (body: string): number | null => {
  try {
    const parsed: unknown = JSON.parse(body);
    const value = (parsed as { timestamp?: unknown } | null)?.timestamp;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
};

export const verifyJiraDelivery = (
  options: WebhookVerifierOptions,
  delivery: WebhookDelivery,
): boolean => {
  const secret = options.secret;
  // `== null` deliberately: absent and null are the same refusal. Fail closed — see the docblock.
  // An empty key is a key the sender owns too, and a missing one is not a key at all.
  if (secret == null || secret.length === 0) {
    return false;
  }
  const provided = delivery.headers[SIGNATURE_HEADER];
  if (typeof provided !== 'string' || provided.length === 0) {
    return false;
  }
  const [method] = provided.split('=', 1);
  if (method !== SUPPORTED_METHOD) {
    return false;
  }
  if (!equalsInConstantTime(provided, signWebhookBody(secret, delivery.body))) {
    return false;
  }
  const sentAt = timestampOf(delivery.body);
  if (sentAt === null) {
    return false;
  }
  const age = Date.parse(options.clock.now()) - sentAt;
  return age <= (options.maxAgeMs ?? DEFAULT_WEBHOOK_MAX_AGE_MS) && age >= -60_000;
};

// ── 2. Identity of the delivery ──────────────────────────────────────────────

/**
 * The dedup key: `jira-cloud:<the delivery identifier header>`.
 *
 * **It is a header value, and a header value is provider text** (BD-022) that this function copies
 * verbatim into a string the platform stores and compares. Nothing else in this adapter emits a
 * header, and until review round 2 nothing redacted one either — which is how "the redactor covers
 * everything the adapter emits" was true of every body and false of the one field taken off a
 * header. The redactor is required rather than optional for the reason standing rule 31 names: an
 * optional security dependency is an absent one.
 *
 * The refusal quotes only the constant header **name**, so it needs no pass of its own.
 */
export const jiraDeliveryKey = (delivery: WebhookDelivery, redactor: SecretRedactor): string => {
  const identifier = delivery.headers[DELIVERY_HEADER];
  if (typeof identifier !== 'string' || identifier.length === 0) {
    throw new IntegrationError(
      'invalid_request',
      PROVIDER_ID,
      `delivery carries no ${DELIVERY_HEADER} header`,
      { action: 'delivery_key' },
    );
  }
  return redactor.redactText(`${PROVIDER_ID}:${identifier}`).value;
};

// ── 3. Meaning ───────────────────────────────────────────────────────────────

const changelogItemSchema = z.object({
  field: z.string().optional(),
  fieldId: z.string().optional(),
  fieldtype: z.string().optional(),
  from: z.string().nullish(),
  fromString: z.string().nullish(),
  to: z.string().nullish(),
  toString: z.string().nullish(),
});

const commentSchema = z.object({
  id: z.string().min(1),
  author: jiraUserSchema.optional(),
  body: z.unknown().optional(),
});

/** The documented envelope. `issue` is required for every event this normaliser handles. */
export const jiraWebhookEnvelopeSchema = z.object({
  timestamp: z.number(),
  webhookEvent: z.string().min(1),
  issue_event_type_name: z.string().optional(),
  user: jiraUserSchema.optional(),
  issue: jiraIssueWithUpdatedSchema.optional(),
  comment: commentSchema.optional(),
  changelog: z
    .object({
      id: z.union([z.string(), z.number()]).optional(),
      items: z.array(changelogItemSchema).default([]),
    })
    .optional(),
});
export type JiraWebhookEnvelope = z.infer<typeof jiraWebhookEnvelopeSchema>;

/** The pick-up rule a binding polls with, reused to recognise a match arriving by webhook. */
export type JiraPickupRule =
  | { readonly kind: 'label'; readonly label: string }
  | { readonly kind: 'status'; readonly status: string }
  | { readonly kind: 'none' };

export interface JiraNormaliserOptions {
  readonly siteUrl: string;
  /** Empty means "every project this webhook is registered for". */
  readonly projectKeys: readonly string[];
  readonly pickup: JiraPickupRule;
  /**
   * TD-012, **required** (standing rules 31 and 35), applied to the whole delivery **before any
   * branch reads it**.
   *
   * A delivery is the one Jira document that does not cross `client.ts`, and it is the one whose
   * text is appended to `events.payload` — append-only (BD-003), so an unredacted write cannot be
   * corrected afterwards. `IgnoredDelivery.detail` carries the same obligation and states it in
   * `common.ts`; the details built below quote `webhookEvent`, an issue key and a changelog field
   * list, all of them provider text.
   */
  readonly redactor: SecretRedactor;
  /** Where a redaction count is reported. The redacted text is never reported (TD-012). */
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
}

const ignored = (
  reason: IgnoredDelivery['reason'],
  detail: string,
): NormalisedDelivery<TaskManagementInboundEvent> => ({
  events: [],
  ignored: [{ reason, detail }],
});

const projectKeyOf = (issueKey: string): string => issueKey.split('-')[0] ?? issueKey;

const labelsAddedBy = (envelope: JiraWebhookEnvelope): readonly string[] => {
  const item = (envelope.changelog?.items ?? []).find((entry) => entry.field === 'labels');
  if (item === undefined) {
    return [];
  }
  const before = new Set((item.fromString ?? '').split(/\s+/).filter((label) => label.length > 0));
  return (item.toString ?? '')
    .split(/\s+/)
    .filter((label) => label.length > 0 && !before.has(label));
};

const statusChangeOf = (
  envelope: JiraWebhookEnvelope,
): { readonly from: string; readonly to: string } | null => {
  const item = (envelope.changelog?.items ?? []).find((entry) => entry.field === 'status');
  if (item === undefined) {
    return null;
  }
  return { from: item.fromString ?? '', to: item.toString ?? '' };
};

export const createJiraInboundNormaliser = (
  options: JiraNormaliserOptions & WebhookVerifierOptions,
): InboundNormaliser<TaskManagementInboundEvent> => {
  const { siteUrl, projectKeys, pickup } = options;

  const matchedEvent = (
    issue: NonNullable<JiraWebhookEnvelope['issue']>,
    context: InboundContext,
    rule: string,
  ): NormalisedEvent<'ticket.matched'> => {
    return {
      type: 'ticket.matched',
      payload: {
        project_id: context.projectId,
        ticket: { provider: PROVIDER_ID, key: issue.key, url: issueUrl(siteUrl, issue.key) },
        rule,
        priority: issue.fields.priority?.name ?? null,
        issue_type: issue.fields.issuetype?.name ?? null,
        epic: issue.fields.parent?.key ?? null,
        links: toTicketLinks(issue, siteUrl).map((link) => ({
          kind: link.kind,
          key: link.key,
          url: link.url ?? null,
        })),
      },
      actor: {
        kind: 'integration',
        integration_id: context.integrationId,
        provider: PROVIDER_ID,
      },
    };
  };

  /**
   * Does this delivery *announce* that the ticket now matches the binding's pick-up rule?
   *
   * "Now" is the load-bearing word. A ticket that already carried the label yesterday produces an
   * `jira:issue_updated` every time anyone touches it, and treating each of those as a match would
   * re-run intake for ever. So a match is either the ticket being **created** already matching, or
   * the change itself being what made it match.
   */
  const pickupRuleHit = (
    issue: NonNullable<JiraWebhookEnvelope['issue']>,
    envelope: JiraWebhookEnvelope,
  ): string | null => {
    if (pickup.kind === 'none') {
      return null;
    }
    const created = envelope.webhookEvent === 'jira:issue_created';
    if (pickup.kind === 'label') {
      const has = (issue.fields.labels ?? []).includes(pickup.label);
      const added = labelsAddedBy(envelope).includes(pickup.label);
      return (created && has) || added ? `label = "${pickup.label}"` : null;
    }
    const status = statusChangeOf(envelope);
    const nowIn = issue.fields.status?.name === pickup.status;
    return (created && nowIn) || status?.to === pickup.status
      ? `status = "${pickup.status}"`
      : null;
  };

  const normalise = async (
    delivery: WebhookDelivery,
    context: InboundContext,
  ): Promise<NormalisedDelivery<TaskManagementInboundEvent>> => {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(delivery.body);
    } catch {
      // The message is a constant, and that is the fix rather than an omission: V8 quotes the
      // offending input in a `SyntaxError` (`Unexpected token 'F', "FAKE-plant"… is not valid
      // JSON`), so the old `body is not JSON: ${error.message}` put a **fragment** of the delivery
      // into `inbox.error` — and a fragment is what no exact-match redactor can find afterwards.
      return ignored('malformed_payload', 'body is not JSON');
    }
    const redacted = options.redactor.redactJson({ body: parsedBody } as unknown as JsonObject);
    if (redacted.count > 0) {
      options.onRedaction?.({ action: 'normalise_delivery', count: redacted.count });
    }
    const envelope = jiraWebhookEnvelopeSchema.safeParse(
      (redacted.value as { body: unknown }).body,
    );
    if (!envelope.success) {
      const issue = envelope.error.issues[0];
      return ignored(
        'malformed_payload',
        `${issue?.path.join('.') ?? '<root>'}: ${issue?.message ?? 'failed validation'}`,
      );
    }
    const body = envelope.data;
    const issue = body.issue;
    if (issue === undefined) {
      return ignored('malformed_payload', `${body.webhookEvent} carried no issue`);
    }
    // The other place in this adapter where "unset" widens rather than narrows, audited in round 2
    // alongside the secret: an empty `project_keys` accepts every project. It is a **scope** filter
    // and not an authenticity one — a delivery only reaches here after `verify` has matched it
    // against this binding's own secret, so the widest it can be is "every project on the site this
    // binding is bound to", which is what `config.ts` says it means.
    if (projectKeys.length > 0 && !projectKeys.includes(projectKeyOf(issue.key))) {
      return ignored('not_for_this_project', `${issue.key} is not in a project this binding reads`);
    }

    const ticket = { provider: PROVIDER_ID, key: issue.key, url: issueUrl(siteUrl, issue.key) };
    const events: NormalisedEvent<TaskManagementInboundEvent>[] = [];

    if (body.webhookEvent === 'comment_created') {
      const comment = body.comment;
      if (comment === undefined) {
        return ignored('malformed_payload', 'comment_created carried no comment');
      }
      const identity: ExternalIdentity = identityOfUser(comment.author ?? body.user) ?? {
        provider: PROVIDER_ID,
        external_id: 'unknown',
        email: null,
        display_name: null,
        verified: false,
      };
      // BD-022: `verified` means "maps to a platform user", which only the resolver knows. The
      // comment is recorded either way — it is data, not a decision (Q10).
      const author: ExternalIdentity = {
        ...identity,
        verified: context.resolveUser(identity) !== null,
      };
      events.push({
        type: 'ticket.comment.added',
        payload: {
          project_id: context.projectId,
          task_id: null,
          ticket,
          comment_id: comment.id,
          author,
          text: adfToMarkdown(comment.body),
        },
        actor: {
          kind: 'integration',
          integration_id: context.integrationId,
          provider: PROVIDER_ID,
          identity: author,
        },
      });
      return { events, ignored: [] };
    }

    if (body.webhookEvent === 'jira:issue_updated' || body.webhookEvent === 'jira:issue_created') {
      const rule = pickupRuleHit(issue, body);
      if (rule !== null) {
        events.push(matchedEvent(issue, context, rule));
      }
      const status = statusChangeOf(body);
      if (status !== null) {
        events.push({
          type: 'ticket.status.changed',
          payload: {
            project_id: context.projectId,
            task_id: null,
            ticket,
            from: status.from,
            to: status.to,
          },
          actor: {
            kind: 'integration',
            integration_id: context.integrationId,
            provider: PROVIDER_ID,
            identity: identityOfUser(body.user),
          },
        });
      }
      if (events.length === 0) {
        return ignored(
          'unsupported_event',
          `${body.webhookEvent} changed nothing this binding acts on ` +
            `(${(body.changelog?.items ?? []).map((item) => item.field ?? '?').join(', ') || 'no changelog'})`,
        );
      }
      return { events, ignored: [] };
    }

    return ignored('unsupported_event', `${body.webhookEvent} is not handled by this provider`);
  };

  return {
    verify: (delivery) => verifyJiraDelivery(options, delivery),
    deliveryKey: (delivery) => jiraDeliveryKey(delivery, options.redactor),
    normalise,
  };
};
