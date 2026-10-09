/**
 * **The lifecycle block is checked against the tracker before it is saved** — WP-181 ruling (b),
 * TD-029 decision 1, BD-031 ruling 7.
 *
 * `PUT /api/projects/:id/bindings` writes the task-management binding's `lifecycle` block. Every
 * status name the block maps — and `pickup_status`, which **is** the `pick_up_from` slot — must be
 * one of the statuses the tracker lists (`listStatuses()`, compared case-insensitively as
 * `lifecycleStatusKey` compares). This module is that check, and it runs **before** the write:
 *
 *  - a name outside the set is `422 lifecycle_status_unknown`, naming the slot and the name (one
 *    `details` entry per name, its `path` the binding key: `lifecycle.in_review`,
 *    `lifecycle.returned[1]`, `pickup_status`);
 *  - a tracker that cannot be read is `503 lifecycle_statuses_unavailable`, and **nothing is
 *    saved**, because a mapping that was never checked is the failure ruling 7 exists to prevent.
 *
 * ## Which bindings are checked
 *
 * A task-management item whose **effective** configuration (the account's document with the
 * request's overlay, account-only keys dropped — what the binding repository will hand the loader)
 * carries a `lifecycle` block that names at least one status. A block that names nothing (only
 * `claim`, say) and a binding with no block need no tracker, and are written without a read: every
 * slot may be empty. The check runs on **every** save that carries such a block, not only on one
 * that changed it — TD-029's "at save" is read literally, so a tracker that cannot be read refuses
 * a re-save of an unchanged block too; the cost is stated rather than decided away.
 *
 * ## Order
 *
 * The write's own checks run first (`assertBindingItemsWritable`): an integration named twice, a
 * static-run-credential integration another project binds (WP-137), a credential in the overlay, a
 * binding URL outside `APP_INTEGRATION_HOSTS`, a schema the provider refuses — including the block's
 * own distinctness rules — are refused before any provider is asked anything, and so is a slot that
 * names `pickup_status` (`400 invalid_binding_config`, `validateLifecycle`'s distinctness issues:
 * the block's schema cannot see its sibling key, and a provider schema other than Jira's may not
 * refuse it). Then the statuses of
 * the binding **as proposed** are read (`TicketStatusReader.proposed`), so a request that also
 * changes `project_keys` is checked against the tracker it will read. **Residual:** the accounts are
 * read without a lock here, and the write re-reads them under its own; an account edited between
 * the two is written having been checked against its previous configuration. The window is one
 * provider round trip, and the account edit is an administrator's.
 *
 * **Residual, held by shape only** (WP-181 round 3): the provider reads here — the statuses and
 * the account (`readProposedAccountIdentities`) — run before `replaceProjectBindings` and hand it
 * their answers as data. Moved inside its drizzle transaction, `assertOutsideTransaction` would
 * **not** refuse them: the HTTP write is not a marked unit of work, so only this order keeps a
 * connection from being held across a provider round trip.
 */
import type { Logger, ProjectBinding } from '@platform/application';
import { bindingLifecycleOf } from '@platform/application';
import type { Id, JsonObject, TicketLifecycle } from '@platform/contracts';
import { type LifecycleIssue, validateLifecycle } from '@platform/domain';
import { secrets as secretAdapters } from '@platform/infrastructure';
import { accountOnlyFieldsOf } from '@platform/integrations';
import { HttpError } from './errors.js';
import type { BindingAccountIdentity, BindingAccountRow } from './queries/onboarding-queries.js';
import type { TicketStatusReader } from './ticket-statuses.js';

/** One item of a bindings write: the account it names and the overlay it carries. */
export interface ProposedBindingItem {
  readonly integrationId: string;
  readonly config?: JsonObject;
}

export interface LifecycleCheckDependencies {
  /** The accounts the items name (`findBindingAccounts`). */
  readonly accounts: (ids: readonly string[]) => Promise<readonly BindingAccountRow[]>;
  /** The write's own checks, run before any provider read (`assertBindingItemsWritable`). */
  readonly assertWritable: (
    projectId: Id,
    items: readonly ProposedBindingItem[],
    accounts: readonly BindingAccountRow[],
  ) => Promise<void>;
  /** The proposed binding's statuses, or `null` on a process that composed no integration stack. */
  readonly statuses: TicketStatusReader['proposed'] | null;
}

/** The binding a write is about to save, as the loader builds a saved one (WP-181). */
const proposedBindingOf = (account: BindingAccountRow, config: JsonObject): ProjectBinding => ({
  // No binding row exists yet for a new one; the id only names the binding in a refusal.
  bindingId: account.id,
  integrationId: account.id,
  type: account.type,
  provider: account.provider,
  name: account.name,
  config,
  secretIds: account.secretIds,
  retired: account.retiredAt !== null,
});

/** An item's effective configuration: the account's document with the item's overlay on top. */
const effectiveConfigOf = (account: BindingAccountRow, item: ProposedBindingItem): JsonObject =>
  secretAdapters.overlayBindingConfig(
    account.config,
    item.config ?? {},
    accountOnlyFieldsOf(account.provider),
  );

/** A block's statuses, with the binding key each sits under. */
const namedStatuses = (
  slots: TicketLifecycle,
  pickUpFrom: string | null,
): readonly { readonly path: string; readonly name: string }[] => [
  ...(pickUpFrom === null ? [] : [{ path: 'pickup_status', name: pickUpFrom }]),
  ...(['in_progress', 'in_review', 'approved', 'qa', 'done'] as const).flatMap((slot) => {
    const name = slots[slot];
    return name === undefined ? [] : [{ path: `lifecycle.${slot}`, name }];
  }),
  ...(slots.returned ?? []).map((name, index) => ({ path: `lifecycle.returned[${index}]`, name })),
];

/** The binding key of an `unknown_status` issue. */
const pathOf = (issue: Extract<LifecycleIssue, { code: 'unknown_status' }>): string =>
  issue.slot === 'pick_up_from'
    ? 'pickup_status'
    : issue.slot === 'returned'
      ? `lifecycle.returned[${issue.index ?? 0}]`
      : `lifecycle.${issue.slot}`;

/** Which two slots a distinctness issue names, for the sentence. */
const describeClash = (issue: Exclude<LifecycleIssue, { code: 'unknown_status' }>): string =>
  issue.code === 'duplicate_slot'
    ? `${issue.slot} and ${issue.other}`
    : issue.code === 'returned_overlap'
      ? `returned[${issue.index}] and ${issue.other}`
      : `returned[${issue.index}] twice`;

/** A slot's product name, for the sentence: `in_review` → *in review*. */
const slotWords = (issue: Extract<LifecycleIssue, { code: 'unknown_status' }>): string =>
  issue.slot === 'pick_up_from' ? 'pick up from' : issue.slot.replaceAll('_', ' ');

/**
 * Checks every task-management item of a bindings write whose lifecycle block names a status.
 *
 * @throws {HttpError} `422 lifecycle_status_unknown` naming each slot and name outside the loaded
 * set; `503 lifecycle_statuses_unavailable` when the tracker cannot be read (or this process cannot
 * read one); and whatever the write's own checks throw, before any read.
 */
export const checkProposedLifecycles = async (
  projectId: Id,
  items: readonly ProposedBindingItem[],
  dependencies: LifecycleCheckDependencies,
): Promise<void> => {
  const accounts = await dependencies.accounts(items.map((item) => item.integrationId));
  const checked = items.flatMap((item) => {
    const account = accounts.find((row) => row.id === item.integrationId);
    if (account === undefined || account.type !== 'task_management') {
      return [];
    }
    const effective = effectiveConfigOf(account, item);
    const reading = bindingLifecycleOf(effective);
    if (reading.kind !== 'lifecycle') {
      // No block: nothing to check. A block that fails its schema is the write's own 400.
      return [];
    }
    const { slots, pickUpFrom } = reading.lifecycle;
    if (namedStatuses(slots, pickUpFrom).length === 0) {
      return [];
    }
    return [{ account, effective, slots, pickUpFrom }];
  });
  if (checked.length === 0) {
    return;
  }
  // Before any provider is asked anything: the write's own refusals (hosts, credentials, schema).
  await dependencies.assertWritable(projectId, items, accounts);
  // And the block's own rules against its sibling `pickup_status`, which the block's schema cannot
  // see (`ticketLifecycleSchema`'s docblock) — every provider's binding schema, not only Jira's.
  for (const { account, slots, pickUpFrom } of checked) {
    const names = namedStatuses(slots, pickUpFrom).map((entry) => entry.name);
    const clashes = validateLifecycle(slots, pickUpFrom, names).filter(
      (issue) => issue.code !== 'unknown_status',
    );
    if (clashes.length > 0) {
      throw new HttpError(
        400,
        'invalid_binding_config',
        `the lifecycle block of "${account.name}" names one status for two slots: ${clashes
          .map((issue) => `"${issue.name}" (${describeClash(issue)})`)
          .join('; ')}`,
      );
    }
  }
  if (dependencies.statuses === null) {
    throw new HttpError(
      503,
      'lifecycle_statuses_unavailable',
      'this process composed no integrations, so it cannot read the tracker’s statuses to check the lifecycle block; nothing was saved. Ask an instance that runs the workers',
    );
  }
  for (const { account, effective, slots, pickUpFrom } of checked) {
    const answer = await dependencies.statuses(projectId, proposedBindingOf(account, effective));
    if (answer.status !== 'ok') {
      throw new HttpError(
        503,
        'lifecycle_statuses_unavailable',
        `the statuses of "${account.name}" could not be read, so the lifecycle block was not checked and nothing was saved: ${
          answer.status === 'unavailable'
            ? answer.reason
            : 'the binding is not a task-management binding'
        }`,
      );
    }
    const unknown = validateLifecycle(
      slots,
      pickUpFrom,
      answer.items.map((status) => status.name),
    ).filter(
      (issue): issue is Extract<LifecycleIssue, { code: 'unknown_status' }> =>
        issue.code === 'unknown_status',
    );
    if (unknown.length > 0) {
      const details = unknown.map((issue) => ({
        path: pathOf(issue),
        message: `the ${slotWords(issue)} slot names "${issue.name}", which "${account.name}" does not list among its statuses`,
      }));
      throw new HttpError(
        422,
        'lifecycle_status_unknown',
        `${details.map((detail) => `${detail.path}: ${detail.message}`).join('; ')}. Pick each slot from the statuses GET /api/projects/${projectId}/ticket-statuses lists; nothing was saved`,
        details,
      );
    }
  }
};

export interface AccountIdentityDependencies {
  readonly accounts: LifecycleCheckDependencies['accounts'];
  readonly assertWritable: LifecycleCheckDependencies['assertWritable'];
  /** The proposed binding's own account, or `null` on a process with no integration stack. */
  readonly account: TicketStatusReader['proposedAccount'] | null;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * **What each task-management binding of a write acts as**, read at the save so the readiness read
 * makes no provider call (WP-181 review round 2, Q118 (a)): `selfIdentity` of the binding as
 * proposed, through the executor, after the write's own checks (so no read is spent on a write that
 * will be refused). The answer is what `bindings.account_identity` (migration 0090) stores.
 *
 * **It never blocks the save.** A refusal (`unavailable`), a binding the reader answers with no
 * tracker, and **any** throw — an `IntegrationError` or a fault — store `null`, which the readiness
 * read takes as unknown and names nothing for; the failure is logged. Only the write's own refusals
 * propagate, because the write would make them anyway. A process with no integration stack reads
 * nothing and stores `null`.
 */
export const readProposedAccountIdentities = async (
  projectId: Id,
  items: readonly ProposedBindingItem[],
  dependencies: AccountIdentityDependencies,
): Promise<ReadonlyMap<string, BindingAccountIdentity | null>> => {
  const identities = new Map<string, BindingAccountIdentity | null>();
  const accounts = await dependencies.accounts(items.map((item) => item.integrationId));
  const tracked = items.flatMap((item) => {
    const account = accounts.find((row) => row.id === item.integrationId);
    return account === undefined || account.type !== 'task_management' ? [] : [{ item, account }];
  });
  if (tracked.length === 0 || dependencies.account === null) {
    return identities;
  }
  await dependencies.assertWritable(projectId, items, accounts);
  for (const { item, account } of tracked) {
    try {
      const answer = await dependencies.account(
        projectId,
        proposedBindingOf(account, effectiveConfigOf(account, item)),
      );
      if (answer.status === 'unavailable') {
        dependencies.logger.warn(
          { project_id: projectId, integration_id: account.id, reason: answer.reason },
          'the binding’s own account could not be read at its save; it is stored as unknown and the save goes on',
        );
      }
      identities.set(
        account.id,
        answer.status === 'ok'
          ? { provider: answer.identity.provider, external_id: answer.identity.external_id }
          : null,
      );
    } catch (error) {
      dependencies.logger.warn(
        { project_id: projectId, integration_id: account.id, err: error },
        'reading the binding’s own account failed at its save; it is stored as unknown and the save goes on',
      );
      identities.set(account.id, null);
    }
  }
  return identities;
};
