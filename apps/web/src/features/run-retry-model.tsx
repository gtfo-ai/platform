/**
 * *Retry run*'s model field (WP-159, backlog 498): a `<select>` over the organisation's model list
 * rather than a free-text box nobody could fill in without knowing Anthropic's ids by heart.
 *
 * - **The options are the server's** (`GET /api/org/models`, the open windows of `price_list`), so
 *   this bundle keeps no list of its own.
 * - **The run's own model is preselected**, and submitting without a change sends **no** `model`:
 *   the new attempt is then re-planned from configuration, which is what "as before" meant when the
 *   field was a text box.
 * - **A current model the list does not carry** (an older or custom id a project pins) is its own
 *   option, labelled *not priced*, and stays selected. It is never replaced by the first entry.
 * - ***Other…*** opens a text field and sends `allow_unlisted_model: true`: the server refuses an
 *   unlisted id without it (`409 model_not_listed`), so a typo cannot reach a run by accident.
 * - **A failed read** leaves the run's model and *Other…*, and says the list could not be loaded.
 *
 * Every id rendered here is text in an `<option>` — a React text node, never markup (BD-022).
 */
import type { ReactElement } from 'react';
import { useOrgModels } from '../app/queries.js';
import { ErrorNotice } from '../ui/kit.js';

/**
 * The select's value for *Other…*: the empty string, which no model id can be (the run record's
 * `model` and the list's `model_id` are both non-empty), so it cannot collide with one.
 */
export const OTHER_MODEL = '';

/** What the field holds: the select's value and the *Other…* text. */
export interface RetryModelChoice {
  readonly selected: string;
  readonly other: string;
}

/** The field's starting state for a run: its own model, selected. */
export const initialRetryModelChoice = (current: string): RetryModelChoice => ({
  selected: current,
  other: '',
});

/**
 * The retry body's model half. `{}` when nothing changed (the run's own model, or an empty
 * *Other…*), a listed id on its own, and a typed id with `allowUnlistedModel: true`.
 */
export const retryModelRequest = (
  current: string,
  choice: RetryModelChoice,
): { readonly model?: string; readonly allowUnlistedModel?: true } => {
  if (choice.selected === OTHER_MODEL) {
    const typed = choice.other.trim();
    return typed === '' ? {} : { model: typed, allowUnlistedModel: true };
  }
  return choice.selected === current ? {} : { model: choice.selected };
};

/**
 * The options, in order: the run's own model first when the list does not carry it (labelled *not
 * priced* once the list has answered, unlabelled while it has not), then the list.
 */
export const retryModelOptions = (
  current: string,
  listed: readonly string[] | null,
): readonly { readonly value: string; readonly label: string }[] => {
  const ids = listed ?? [];
  const own = ids.includes(current)
    ? []
    : [{ value: current, label: listed === null ? current : `${current} (not priced)` }];
  return [...own, ...ids.map((id) => ({ value: id, label: id }))];
};

export const RetryModelField = ({
  current,
  choice,
  onChange,
}: {
  readonly current: string;
  readonly choice: RetryModelChoice;
  readonly onChange: (next: RetryModelChoice) => void;
}): ReactElement => {
  const models = useOrgModels();
  const listed = models.data === undefined ? null : models.data.models.map((m) => m.model_id);
  const options = retryModelOptions(current, listed);
  return (
    <>
      <select
        aria-label="Retry with model"
        value={choice.selected}
        onChange={(event) => {
          onChange({ ...choice, selected: event.target.value });
        }}
        className="max-w-56 rounded-md border border-line bg-surface px-2 py-1 text-sm text-fg"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        <option value={OTHER_MODEL}>Other…</option>
      </select>
      {choice.selected === OTHER_MODEL ? (
        <input
          aria-label="Other model id"
          value={choice.other}
          maxLength={128}
          onChange={(event) => {
            onChange({ ...choice, other: event.target.value });
          }}
          placeholder="A model id the list does not carry"
          className="w-56 rounded-md border border-line bg-surface px-2 py-1 text-sm"
        />
      ) : null}
      {models.isError ? (
        <ErrorNotice
          title="The model list could not be loaded."
          detail="This run's own model and Other… are still offered."
        />
      ) : null}
    </>
  );
};
