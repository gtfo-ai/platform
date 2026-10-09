/**
 * **The ticket lifecycle's slots, as pick lists** — WP-182 ruling (a), BD-031 ruling 7, TD-029
 * decision 1, product/04 § "Ticket lifecycle".
 *
 * One component for the wizard's step 1 and the project settings page's *Connections* card — the
 * *same component*, which is how product/18:55's mirror stays true without anybody remembering.
 *
 * ## What it does
 *
 * - **Every pick list is the loaded set.** The options are what `GET …/ticket-statuses` answered for
 *   the project's task-management binding, each with its category; this module names no status
 *   (BD-031 ruling 1). A name the binding stores that the tracker no longer lists is not offered: the
 *   slot shows empty and a note names the stored name, so the person sees what saving will drop.
 * - **Every slot may be empty.** An empty single slot and an empty `returned` are sent **absent** from
 *   the block. `pick_up_from` is the binding's `pickup_status` key rather than a key of the block
 *   (`jiraCloudConfigSchema`): empty, it is sent absent — or `null` when the integration's own
 *   configuration sets one, because an absent overlay key would let the account's value through
 *   (`overlayBindingConfig` is a shallow merge) and the slot the person emptied would not be empty.
 * - **`returned` is a multi-select**, at most {@link MAX_LIFECYCLE_RETURNED_STATUSES} names.
 * - **The `claim` and `take_assigned_tickets` switches** are the block's own keys. `claim` is seeded
 *   from the stored block, or **on** when there is none, because that is what the block means once
 *   it is saved (`ticketLifecycleSchema`'s docblock): the switch shows what saving puts in force.
 * - **Saving writes the block as the form shows it**, through `PUT …/bindings` with the **whole**
 *   stored set and every other binding's configuration unchanged (the notifications control's shape,
 *   `operating-mode.tsx`), so this button cannot lose a channel or unbind anything.
 * - **The refusals are named.** `422 lifecycle_status_unknown` marks each slot its `details` name
 *   (`pickup_status`, `lifecycle.in_review`, `lifecycle.returned[1]`); `503
 *   lifecycle_statuses_unavailable` says the statuses could not be loaded and nothing was saved, and
 *   **keeps the form**: nothing here resets the draft on a failure.
 *
 * Status names are provider text (BD-022). They are rendered as React text — in an `<option>`, which
 * can hold nothing else, through `sanitiseUntrusted`; everywhere else through `UntrustedText`.
 */
import {
  LIFECYCLE_SINGLE_SLOTS,
  type LifecycleSingleSlot,
  lifecycleStatusKey,
  MAX_LIFECYCLE_RETURNED_STATUSES,
  type TicketStatus,
  type TicketStatusCategory,
} from '@platform/contracts';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { ApiError } from '../api/http.js';
import {
  useBindableIntegrations,
  useOnboardingCommands,
  useProjectBindings,
  useProjectConfig,
  useTicketStatuses,
} from '../app/queries.js';
import { Badge, Button, ErrorNotice, Loading } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { bindingConfigOf } from './operating-mode.js';

/** Every slot of the lifecycle, in the order a ticket normally passes them. */
export type LifecycleSlot = 'pick_up_from' | LifecycleSingleSlot | 'returned';

/** The slots with one name each: `pick_up_from` and the block's five. */
export type SingleNameSlot = Exclude<LifecycleSlot, 'returned'>;

const SINGLE_NAME_SLOTS: readonly SingleNameSlot[] = ['pick_up_from', ...LIFECYCLE_SINGLE_SLOTS];

/** What each slot does, in a user's words (product/04's table). Platform text. */
export const SLOT_COPY: Readonly<Record<LifecycleSlot, { label: string; hint: string }>> = {
  pick_up_from: {
    label: 'Pick up from',
    hint: 'Only tickets in this status are started (a pick-up label works instead). On cancel or rework the ticket is moved back here.',
  },
  in_progress: {
    label: 'In progress',
    hint: 'Set when the platform claims the ticket, and again each time a developer stage starts.',
  },
  in_review: { label: 'In review', hint: 'Set when the agent’s code review starts.' },
  approved: {
    label: 'Approved',
    hint: 'Set when the agent’s own review has passed and its findings are fixed.',
  },
  qa: {
    label: 'QA',
    hint: 'Mapped, tasks created from then on get a human QA stage before Ready for merge, and the ticket is moved here when the task enters it.',
  },
  returned: {
    label: 'Returned',
    hint: `Never set by the platform. A person moving the ticket into one of these returns the task to the agent. Up to ${MAX_LIFECYCLE_RETURNED_STATUSES}.`,
  },
  done: { label: 'Done', hint: 'Set when the merge request is merged.' },
};

const CATEGORY_WORDS: Readonly<Record<TicketStatusCategory, string>> = {
  todo: 'to do',
  in_progress: 'in progress',
  done: 'done',
  unknown: 'no category',
};

/** The form's state: one name per single slot (`''` is empty), the returned list, two switches. */
export interface LifecycleDraft {
  readonly names: Readonly<Record<SingleNameSlot, string>>;
  readonly returned: readonly string[];
  readonly claim: boolean;
  readonly takeAssignedTickets: boolean;
}

/** A stored name the loaded set does not hold, and the slot it was stored in. */
export interface DroppedName {
  readonly slot: LifecycleSlot;
  readonly name: string;
}

const asObject = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

/**
 * The draft a binding's **effective** configuration seeds, with every stored name matched to the
 * loaded set's spelling (compared as the server compares, `lifecycleStatusKey`). A stored name the
 * set does not hold is left out of the draft and returned in `dropped`, so the screen can say so.
 */
export const lifecycleDraftOf = (
  effective: Readonly<Record<string, unknown>>,
  statuses: readonly TicketStatus[],
): { readonly draft: LifecycleDraft; readonly dropped: readonly DroppedName[] } => {
  const loaded = new Map(statuses.map((status) => [lifecycleStatusKey(status.name), status.name]));
  const dropped: DroppedName[] = [];
  const match = (slot: LifecycleSlot, stored: string | null): string => {
    if (stored === null) {
      return '';
    }
    const found = loaded.get(lifecycleStatusKey(stored));
    if (found === undefined) {
      dropped.push({ slot, name: stored });
      return '';
    }
    return found;
  };
  const block = asObject(effective.lifecycle);
  const names = {
    pick_up_from: match('pick_up_from', nonEmptyString(effective.pickup_status)),
  } as Record<SingleNameSlot, string>;
  for (const slot of LIFECYCLE_SINGLE_SLOTS) {
    names[slot] = match(slot, nonEmptyString(block?.[slot]));
  }
  const storedReturned = Array.isArray(block?.returned) ? block.returned : [];
  const returned = storedReturned
    .map((name) => match('returned', nonEmptyString(name)))
    .filter((name) => name !== '');
  return {
    draft: {
      names,
      returned,
      // The block's own default when it is present, and what saving it puts in force when not.
      claim: typeof block?.claim === 'boolean' ? block.claim : true,
      takeAssignedTickets:
        typeof block?.take_assigned_tickets === 'boolean' ? block.take_assigned_tickets : false,
    },
    dropped,
  };
};

/**
 * The binding overlay the draft saves: the stored overlay with `pickup_status` and `lifecycle`
 * replaced. An empty slot is **absent**; an emptied `pick_up_from` is `null` only when the account's
 * own configuration would otherwise supply one (the module's docblock).
 */
export const lifecycleOverlayOf = (
  stored: Readonly<Record<string, unknown>> | undefined,
  draft: LifecycleDraft,
  accountPickupStatus: string | null,
): Record<string, unknown> => {
  const { pickup_status: _pickup, lifecycle: _lifecycle, ...rest } = stored ?? {};
  const lifecycle: Record<string, unknown> = {};
  for (const slot of LIFECYCLE_SINGLE_SLOTS) {
    if (draft.names[slot] !== '') {
      lifecycle[slot] = draft.names[slot];
    }
  }
  if (draft.returned.length > 0) {
    lifecycle.returned = [...draft.returned];
  }
  lifecycle.claim = draft.claim;
  lifecycle.take_assigned_tickets = draft.takeAssignedTickets;
  const pickup = draft.names.pick_up_from;
  return {
    ...rest,
    ...(pickup !== ''
      ? { pickup_status: pickup }
      : accountPickupStatus === null
        ? {}
        : { pickup_status: null }),
    lifecycle,
  };
};

/**
 * The block the wizard writes for a tracker it binds for the first time (backlog 552, TD-029
 * decision 1: *"The setup surface writes a block for every project it saves, so a project set up
 * from now on claims unless a maintainer turns it off"*): every slot empty, the claim on. It names
 * no status, so the save-time check makes no provider call (`lifecycle-check.ts`).
 */
export const DEFAULT_LIFECYCLE_BLOCK = { claim: true, take_assigned_tickets: false } as const;

/**
 * The configuration the wizard's *Bind* sends for one integration: the stored overlay, plus
 * {@link DEFAULT_LIFECYCLE_BLOCK} for a **task-management** integration the project does **not yet
 * bind** and whose effective configuration (the account's document under the overlay) has no
 * `lifecycle` block. A binding already stored is sent as stored — a re-save never adds a block to a
 * binding set up before the milestone (product/04: it *"does not claim until its lifecycle is saved
 * once"*) — and a stored block is never touched.
 */
export const wizardBindingConfig = (input: {
  readonly integration: {
    readonly id: string;
    readonly type: string;
    readonly config?: unknown;
  } | null;
  readonly stored: readonly { readonly integration_id: string; readonly config?: unknown }[];
  readonly integrationId: string;
}): Record<string, unknown> | undefined => {
  const overlay = bindingConfigOf(input.stored, input.integrationId);
  if (wizardWritesDefaultBlock(input)) {
    return { ...(overlay ?? {}), lifecycle: { ...DEFAULT_LIFECYCLE_BLOCK } };
  }
  return overlay;
};

/** Whether {@link wizardBindingConfig} adds the default block for this integration. */
export const wizardWritesDefaultBlock = (input: {
  readonly integration: {
    readonly id: string;
    readonly type: string;
    readonly config?: unknown;
  } | null;
  readonly stored: readonly { readonly integration_id: string; readonly config?: unknown }[];
  readonly integrationId: string;
}): boolean => {
  if (input.integration === null || input.integration.type !== 'task_management') {
    return false;
  }
  if (input.stored.some((item) => item.integration_id === input.integrationId)) {
    return false;
  }
  return asObject(asObject(input.integration.config)?.lifecycle) === undefined;
};

/** The slot a `422 lifecycle_status_unknown` detail's `path` names, or `null` for another path. */
export const slotOfDetailPath = (path: string): LifecycleSlot | null => {
  if (path === 'pickup_status') {
    return 'pick_up_from';
  }
  if (/^lifecycle\.returned\[\d+\]$/u.test(path)) {
    return 'returned';
  }
  const single = /^lifecycle\.([a-z_]+)$/u.exec(path)?.[1];
  return LIFECYCLE_SINGLE_SLOTS.find((slot) => slot === single) ?? null;
};

/** The refused slots of a failed save, each with the server's sentences. */
const refusedSlots = (error: unknown): ReadonlyMap<LifecycleSlot, readonly string[]> => {
  const refused = new Map<LifecycleSlot, string[]>();
  if (!(error instanceof ApiError) || error.code !== 'lifecycle_status_unknown') {
    return refused;
  }
  for (const detail of error.details) {
    const slot = slotOfDetailPath(detail.path);
    if (slot !== null) {
      refused.set(slot, [...(refused.get(slot) ?? []), detail.message]);
    }
  }
  return refused;
};

const optionText = (status: TicketStatus): string =>
  `${sanitiseUntrusted(status.name)} (${CATEGORY_WORDS[status.category]})`;

const SlotRow = ({
  slot,
  statuses,
  value,
  refusal,
  onChange,
}: {
  readonly slot: SingleNameSlot;
  readonly statuses: readonly TicketStatus[];
  readonly value: string;
  readonly refusal: readonly string[] | undefined;
  readonly onChange: (name: string) => void;
}): ReactElement => {
  const id = useId();
  return (
    <div className="flex flex-col gap-1" data-lifecycle-slot={slot}>
      <label htmlFor={id} className="text-sm font-medium">
        {SLOT_COPY[slot].label}
      </label>
      <select
        id={id}
        aria-invalid={refusal === undefined ? undefined : true}
        aria-describedby={`${id}-hint`}
        className={`rounded-md border bg-surface px-2 py-1 text-sm ${
          refusal === undefined ? 'border-line' : 'border-danger'
        }`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Not mapped</option>
        {statuses.map((status) => (
          <option key={status.id} value={status.name}>
            {optionText(status)}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="text-xs text-fg-muted">
        {SLOT_COPY[slot].hint}
      </p>
      {(refusal ?? []).map((message) => (
        <p key={message} role="alert" className="text-xs text-danger">
          <UntrustedText value={message} />
        </p>
      ))}
    </div>
  );
};

const ReturnedRow = ({
  statuses,
  value,
  refusal,
  onChange,
}: {
  readonly statuses: readonly TicketStatus[];
  readonly value: readonly string[];
  readonly refusal: readonly string[] | undefined;
  readonly onChange: (names: readonly string[]) => void;
}): ReactElement => {
  const id = useId();
  return (
    <div className="flex flex-col gap-1" data-lifecycle-slot="returned">
      <label htmlFor={id} className="text-sm font-medium">
        {SLOT_COPY.returned.label}
      </label>
      <select
        id={id}
        multiple
        aria-invalid={refusal === undefined ? undefined : true}
        aria-describedby={`${id}-hint`}
        className={`rounded-md border bg-surface px-2 py-1 text-sm ${
          refusal === undefined ? 'border-line' : 'border-danger'
        }`}
        value={[...value]}
        onChange={(event) =>
          onChange(Array.from(event.target.selectedOptions, (option) => option.value))
        }
      >
        {statuses.map((status) => (
          <option key={status.id} value={status.name}>
            {optionText(status)}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="text-xs text-fg-muted">
        {SLOT_COPY.returned.hint} None selected leaves the slot empty.
      </p>
      {(refusal ?? []).map((message) => (
        <p key={message} role="alert" className="text-xs text-danger">
          <UntrustedText value={message} />
        </p>
      ))}
    </div>
  );
};

/** The statuses read's failure, in the person's words. */
const statusesFailure = (error: unknown): { title: string; detail?: string } => {
  if (error instanceof ApiError && error.code === 'lifecycle_statuses_unavailable') {
    return {
      title: 'The tracker’s statuses could not be loaded, so the slots cannot be picked yet.',
      detail: error.message,
    };
  }
  if (error instanceof ApiError && error.status === 403) {
    return { title: 'Reading the tracker’s statuses needs a maintainer.' };
  }
  return { title: 'The tracker’s statuses could not be loaded.', detail: String(error) };
};

/**
 * The lifecycle card's body: the project's task-management binding, its statuses as pick lists, the
 * two switches and a save. Renders a sentence instead when there is no such binding (or two).
 */
export const TicketLifecycle = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const bindings = useProjectBindings(projectId);
  const integrations = useBindableIntegrations('task_management');
  const config = useProjectConfig(projectId);
  const bound = bindings.data?.items ?? [];
  const trackers = bound.filter((item) => item.type === 'task_management');
  const tracker = trackers.length === 1 ? (trackers[0] ?? null) : null;
  const statuses = useTicketStatuses(projectId, tracker?.integration_id ?? null);
  const commands = useOnboardingCommands();
  const [seeded, setSeeded] = useState<{
    /** The tracker binding this draft was seeded from: a different one is seeded afresh. */
    readonly integrationId: string;
    readonly draft: LifecycleDraft;
    readonly dropped: readonly DroppedName[];
  } | null>(null);

  const account = asObject(
    integrations.items.find((item) => item.id === tracker?.integration_id)?.config,
  );
  const overlay = tracker === null ? undefined : bindingConfigOf(bound, tracker.integration_id);
  // Seeded once both reads are in: the effective configuration as the server merges it (the
  // account's document with the binding's overlay on top), matched against the loaded set — and
  // seeded again when the tracker binding changes on this page (another integration bound), once
  // its statuses have been read afresh, so a draft never carries one tracker's names to another.
  const stale = seeded !== null && seeded.integrationId !== tracker?.integration_id;
  useEffect(() => {
    if (
      (seeded === null || stale) &&
      statuses.isSuccess &&
      !statuses.isFetching &&
      integrations.isSuccess &&
      tracker !== null
    ) {
      setSeeded({
        integrationId: tracker.integration_id,
        ...lifecycleDraftOf({ ...(account ?? {}), ...(overlay ?? {}) }, statuses.data.items),
      });
    }
  }, [
    seeded,
    stale,
    statuses.isSuccess,
    statuses.isFetching,
    statuses.data,
    integrations.isSuccess,
    tracker,
    account,
    overlay,
  ]);

  if (bindings.isPending) {
    return <Loading label="Loading the bindings…" />;
  }
  if (trackers.length === 0) {
    return (
      <p className="text-xs text-fg-muted">
        Bind a ticket tracker first: the lifecycle slots are that tracker’s own statuses.
      </p>
    );
  }
  if (tracker === null) {
    return (
      <p className="text-xs text-fg-muted">
        This project binds {trackers.length} ticket trackers, and the pipeline applies a lifecycle
        only to a project with exactly one.
      </p>
    );
  }
  if (statuses.isError) {
    const failure = statusesFailure(statuses.error);
    return (
      <div className="flex flex-col gap-2">
        <ErrorNotice
          title={failure.title}
          {...(failure.detail === undefined ? {} : { detail: failure.detail })}
        />
        <div>
          <Button type="button" onClick={() => void statuses.refetch()}>
            Load the statuses again
          </Button>
        </div>
      </div>
    );
  }
  if (seeded === null || stale) {
    return <Loading label="Loading the tracker’s statuses…" />;
  }

  const { draft, dropped } = seeded;
  const items = statuses.data?.items ?? [];
  const refused = refusedSlots(commands.putBindings.error);
  const error = commands.putBindings.error;
  const setDraft = (next: LifecycleDraft): void =>
    setSeeded({ integrationId: tracker.integration_id, draft: next, dropped });
  const accountPickup = nonEmptyString(account?.pickup_status);
  const hasStoredBlock =
    asObject({ ...(account ?? {}), ...(overlay ?? {}) }.lifecycle) !== undefined;

  return (
    <div className="flex flex-col gap-3" data-ticket-lifecycle={tracker.integration_id}>
      <p className="text-xs text-fg-muted">
        Map the platform’s moments to <UntrustedText value={tracker.name} />
        ’s own statuses. Every slot may be left empty: an empty slot means the ticket is not moved
        at that point, and the stage still runs.
      </p>
      {hasStoredBlock ? null : (
        <p className="text-xs text-fg-muted" data-lifecycle="not-saved">
          No lifecycle is saved for this tracker, so the platform does not claim its tickets — a
          tracker bound before the lifecycle existed, or bound outside the wizard. Saving this form,
          even with every slot empty, starts the claim unless you switch it off.
        </p>
      )}
      {config.data?.status_mapping_superseded === true ? (
        <p className="text-xs" data-lifecycle="status-mapping-superseded">
          <Badge tone="warning">Note</Badge> A slot other than <em>Pick up from</em> is mapped, so
          the configuration’s <code>status_mapping</code> is not applied at all.
        </p>
      ) : null}
      {dropped.map((entry) => (
        <p
          key={`${entry.slot}:${entry.name}`}
          className="text-xs"
          data-lifecycle-dropped={entry.slot}
        >
          <Badge tone="warning">Not listed</Badge> {SLOT_COPY[entry.slot].label} was saved as “
          <UntrustedText value={entry.name} />
          ”, which the tracker no longer lists; saving leaves it out.
        </p>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        {SINGLE_NAME_SLOTS.map((slot) => (
          <SlotRow
            key={slot}
            slot={slot}
            statuses={items}
            value={draft.names[slot]}
            refusal={refused.get(slot)}
            onChange={(name) => setDraft({ ...draft, names: { ...draft.names, [slot]: name } })}
          />
        ))}
        <ReturnedRow
          statuses={items}
          value={draft.returned}
          refusal={refused.get('returned')}
          onChange={(names) => setDraft({ ...draft, returned: names })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.claim}
          onChange={(event) => setDraft({ ...draft, claim: event.target.checked })}
        />
        Claim the ticket before the first run (assign it to the integration’s own account)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.takeAssignedTickets}
          onChange={(event) => setDraft({ ...draft, takeAssignedTickets: event.target.checked })}
        />
        Also start tickets already assigned to a person (only while claiming)
      </label>
      {draft.returned.length > MAX_LIFECYCLE_RETURNED_STATUSES ? (
        <p role="alert" className="text-xs text-danger">
          Returned holds at most {MAX_LIFECYCLE_RETURNED_STATUSES} statuses.
        </p>
      ) : null}
      <div>
        <Button
          tone="primary"
          disabled={
            commands.putBindings.isPending ||
            draft.returned.length > MAX_LIFECYCLE_RETURNED_STATUSES
          }
          onClick={() =>
            commands.putBindings.mutate({
              projectId,
              items: bound.map((item) => ({
                integration_id: item.integration_id,
                config:
                  item.integration_id === tracker.integration_id
                    ? lifecycleOverlayOf(overlay, draft, accountPickup)
                    : bindingConfigOf(bound, item.integration_id),
              })),
            })
          }
        >
          Save the ticket lifecycle
        </Button>
      </div>
      {commands.putBindings.isSuccess ? (
        <p className="text-xs" role="status">
          The ticket lifecycle was saved.
        </p>
      ) : null}
      {error instanceof ApiError && error.code === 'lifecycle_status_unknown' ? (
        <ErrorNotice
          title="Nothing was saved: a slot names a status the tracker does not list."
          detail="The marked slots are refused; pick them again from the list."
        />
      ) : error instanceof ApiError && error.code === 'lifecycle_statuses_unavailable' ? (
        <ErrorNotice
          title="The tracker’s statuses could not be loaded, so nothing was saved."
          detail="Your choices are kept here. Save again once the tracker answers."
        />
      ) : error === null ? null : (
        <ErrorNotice title="The ticket lifecycle was not saved." detail={String(error)} />
      )}
    </div>
  );
};
