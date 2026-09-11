/**
 * The shared contract suites for the two platform-side ports of technical/06 § "Outbound: actions":
 * `IntegrationAuditLog` and `IdempotencyStore`.
 *
 * They exist for standing rule 23 — *a new port obligation must land in the shared contract suite
 * in the same change, or it is a provider-local promise.* WP-07 shipped both ports with one
 * implementation each (the in-memory fakes) and the obligations written only in docblocks; WP-15b
 * added the second implementation, the PostgreSQL one, and two implementations of a port with no
 * shared suite is exactly the arrangement BD-017 says must not exist.
 *
 * Every obligation below is quoted from the port's own docblock, so this file is the *executable*
 * form of it rather than a second opinion:
 *
 *  - "the adapter writes the `integration_actions` row **and** appends the events from
 *    `integrationActionEventDrafts` in one transaction" — the row is always written; the event set
 *    is `ok → performed`, `failed → failed`, `would_have`/`replayed` → none;
 *  - "`redactionCount` is what the redactor reported, so a row that should have hidden something
 *    and did not is visible as a zero" — asserted **in both directions** (standing rule 42): an
 *    entry with a non-zero count stores that number, and one with zero stores zero. A store that
 *    dropped the column, or coerced it, passes only one of the two;
 *  - "`undefined` means never seen; a stored `null` is a legitimate remembered result" — a miss and
 *    a remembered JSON `null` are different answers;
 *  - "two integrations of the same provider are different accounts, and the same key on two
 *    *actions* means two different calls" — the scope is all three parts, not the key alone.
 *
 * What the suites cannot check, stated rather than implied: **atomicity**. "Row and events commit
 * together" is a property of a transaction, and the in-memory fake has none — it appends to two
 * arrays. The integration runner adds a case for it against PostgreSQL, where it is real; the
 * shared suite would otherwise assert a property one of its implementations cannot have.
 */
import type {
  IdempotencyScope,
  IdempotencyStore,
  IntegrationActionEntry,
  IntegrationActionStatus,
  IntegrationAuditLog,
} from '@platform/application';
import type { Id, IsoDateTime, JsonObject } from '@platform/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

/** One recorded row, as an implementation lets the suite read it back. */
export interface RecordedAuditRow {
  readonly integrationId: Id;
  readonly projectId: Id | null;
  readonly taskId: Id | null;
  readonly action: string;
  readonly status: IntegrationActionStatus;
  readonly payload: JsonObject;
  readonly redactionCount: number;
  readonly attempts: number;
  readonly durationMs: number | null;
}

export interface AuditLogContractContext {
  readonly log: IntegrationAuditLog;
  /** Rows this implementation holds, oldest first. */
  rows(): Promise<readonly RecordedAuditRow[]>;
  /** Catalogue types appended, oldest first. */
  eventTypes(): Promise<readonly string[]>;
  /** An `integrations.id` this implementation accepts (a real row, for the Postgres one). */
  readonly integrationId: Id;
  readonly projectId: Id;
  readonly taskId: Id;
  cleanup(): Promise<void>;
}

export interface IdempotencyContractContext {
  readonly store: IdempotencyStore;
  readonly integrationId: Id;
  /** A second `integrations.id`, so the scope's first part can be varied. */
  readonly otherIntegrationId: Id;
  cleanup(): Promise<void>;
}

const OCCURRED_AT = '2026-09-11T12:00:00.000Z' as IsoDateTime;

/** Builds an entry for `context`, so both implementations get ids they accept. */
export const auditEntryFor = (
  context: Pick<AuditLogContractContext, 'integrationId' | 'projectId' | 'taskId'>,
  overrides: Partial<IntegrationActionEntry> = {},
): IntegrationActionEntry => ({
  integrationId: context.integrationId,
  provider: 'fake-task-management',
  projectId: context.projectId,
  taskId: context.taskId,
  direction: 'out',
  action: 'add_comment',
  mutating: true,
  status: 'ok',
  payload: { body: 'a comment the platform wrote' },
  result: { comment_id: '17' },
  error: null,
  durationMs: 31,
  occurredAt: OCCURRED_AT,
  redactionCount: 0,
  attempts: 1,
  ...overrides,
});

export const runAuditLogContract = (
  name: string,
  createContext: () => Promise<AuditLogContractContext>,
): void => {
  describe(`IntegrationAuditLog contract: ${name}`, () => {
    let context: AuditLogContractContext;

    beforeEach(async () => {
      await context?.cleanup();
      context = await createContext();
    });

    it('records a row for every status, including the two that never reached the provider', async () => {
      const statuses: IntegrationActionStatus[] = ['ok', 'failed', 'would_have', 'replayed'];
      for (const status of statuses) {
        await context.log.record(
          auditEntryFor(context, {
            status,
            action: status,
            result: status === 'failed' ? null : { ok: true },
            error: status === 'failed' ? 'the provider refused' : null,
          }),
        );
      }
      expect((await context.rows()).map((row) => row.status)).toEqual(statuses);
    });

    it('appends performed for ok and failed for failed, and nothing for the other two', async () => {
      await context.log.record(auditEntryFor(context, { action: 'ok' }));
      await context.log.record(
        auditEntryFor(context, {
          action: 'failed',
          status: 'failed',
          result: null,
          error: 'the provider refused',
        }),
      );
      await context.log.record(auditEntryFor(context, { action: 'shadow', status: 'would_have' }));
      await context.log.record(auditEntryFor(context, { action: 'replay', status: 'replayed' }));

      expect(await context.eventTypes()).toEqual([
        'integration.action.performed',
        'integration.action.failed',
      ]);
    });

    it('stores a non-zero redaction count as the number the redactor reported', async () => {
      await context.log.record(auditEntryFor(context, { redactionCount: 4, attempts: 3 }));
      const row = (await context.rows())[0];
      expect(row?.redactionCount).toBe(4);
      expect(row?.attempts).toBe(3);
    });

    it('stores a zero redaction count as zero', async () => {
      // The other half of the boundary, and the half that matters (standing rule 42): a zero is the
      // only signal that a row which *should* have hidden something did not. An implementation that
      // dropped the column, wrote null, or only persisted truthy counts passes the test above and
      // fails this one.
      await context.log.record(auditEntryFor(context, { redactionCount: 0, attempts: 0 }));
      const row = (await context.rows())[0];
      expect(row?.redactionCount).toBe(0);
      expect(row?.attempts).toBe(0);
    });

    it('keeps the project and task the entry was scoped to, and accepts a null task', async () => {
      await context.log.record(auditEntryFor(context, { action: 'with_task' }));
      await context.log.record(auditEntryFor(context, { action: 'no_task', taskId: null }));

      const rows = await context.rows();
      expect(rows[0]).toMatchObject({ projectId: context.projectId, taskId: context.taskId });
      // `project_id` is why migration 0013 exists: an action with no task still belongs to a
      // project, and reconstructing it through `integrations` would be wrong (one integration
      // serves many projects).
      expect(rows[1]).toMatchObject({ projectId: context.projectId, taskId: null });
    });

    it('stores the payload it was handed, which has already been redacted', async () => {
      await context.log.record(
        auditEntryFor(context, { payload: { body: '[REDACTED:integration:jira]' } }),
      );
      expect((await context.rows())[0]?.payload).toEqual({
        body: '[REDACTED:integration:jira]',
      });
    });
  });
};

export const runIdempotencyStoreContract = (
  name: string,
  createContext: () => Promise<IdempotencyContractContext>,
): void => {
  describe(`IdempotencyStore contract: ${name}`, () => {
    let context: IdempotencyContractContext;

    const scope = (overrides: Partial<IdempotencyScope> = {}): IdempotencyScope => ({
      integrationId: context.integrationId,
      action: 'add_comment',
      key: 'marker-1',
      ...overrides,
    });

    beforeEach(async () => {
      await context?.cleanup();
      context = await createContext();
    });

    it('answers undefined for a key it has never seen', async () => {
      expect(await context.store.get(scope())).toBeUndefined();
    });

    it('remembers a result and returns it', async () => {
      await context.store.put(scope(), { comment_id: '17' });
      expect(await context.store.get(scope())).toEqual({ comment_id: '17' });
    });

    it('tells a remembered null apart from a key it has never seen', async () => {
      // The port's own reason for making the miss `undefined`: a stored `null` is a legitimate
      // remembered result, and a store that used SQL NULL for the value would collapse the two and
      // re-perform a mutation the provider has already seen.
      await context.store.put(scope({ key: 'stored-null' }), null);
      expect(await context.store.get(scope({ key: 'stored-null' }))).toBeNull();
      expect(await context.store.get(scope({ key: 'never-written' }))).toBeUndefined();
    });

    it('scopes a key by integration and action, not by the key alone', async () => {
      await context.store.put(scope(), { from: 'the original scope' });

      expect(
        await context.store.get(scope({ integrationId: context.otherIntegrationId })),
      ).toBeUndefined();
      expect(await context.store.get(scope({ action: 'transition' }))).toBeUndefined();
      // And the original is still there: the three assertions above must be misses because the
      // scope differs, not because the write never landed.
      expect(await context.store.get(scope())).toEqual({ from: 'the original scope' });
    });

    it('does not let one scope answer another that composes to the same characters', async () => {
      // `idempotencyStorageKey` escapes each part precisely so `a:b` cannot be confused with the
      // pair `a` and `b`; an adapter that concatenated them itself would answer one call with
      // another's result.
      await context.store.put(scope({ action: 'a', key: 'b:c' }), { which: 'first' });
      await context.store.put(scope({ action: 'a:b', key: 'c' }), { which: 'second' });

      expect(await context.store.get(scope({ action: 'a', key: 'b:c' }))).toEqual({
        which: 'first',
      });
      expect(await context.store.get(scope({ action: 'a:b', key: 'c' }))).toEqual({
        which: 'second',
      });
    });
  });
};
