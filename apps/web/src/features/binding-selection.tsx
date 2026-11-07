/**
 * Which integrations a project uses — the one selection the New project wizard's *Connect* step and
 * the project settings' *Connections* section both edit (S-23.21).
 *
 * `PUT /api/projects/:id/bindings` **replaces the whole set**: an integration missing from the
 * request is unbound. So the selection is never started at empty. It is the stored bindings until a
 * person changes it, and a changed bindings read (the refetch after a save, or another administrator's
 * save) starts it again from what is stored — a draft remembers the stored set it was drafted
 * against and is discarded once that set is no longer the one in force. Until the bindings have been
 * read there is no selection at all, and nothing can be saved.
 *
 * The save says what it will do: it is disabled while the selection equals the stored set, it is
 * labelled with the change (*Save 2 connections*, *Remove the git host connection*, *Save 1
 * connection, remove 1*), and a removal
 * asks first, naming what stops working. The wizard's step said "Bind 0 integrations" and unbound
 * everything (the final UX audit, § 0 item 1).
 *
 * A stored binding whose integration the picker does not list (retired, or not readable for this
 * role) stays in the selection: no checkbox can clear it, so no save removes it unasked.
 */
import type { IntegrationType, ProjectBindingSummary } from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import { useProjectBindings } from '../app/queries.js';
import { Dialog } from '../ui/dialog.js';
import { Button } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { INTEGRATION_TYPE_LABEL } from '../ui/words/integrations.js';

/** What stops when a binding of this kind is removed — said in the confirmation. */
export const BINDING_REMOVAL_CONSEQUENCE: Readonly<Record<IntegrationType, string>> = {
  task_management:
    'no new ticket is picked up from it, and the project’s tickets are no longer moved',
  git: 'agents can no longer push branches or open merge requests, so no task reaches a merge request',
  communication: 'questions, approvals and the daily digest are no longer posted there',
  logs: 'agents can no longer search its logs',
  errors: 'agents can no longer read its error reports',
};

export interface BindingSelection {
  /** Whether the stored bindings have been read; until then nothing is selectable or savable. */
  readonly ready: boolean;
  /** The bindings read's failure, shown by the screen; `null` while it is loading or answered. */
  readonly error: Error | null;
  readonly stored: readonly ProjectBindingSummary[];
  readonly selected: readonly string[];
  readonly isSelected: (integrationId: string) => boolean;
  readonly toggle: (integrationId: string, on: boolean) => void;
  /** Selected and not stored. */
  readonly added: readonly string[];
  /** Stored and not selected. */
  readonly removed: readonly ProjectBindingSummary[];
  readonly changed: boolean;
}

/** The stored set's identity: the sorted integration ids. */
const signatureOf = (ids: readonly string[]): string => [...ids].sort().join(',');

export const useBindingSelection = (projectId: string): BindingSelection => {
  const bindings = useProjectBindings(projectId);
  const stored = bindings.data?.items ?? [];
  const ready = bindings.isSuccess;
  const storedIds = stored.map((binding) => binding.integration_id);
  const basis = ready ? signatureOf(storedIds) : null;
  const [draft, setDraft] = useState<{
    readonly basis: string;
    readonly ids: readonly string[];
  } | null>(null);
  const selected = draft !== null && draft.basis === basis ? draft.ids : storedIds;
  const added = selected.filter((id) => !storedIds.includes(id));
  const removed = stored.filter((binding) => !selected.includes(binding.integration_id));
  return {
    ready,
    error: bindings.isError ? bindings.error : null,
    stored,
    selected,
    isSelected: (integrationId) => selected.includes(integrationId),
    toggle: (integrationId, on) => {
      if (basis === null) {
        return;
      }
      const without = selected.filter((id) => id !== integrationId);
      setDraft({ basis, ids: on ? [...without, integrationId] : without });
    },
    added,
    removed,
    changed: added.length > 0 || removed.length > 0,
  };
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The save button's label: what pressing it changes. */
export const bindingSaveLabel = (selection: BindingSelection): string => {
  if (!selection.changed) {
    return 'No changes to save';
  }
  if (selection.added.length === 0) {
    const [only] = selection.removed;
    return selection.removed.length === 1 && only !== undefined
      ? `Remove the ${INTEGRATION_TYPE_LABEL[only.type].toLowerCase()} connection`
      : `Remove ${plural(selection.removed.length, 'connection')}`;
  }
  const save = `Save ${plural(selection.selected.length, 'connection')}`;
  return selection.removed.length === 0 ? save : `${save}, remove ${selection.removed.length}`;
};

/**
 * The save, with its confirmation: a selection that removes a stored binding opens a dialog that
 * names each one and what stops working, and only its *Remove* sends the request.
 */
export const SaveBindingsButton = ({
  selection,
  pending,
  onSave,
}: {
  readonly selection: BindingSelection;
  readonly pending: boolean;
  readonly onSave: (integrationIds: readonly string[]) => void;
}): ReactElement => {
  const [confirming, setConfirming] = useState(false);
  const label = bindingSaveLabel(selection);
  const disabled = pending || !selection.ready || !selection.changed;
  if (selection.removed.length === 0) {
    return (
      <Button disabled={disabled} onClick={() => onSave(selection.selected)}>
        {label}
      </Button>
    );
  }
  const title =
    selection.removed.length === 1
      ? `Remove ${sanitiseUntrusted(selection.removed[0]?.name ?? '')}?`
      : `Remove ${plural(selection.removed.length, 'connection')}?`;
  return (
    <Dialog
      open={confirming}
      onOpenChange={setConfirming}
      title={title}
      description={
        selection.removed.length === 1
          ? 'The project stops using it as soon as you confirm. The integration itself is kept, and can be bound again.'
          : 'The project stops using them as soon as you confirm. The integrations themselves are kept, and can be bound again.'
      }
      trigger={<Button disabled={disabled}>{label}</Button>}
      footer={
        <>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button
            tone="danger"
            onClick={() => {
              setConfirming(false);
              onSave(selection.selected);
            }}
          >
            {selection.removed.length === 1
              ? 'Remove connection'
              : `Remove ${plural(selection.removed.length, 'connection')}`}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-1" aria-label="What stops working">
        {selection.removed.map((binding) => (
          <li key={binding.integration_id} data-removed-binding={binding.integration_id}>
            <UntrustedText value={binding.name} />
            {` (${INTEGRATION_TYPE_LABEL[binding.type]}): ${BINDING_REMOVAL_CONSEQUENCE[binding.type]}.`}
          </li>
        ))}
      </ul>
    </Dialog>
  );
};
