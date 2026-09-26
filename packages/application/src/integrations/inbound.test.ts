/**
 * The webhook ingress: the four questions, in order, and what each refusal costs (WP-15c).
 *
 * Every collaborator here is a double **except the thing under test**, and two of them are written
 * to be *stricter* than production rather than kinder (standing rule 1): the inbox double enforces
 * the primary key, and the redactor double reports its count rather than returning zero.
 *
 * What this file cannot show, and what covers it instead: that a **real** provider's signature check
 * refuses a real forgery (`test/integration/integrations/webhook-ingress.integration.test.ts`, and
 * each provider's own `webhook*.test.ts`); that the redaction reaches a real `inbox` row (the same
 * integration file, on a live `X-Gitlab-Token`); and that a delivery drives a task to completion
 * (`test/e2e/pipeline/webhook-ingress.e2e.test.ts`).
 */
import type { Id, IsoDateTime, JsonObject } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { StreamConflictError } from '../errors.js';
import type { RedactionOutcome, SecretRedactor } from '../ports/integrations/audit.js';
import type {
  InboundContext,
  InboundNormaliser,
  NormalisedDelivery,
  WebhookDelivery,
} from '../ports/integrations/common.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type {
  InboundAuditLog,
  InboundDeliveryRecord,
  InboundIntegrationLoader,
  InboxDelivery,
  InboxStore,
  ResolvedInboundIntegration,
} from '../ports/integrations/inbox.js';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import { createWebhookIngress, MAX_INBOX_ERROR_CHARS } from './inbound.js';
import type { InboundDecisionApplier, InboundDecisionOutcome } from './inbound-decisions.js';

const INTEGRATION = '00000000-0000-4000-8000-0000000000c1' as Id;
const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000b2' as Id;
const NOW = '2026-06-01T10:30:00.000Z' as IsoDateTime;

/** Obviously fake, and the value every redaction assertion below looks for. */
const BINDING_SECRET = 'FAKE-PLANTED-webhook-secret-0123456789';
const PLACEHOLDER = '[REDACTED:integration:fake:secret]';

const ticketMatched = (projectId: Id) => ({
  type: 'ticket.matched' as const,
  payload: {
    project_id: projectId,
    ticket: { provider: 'fake', key: 'ACME-1', url: 'https://tickets.example.test/ACME-1' },
    rule: 'label = "agentic"',
    priority: null,
    issue_type: 'Story',
    epic: null,
    links: [],
  },
  actor: { kind: 'integration' as const, integration_id: INTEGRATION, provider: 'fake' },
});

// ── Doubles ──────────────────────────────────────────────────────────────────

/** Exact-match over one planted secret, counting every hit — the shape TD-012 step 1 has. */
const redactorDouble = (): SecretRedactor => {
  const redactText = (text: string): RedactionOutcome<string> => {
    const parts = text.split(BINDING_SECRET);
    return { value: parts.join(PLACEHOLDER), count: parts.length - 1 };
  };
  const walk = (value: unknown): { value: unknown; count: number } => {
    if (typeof value === 'string') {
      return redactText(value);
    }
    if (Array.isArray(value)) {
      let count = 0;
      const out = value.map((item) => {
        const redacted = walk(item);
        count += redacted.count;
        return redacted.value;
      });
      return { value: out, count };
    }
    if (value !== null && typeof value === 'object') {
      let count = 0;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const redacted = walk(item);
        count += redacted.count;
        out[key] = redacted.value;
      }
      return { value: out, count };
    }
    return { value, count: 0 };
  };
  return {
    redactText,
    redactJson: (value: JsonObject) => {
      const redacted = walk(value);
      return { value: redacted.value as JsonObject, count: redacted.count };
    },
  };
};

interface NormaliserScript {
  readonly verify?: boolean;
  readonly key?: string | Error;
  readonly result?: (context: InboundContext) => NormalisedDelivery;
  /** What `verify` was handed, so a test can prove it saw the *unredacted* bytes. */
  readonly seen?: { delivery?: WebhookDelivery };
}

const normaliserDouble = (script: NormaliserScript = {}): InboundNormaliser => ({
  verify: (delivery) => {
    if (script.seen !== undefined) {
      script.seen.delivery = delivery;
    }
    return script.verify ?? true;
  },
  deliveryKey: (_delivery) => {
    if (script.key instanceof Error) {
      throw script.key;
    }
    return script.key ?? 'fake:d-1';
  },
  normalise: async (_delivery, context) =>
    script.result?.(context) ?? { events: [ticketMatched(context.projectId)], ignored: [] },
});

/** Enforces the primary key, because that is what makes the insert the dedup arbiter. */
const inboxDouble = () => {
  const rows = new Map<string, InboxDelivery>();
  /** Which transaction wrote each row, so a rollback removes its own and nobody else's. */
  const owners = new Map<string, Transaction>();
  let conflictsLeft = 0;
  const store: InboxStore = {
    record: async (tx: Transaction, delivery: InboxDelivery) => {
      const key = `${delivery.provider} ${delivery.deliveryId}`;
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, delivery);
      owners.set(key, tx);
      return true;
    },
    find: async (provider, deliveryId) => rows.get(`${provider} ${deliveryId}`) ?? null,
  };
  return {
    store,
    rows,
    rollback: (tx: Transaction) => {
      for (const [key, owner] of owners) {
        if (owner === tx) {
          rows.delete(key);
          owners.delete(key);
        }
      }
    },
    only: (): InboxDelivery => {
      const [first] = [...rows.values()];
      if (first === undefined) {
        throw new Error('no inbox row was written');
      }
      return first;
    },
    failNextAppends: (times: number) => {
      conflictsLeft = times;
    },
    takeConflict: (): boolean => {
      if (conflictsLeft <= 0) {
        return false;
      }
      conflictsLeft -= 1;
      return true;
    },
  };
};

const auditDouble = () => {
  const entries: InboundDeliveryRecord[] = [];
  const log: InboundAuditLog = {
    record: async (entry) => {
      entries.push(entry);
    },
  };
  return { log, entries };
};

/**
 * The aggregate half, as a double that records what it was asked and **writes into the same
 * transaction the inbox row does** — so a rolled-back race takes its write with it, which is the
 * property the ordering in `inbound.ts` exists for.
 */
const decisionsDouble = (answer: (projectId: Id) => InboundDecisionOutcome) => {
  const applied: { projectId: Id; type: string }[] = [];
  const applier: InboundDecisionApplier = {
    apply: async (_tx, { projectId, draft }) => {
      applied.push({ projectId, type: draft.type });
      return answer(projectId);
    },
  };
  return { applier, applied };
};

const approvalDecided = (projectId: Id) => ({
  type: 'task.approval.decided' as const,
  payload: {
    project_id: projectId,
    task_id: '00000000-0000-4000-8000-0000000000e1',
    approval_id: '00000000-0000-4000-8000-0000000000e2',
    decision: 'approved' as const,
    decided_by_user_id: '00000000-0000-4000-8000-0000000000e3',
    reason: null,
  },
  actor: {
    kind: 'user' as const,
    user_id: '00000000-0000-4000-8000-0000000000e3' as Id,
    identity: {
      provider: 'fake',
      external_id: 'U-1',
      email: null,
      display_name: null,
      verified: true,
    },
  },
});

/** What the approval aggregate would have appended, on its own stream. */
const aggregateEvent = {
  type: 'task.approval.decided',
  payload: { decided_by: 'the aggregate' },
  stream_id: '00000000-0000-4000-8000-0000000000e2',
  stream_seq: 2,
};

interface IngressHarness {
  readonly deliver: (delivery?: WebhookDelivery) => ReturnType<ReturnType<typeof build>['deliver']>;
  readonly inbox: ReturnType<typeof inboxDouble>;
  readonly audit: ReturnType<typeof auditDouble>;
  readonly appended: { type: string; payload: unknown; stream_id: string; stream_seq: number }[];
  readonly sequenceReads: number[];
}

const DELIVERY: WebhookDelivery = {
  headers: { 'x-provider-token': BINDING_SECRET, 'content-type': 'application/json' },
  body: JSON.stringify({ event: 'ticket.matched', note: `signed with ${BINDING_SECRET}` }),
};

const build = (options: {
  readonly resolved?: ResolvedInboundIntegration | null;
  readonly inbox: ReturnType<typeof inboxDouble>;
  readonly audit: ReturnType<typeof auditDouble>;
  readonly appended: IngressHarness['appended'];
  readonly sequenceReads: number[];
  readonly decisions?: InboundDecisionApplier;
}) => {
  let nextId = 0;
  const loader: InboundIntegrationLoader = {
    forIntegration: async () => options.resolved ?? null,
  };
  /**
   * A transaction that really rolls back — the double is **stricter** than a Map would be, and it
   * has to be (standing rule 1).
   *
   * The whole point of writing the inbox row inside the transaction that appends the events is that
   * a failed append un-writes the row. A double that kept the row would make a retry look like a
   * redelivery, which is exactly the bug this shape exists to prevent, and the test would pass
   * while asserting the opposite.
   */
  const unitOfWork: UnitOfWork = {
    transaction: async (fn) => {
      // One handle per transaction, so a rollback un-writes exactly what *this* one wrote — two
      // racing deliveries each own their writes, as two database transactions would.
      const tx = { adapter: 'memory' } as Transaction;
      const mine: IngressHarness['appended'][number][] = [];
      const scope = {
        tx,
        events: {
          append: async (events: readonly { type: string; payload: unknown }[]) => {
            if (options.inbox.takeConflict()) {
              throw new StreamConflictError('project', PROJECT, 1);
            }
            for (const event of events) {
              mine.push(event as IngressHarness['appended'][number]);
              options.appended.push(event as IngressHarness['appended'][number]);
            }
            return [];
          },
        },
      } as unknown as TransactionScope;
      try {
        return await fn(scope);
      } catch (error) {
        options.inbox.rollback(tx);
        for (const event of mine) {
          options.appended.splice(options.appended.indexOf(event), 1);
        }
        throw error;
      }
    },
  };
  return createWebhookIngress({
    loader,
    inbox: options.inbox.store,
    audit: options.audit.log,
    identities: { forProvider: async () => new Map([['U-1', PROJECT]]) },
    decisions:
      options.decisions ??
      decisionsDouble(() => {
        throw new Error('this test produced no decision, so the applier must not be asked');
      }).applier,
    unitOfWork,
    eventStore: {
      nextStreamSequence: async () => {
        options.sequenceReads.push(options.sequenceReads.length + 1);
        return 7;
      },
    },
    ids: {
      next: () => {
        nextId += 1;
        return `00000000-0000-4000-9000-${String(nextId).padStart(12, '0')}` as Id;
      },
    },
    clock: { now: () => NOW },
    timer: { now: () => 0 },
  });
};

const harnessFor = (
  resolved: ResolvedInboundIntegration | null,
  overrides: { readonly conflicts?: number; readonly decisions?: InboundDecisionApplier } = {},
): IngressHarness => {
  const inbox = inboxDouble();
  const audit = auditDouble();
  const appended: IngressHarness['appended'] = [];
  const sequenceReads: number[] = [];
  if (overrides.conflicts !== undefined) {
    inbox.failNextAppends(overrides.conflicts);
  }
  const ingress = build({
    resolved,
    inbox,
    audit,
    appended,
    sequenceReads,
    ...(overrides.decisions === undefined ? {} : { decisions: overrides.decisions }),
  });
  return {
    deliver: (delivery = DELIVERY) =>
      ingress.deliver({ provider: 'fake', integrationId: INTEGRATION, delivery }),
    inbox,
    audit,
    appended,
    sequenceReads,
  };
};

const resolvedWith = (
  script: NormaliserScript = {},
  bindings: readonly { projectId: Id; script?: NormaliserScript }[] = [{ projectId: PROJECT }],
): ResolvedInboundIntegration => ({
  ref: { integrationId: INTEGRATION, provider: 'fake', type: 'task_management', host: null },
  inbound: normaliserDouble(script),
  bindings: bindings.map((binding, index) => ({
    bindingId: `00000000-0000-4000-8000-00000000d00${index}` as Id,
    projectId: binding.projectId,
    inbound: normaliserDouble(binding.script ?? script),
  })),
  redactor: redactorDouble(),
});

// ── 1. Which binding? ────────────────────────────────────────────────────────

describe('an integration nobody has', () => {
  it('writes nothing at all, because there is no row an audit could reference', async () => {
    const harness = harnessFor(null);
    expect(await harness.deliver()).toEqual({ kind: 'unknown_integration' });
    expect(harness.inbox.rows.size).toBe(0);
    expect(harness.audit.entries).toEqual([]);
  });
});

describe('a delivery addressed to the wrong provider', () => {
  it('is refused and audited rather than normalised by whatever the row says', async () => {
    const resolved = resolvedWith();
    const harness = harnessFor({
      ...resolved,
      ref: { ...resolved.ref, provider: 'other-provider' },
    });
    const outcome = await harness.deliver();
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'provider_mismatch' });
    expect(harness.inbox.rows.size).toBe(0);
    expect(harness.audit.entries[0]?.status).toBe('refused');
  });
});

describe('a provider with no inbound half', () => {
  it('is refused rather than crashing on an absent normaliser', async () => {
    const resolved = resolvedWith();
    const harness = harnessFor({ ...resolved, inbound: null, bindings: [] });
    expect(await harness.deliver()).toMatchObject({
      kind: 'refused',
      reason: 'unsupported_provider',
    });
    expect(harness.audit.entries[0]?.status).toBe('refused');
  });
});

// ── 2. Is it authentic? ──────────────────────────────────────────────────────

describe('an unverifiable signature', () => {
  it('is refused, audited, and leaves NO inbox row — the dedup key is not an attacker’s to choose', async () => {
    const harness = harnessFor(resolvedWith({ verify: false }));

    const outcome = await harness.deliver();

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unverified' });
    // The load-bearing half. A row here would let anyone who can address the endpoint plant the
    // id a genuine future delivery will carry, and that delivery would then be silently taken for
    // a redelivery and dropped.
    expect(harness.inbox.rows.size, 'an unverified delivery must not occupy a dedup key').toBe(0);
    expect(harness.appended).toEqual([]);
    expect(harness.audit.entries).toHaveLength(1);
    expect(harness.audit.entries[0]).toMatchObject({
      status: 'refused',
      integrationId: INTEGRATION,
      projectId: null,
    });
  });

  it('never reaches the normaliser, so no provider read is made for a forgery', async () => {
    const seen: { delivery?: WebhookDelivery } = {};
    const harness = harnessFor(
      resolvedWith({
        verify: false,
        seen,
        result: () => {
          throw new Error('normalise must not run for an unverified delivery');
        },
      }),
    );
    await harness.deliver();
    expect(seen.delivery).toBeDefined();
  });

  it('verifies the bytes as they arrived, before anything is redacted', async () => {
    const seen: { delivery?: WebhookDelivery } = {};
    const harness = harnessFor(resolvedWith({ seen }));

    await harness.deliver();

    // Redaction is a post-condition of the *store*, never of the check: every scheme in TD-024
    // signs the bytes, so a verifier handed a redacted body would verify a different document.
    expect(seen.delivery?.body).toContain(BINDING_SECRET);
    expect(seen.delivery?.headers['x-provider-token']).toBe(BINDING_SECRET);
  });
});

// ── 3. Which delivery? ───────────────────────────────────────────────────────

describe('a delivery nothing can key', () => {
  it('is received rather than errored, so a vendor does not disable the whole webhook', async () => {
    const harness = harnessFor(
      resolvedWith({
        key: new IntegrationError(
          'invalid_request',
          'fake',
          'delivery of kind "wiki" carries nothing to key on',
        ),
      }),
    );
    const outcome = await harness.deliver();
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unkeyable' });
    expect(harness.inbox.rows.size).toBe(0);
    expect(harness.audit.entries[0]?.error).toContain('carries nothing to key on');
  });
});

describe('a body that is not a JSON object', () => {
  it.each([
    ['not json at all', 'FAKE-plaintext'],
    ['a JSON array', '[1, 2, 3]'],
    ['a JSON scalar', '"just a string"'],
  ])('is refused (%s) rather than stored as a payload nothing can read', async (_name, body) => {
    const harness = harnessFor(resolvedWith());
    const outcome = await harness.deliver({ headers: {}, body });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'malformed_body' });
    expect(harness.inbox.rows.size).toBe(0);
  });

  it('redacts the adapter’s own refusal message, which is provider text and not this module’s', async () => {
    // The `unkeyable` branch forwards `IntegrationError.message`, and GitLab and Slack interpolate
    // `object_kind`/`type` into theirs. The comment on `refuse()` used to claim every detail was
    // this module's own constant; it was not, and this is the assertion that keeps it honest.
    const harness = harnessFor(
      resolvedWith({
        key: new IntegrationError(
          'invalid_request',
          'fake',
          `delivery of kind "${BINDING_SECRET}" carries nothing to key on`,
        ),
      }),
    );

    const outcome = await harness.deliver();

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unkeyable' });
    const entry = harness.audit.entries[0];
    expect(entry?.error).not.toContain(BINDING_SECRET);
    expect(entry?.error).toContain(PLACEHOLDER);
    // And the count is no longer a hard-coded zero claiming the branch carried nothing.
    expect(entry?.redactionCount).toBe(1);
  });

  it('quotes no part of the body, because a fragment is what no redactor can find again', async () => {
    const harness = harnessFor(resolvedWith());
    await harness.deliver({ headers: {}, body: `FAKE-plaintext ${BINDING_SECRET}` });
    expect(JSON.stringify(harness.audit.entries)).not.toContain(BINDING_SECRET);
  });
});

describe('a replayed delivery', () => {
  it('performs nothing twice and is audited as a replay', async () => {
    const harness = harnessFor(resolvedWith());

    const first = await harness.deliver();
    const second = await harness.deliver();

    expect(first).toMatchObject({ kind: 'accepted', events: 1 });
    expect(second).toEqual({ kind: 'duplicate', deliveryId: 'fake:d-1' });
    expect(harness.inbox.rows.size).toBe(1);
    // The one assertion that a "performed nothing twice" claim needs: the *effect*, not the row.
    expect(harness.appended).toHaveLength(1);
    expect(harness.audit.entries.map((entry) => entry.status)).toEqual(['accepted', 'duplicate']);
  });

  /**
   * The pre-read is not the arbiter — the insert is — but it is not decoration either, and without
   * this assertion deleting it left all twenty tests green (measured).
   *
   * What it buys is that a redelivery costs **no provider read**: GitLab's note normaliser fetches
   * the discussion a comment belongs to, so a provider that retries a delivery ten times would
   * otherwise make ten calls to answer a question the platform had already answered.
   */
  it('does not normalise a delivery it has already performed', async () => {
    let normalisations = 0;
    const resolved = resolvedWith({
      result: (context) => {
        normalisations += 1;
        return { events: [ticketMatched(context.projectId)], ignored: [] };
      },
    });
    const harness = harnessFor(resolved);

    await harness.deliver();
    await harness.deliver();

    expect(normalisations).toBe(1);
  });

  it('is deduplicated by the insert, so two deliveries racing each other append once', async () => {
    const harness = harnessFor(resolvedWith());
    // The pre-read misses for both, exactly as it does when two requests interleave; the insert is
    // what decides. Driven by calling the ingress twice with the read already satisfied.
    const [first, second] = await Promise.all([harness.deliver(), harness.deliver()]);
    const outcomes = [first.kind, second.kind].sort();
    expect(outcomes).toEqual(['accepted', 'duplicate']);
    expect(harness.appended).toHaveLength(1);
  });
});

// ── 4. What does it mean? ────────────────────────────────────────────────────

describe('an accepted delivery', () => {
  it('appends the normalised events on the project’s own stream and stores the row with them', async () => {
    const harness = harnessFor(resolvedWith());

    const outcome = await harness.deliver();

    expect(outcome).toMatchObject({ kind: 'accepted', deliveryId: 'fake:d-1', events: 1 });
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]).toMatchObject({
      type: 'ticket.matched',
      stream_type: 'project',
      stream_id: PROJECT,
      stream_seq: 7,
    });
    const row = harness.inbox.only();
    expect(row).toMatchObject({
      provider: 'fake',
      deliveryId: 'fake:d-1',
      integrationId: INTEGRATION,
      verified: true,
      error: null,
      processedAt: NOW,
    });
  });

  it('stores the headers and the payload redacted, and counts every replacement', async () => {
    const harness = harnessFor(resolvedWith());

    await harness.deliver();

    const row = harness.inbox.only();
    const stored = JSON.stringify({ headers: row.headers, payload: row.payload });
    // GitLab's legacy scheme really does send the binding's secret in a header; this is that shape.
    expect(stored, 'the delivery carries the platform’s own credential back').not.toContain(
      BINDING_SECRET,
    );
    expect(stored).toContain(PLACEHOLDER);
    // The header and the body each carried one: the count is the **sum** over the row's
    // redactions, not the delivery key's — which is ~always 0 and would be a dead signal.
    expect(row.redactionCount).toBe(2);
  });

  /**
   * **Where the "planted credential reaches neither `events.payload` nor the inbox row" criterion
   * is actually proved**, and it is not here.
   *
   * The inbox half is the test above. The `events.payload` half is a property of each **provider
   * adapter**, which redacts the whole delivery before any branch of its normaliser reads it — so
   * asserting it against a normaliser double would assert the double. It is proved over the real
   * registrations, for every provider directory on disk, by
   * `packages/integrations/src/providers/inbound-redaction.test.ts`, and end to end against a live
   * `X-Gitlab-Token` by `test/integration/integrations/webhook-ingress.integration.test.ts`.
   *
   * The residual this leaves is stated rather than implied: the ingress does **not** re-redact a
   * normalised payload on its way to `append`. It redacts what it stores itself — the headers, the
   * payload and the ignore detail — and trusts the adapter for what it was handed.
   */
  it('normalises once per bound project, each with its own project id', async () => {
    const harness = harnessFor(
      resolvedWith({}, [{ projectId: PROJECT }, { projectId: OTHER_PROJECT }]),
    );

    const outcome = await harness.deliver();

    expect(outcome).toMatchObject({ kind: 'accepted', events: 2 });
    expect(harness.appended.map((event) => event.stream_id).sort()).toEqual(
      [PROJECT, OTHER_PROJECT].sort(),
    );
  });
});

describe('an integration nobody has bound', () => {
  it('stores the delivery and says why it performed nothing, instead of dropping it', async () => {
    const resolved = resolvedWith();
    const harness = harnessFor({ ...resolved, bindings: [] });

    const outcome = await harness.deliver();

    expect(outcome).toMatchObject({ kind: 'accepted', events: 0, ignored: 1 });
    expect(harness.inbox.only().error).toContain('no project is bound to this integration');
    expect(harness.appended).toEqual([]);
  });
});

describe('the ignore detail on the row', () => {
  it('is redacted before it is cut, because a cap leaves a fragment no redactor can find', async () => {
    const harness = harnessFor(
      resolvedWith({
        result: () => ({
          events: [],
          ignored: [
            {
              reason: 'unsupported_event',
              detail: `${'x'.repeat(MAX_INBOX_ERROR_CHARS)} ${BINDING_SECRET}`,
            },
          ],
        }),
      }),
    );

    await harness.deliver();

    const row = harness.inbox.only();
    expect(row.error).not.toBeNull();
    expect(row.error?.length).toBeLessThanOrEqual(MAX_INBOX_ERROR_CHARS);
    expect(row.error).not.toContain(BINDING_SECRET);
    // The cut happened *after* the replacement, so the count still saw it.
    expect(row.redactionCount).toBe(3);
  });
});

describe('a stream sequence another writer took first', () => {
  it('re-reads it and retries the whole delivery, so the row and its events still commit together', async () => {
    const harness = harnessFor(resolvedWith(), { conflicts: 1 });

    const outcome = await harness.deliver();

    expect(outcome).toMatchObject({ kind: 'accepted' });
    expect(harness.sequenceReads.length).toBe(2);
    expect(harness.inbox.rows.size).toBe(1);
    expect(harness.appended).toHaveLength(1);
  });

  it('gives up after its bound rather than looping inside a request', async () => {
    const harness = harnessFor(resolvedWith(), { conflicts: 99 });
    await expect(harness.deliver()).rejects.toBeInstanceOf(StreamConflictError);
  });
});

// ── A human decision is the aggregate's (WP-43) ──────────────────────────────

describe('a human decision arriving from a provider', () => {
  const decisionScript: NormaliserScript = {
    result: (context) => ({ events: [approvalDecided(context.projectId)], ignored: [] }),
  };

  it('is handed to the aggregate and never appended to the project stream as provider text', async () => {
    const decisions = decisionsDouble(() => ({
      kind: 'applied',
      events: [aggregateEvent as never],
    }));
    const harness = harnessFor(resolvedWith(decisionScript), { decisions: decisions.applier });

    const outcome = await harness.deliver();

    expect(outcome).toMatchObject({ kind: 'accepted', events: 1, ignored: 0 });
    expect(decisions.applied).toEqual([{ projectId: PROJECT, type: 'task.approval.decided' }]);
    // The one event that landed is the aggregate's, on the approval's stream — the draft itself
    // never reached `append`.
    expect(harness.appended).toEqual([aggregateEvent]);
    expect(harness.sequenceReads.length).toBe(1);
    expect(harness.inbox.only().error).toBeNull();
  });

  it('records a refusal on the inbox row and performs nothing, rather than throwing (rule 20)', async () => {
    const decisions = decisionsDouble(() => ({
      kind: 'refused',
      reason: 'not_permitted',
      detail: 'a viewer cannot approve a plan',
    }));
    const harness = harnessFor(resolvedWith(decisionScript), { decisions: decisions.applier });

    const outcome = await harness.deliver();

    expect(outcome).toMatchObject({ kind: 'accepted', events: 0, ignored: 1 });
    expect(harness.appended).toEqual([]);
    expect(harness.inbox.only().error).toBe(
      'decision_refused: not_permitted: a viewer cannot approve a plan',
    );
    expect(harness.audit.entries[0]?.error).toBe(
      'decision_refused: not_permitted: a viewer cannot approve a plan',
    );
  });

  it('redacts a refusal before the row stores it, like every other line there', async () => {
    const decisions = decisionsDouble(() => ({
      kind: 'refused',
      reason: 'unknown_subject',
      detail: `approval ${BINDING_SECRET} does not exist`,
    }));
    const harness = harnessFor(resolvedWith(decisionScript), { decisions: decisions.applier });

    await harness.deliver();

    expect(harness.inbox.only().error).not.toContain(BINDING_SECRET);
    expect(harness.inbox.only().error).toContain(PLACEHOLDER);
  });

  it('rolls the decision back with the row when a racing delivery landed first', async () => {
    const decisions = decisionsDouble(() => ({
      kind: 'applied',
      events: [aggregateEvent as never],
    }));
    const harness = harnessFor(resolvedWith(decisionScript), { decisions: decisions.applier });

    const [first, second] = await Promise.all([harness.deliver(), harness.deliver()]);

    expect([first.kind, second.kind].sort()).toEqual(['accepted', 'duplicate']);
    // Both were decided inside their transactions; only the one whose row landed committed.
    expect(decisions.applied).toHaveLength(2);
    expect(harness.appended).toEqual([aggregateEvent]);
    expect(harness.audit.entries.map((entry) => entry.status).sort()).toEqual([
      'accepted',
      'duplicate',
    ]);
  });

  it('keeps a notification beside it on the project stream, in the same transaction', async () => {
    const decisions = decisionsDouble(() => ({
      kind: 'applied',
      events: [aggregateEvent as never],
    }));
    const harness = harnessFor(
      resolvedWith({
        result: (context) => ({
          events: [ticketMatched(context.projectId), approvalDecided(context.projectId)],
          ignored: [],
        }),
      }),
      { decisions: decisions.applier },
    );

    await harness.deliver();

    expect(harness.appended.map((event) => event.type)).toEqual([
      'ticket.matched',
      'task.approval.decided',
    ]);
    expect(harness.appended[0]).toMatchObject({ stream_id: PROJECT, stream_seq: 7 });
    expect(harness.appended[1]).toBe(aggregateEvent);
  });
});
