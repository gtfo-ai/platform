/**
 * The ticket lifecycle a project's **task-management binding** declares — BD-031 rulings 2 and 5,
 * TD-029 decision 1 (WP-177).
 *
 * The slots live on the binding (`bindings.config` over `integrations.config`), beside
 * `pickup_status`, which **is** the `pick_up_from` slot. Every task-management provider's binding
 * schema embeds `ticketLifecycleSchema` under the key `lifecycle` (TD-029 decision 1; Jira Cloud's
 * since WP-172), so this module reads that one key and that one sibling and nothing provider
 * specific — adding a provider does not touch it (BD-017).
 *
 * It reaches the pipeline on {@link ProjectSettings.ticketLifecycle}, read by the settings port in
 * the caller's transaction when it has one: the status-mapping and lifecycle handlers decide inside
 * the dispatcher's transaction, where resolving the binding through the loader (a credential
 * decryption and a nested pool borrow) is refused (WP-15d). The claim and the intake skip read the
 * same answer from the same port outside a transaction, so every reader sees one reading.
 */
import { type TicketLifecycle, ticketLifecycleSchema } from '@platform/contracts';

/** A binding's lifecycle, as the pipeline reads it. */
export interface BindingLifecycle {
  /** `pickup_status` — the `pick_up_from` slot — or `null` when the binding picks up by label. */
  readonly pickUpFrom: string | null;
  /** The `lifecycle` block, parsed. */
  readonly slots: TicketLifecycle;
}

/** What {@link bindingLifecycleOf} found in one binding's merged configuration. */
export type BindingLifecycleReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'lifecycle'; readonly lifecycle: BindingLifecycle }
  /** The block is there and fails its schema: the loader refuses this binding on every call too. */
  | { readonly kind: 'invalid'; readonly detail: string };

/**
 * Reads the `lifecycle` block and `pickup_status` out of a binding's merged configuration.
 *
 * A binding with no block answers `none`: it neither claims nor skips assigned tickets and applies
 * `status_mapping` exactly as before (TD-029 decision 1). A block that fails `ticketLifecycleSchema`
 * answers `invalid` with the issue paths, never the values — a config document can hold a pasted
 * credential (the loader's rule).
 */
export const bindingLifecycleOf = (config: unknown): BindingLifecycleReading => {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { kind: 'none' };
  }
  const record = config as Readonly<Record<string, unknown>>;
  if (record.lifecycle === undefined || record.lifecycle === null) {
    return { kind: 'none' };
  }
  const parsed = ticketLifecycleSchema.safeParse(record.lifecycle);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      detail: parsed.error.issues
        .map((issue) => ['lifecycle', ...issue.path.map(String)].join('.'))
        .join(', '),
    };
  }
  const pickup = record.pickup_status;
  return {
    kind: 'lifecycle',
    lifecycle: {
      pickUpFrom: typeof pickup === 'string' && pickup.trim().length > 0 ? pickup : null,
      slots: parsed.data,
    },
  };
};
