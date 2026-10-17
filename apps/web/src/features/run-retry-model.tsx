/**
 * *Retry run*'s model field (WP-159, backlog 498): a `<select>` over the organisation's model list
 * rather than a free-text box nobody could fill in without knowing Anthropic's ids by heart.
 *
 * - **The options are the server's** (`GET /api/org/models`, the open windows of `price_list`), so
 *   this bundle keeps no list of its own.
 * - ***Configured (X)* is preselected** (WP-167 ruling (a), backlog 514), where X is the run read's
 *   `retry_defaults.model` — the stage's configured model, resolved by the planner's own function.
 *   Submitting it sends **no** `model` (WP-159 ruling (c) stands), so the new attempt is re-planned
 *   from configuration and the label says what that is. Until WP-167 the run's own model was
 *   preselected, which for a run that was itself an override read as "that model again" and ran the
 *   configured one. The configuration can still change between the read and the submit; the
 *   server resolves the model again at the job.
 * - **The run's own model is an ordinary option**, and choosing it sends it. When the list does not
 *   carry it (an older or custom id a project pins) it is labelled *not priced*.
 * - ***Other…*** opens a text field and sends `allow_unlisted_model: true`: the server refuses an
 *   unlisted id without it (`409 model_not_listed`), so a typo cannot reach a run by accident.
 * - **A failed read** leaves *Configured (…)*, the run's model and *Other…*, and says the list could
 *   not be loaded.
 *
 * Every id rendered here is text in an `<option>` — a React text node, never markup (BD-022).
 */
import type { ReactElement } from 'react';
import { useOrgModels } from '../app/queries.js';
import { ErrorNotice } from '../ui/kit.js';

/**
 * The select's values: *Configured (…)*, *Other…*, and `model:<id>` for every model option. A model
 * option carries the prefix, so no model id — a free string — can collide with either keyword.
 */
export const CONFIGURED_MODEL = 'configured';
export const OTHER_MODEL = 'other';
const MODEL_PREFIX = 'model:';
export const modelOptionValue = (id: string): string => `${MODEL_PREFIX}${id}`;

/** What the field holds: the select's value and the *Other…* text. */
export interface RetryModelChoice {
  readonly selected: string;
  readonly other: string;
}

/** The field's starting state: *Configured (…)*, selected (WP-167). */
export const INITIAL_RETRY_MODEL_CHOICE: RetryModelChoice = {
  selected: CONFIGURED_MODEL,
  other: '',
};

/**
 * The retry body's model half. `{}` for *Configured (…)* and for an empty *Other…*, a chosen id on
 * its own — the run's own model included — and a typed id with `allowUnlistedModel: true`.
 */
export const retryModelRequest = (
  choice: RetryModelChoice,
): { readonly model?: string; readonly allowUnlistedModel?: true } => {
  if (choice.selected === OTHER_MODEL) {
    const typed = choice.other.trim();
    return typed === '' ? {} : { model: typed, allowUnlistedModel: true };
  }
  return choice.selected.startsWith(MODEL_PREFIX)
    ? { model: choice.selected.slice(MODEL_PREFIX.length) }
    : {};
};

/** *Configured (X)*, or *Configured* when the read named no stage (an ask run). */
export const configuredLabel = (configured: string | null): string =>
  configured === null ? 'Configured' : `Configured (${configured})`;

/**
 * The options, in order: *Configured (…)*, the run's own model when the list does not carry it
 * (labelled *not priced* once the list has answered, unlabelled while it has not), then the list.
 */
export const retryModelOptions = (
  current: string,
  configured: string | null,
  listed: readonly string[] | null,
): readonly { readonly value: string; readonly label: string }[] => {
  const ids = listed ?? [];
  const own = ids.includes(current)
    ? []
    : [
        {
          value: modelOptionValue(current),
          label: listed === null ? current : `${current} (not priced)`,
        },
      ];
  return [
    { value: CONFIGURED_MODEL, label: configuredLabel(configured) },
    ...own,
    ...ids.map((id) => ({ value: modelOptionValue(id), label: id })),
  ];
};

export const RetryModelField = ({
  current,
  configured,
  choice,
  onChange,
}: {
  readonly current: string;
  /** `retry_defaults.model`: what *Configured (…)* runs; `null` for a run with no stage. */
  readonly configured: string | null;
  readonly choice: RetryModelChoice;
  readonly onChange: (next: RetryModelChoice) => void;
}): ReactElement => {
  const models = useOrgModels();
  const listed = models.data === undefined ? null : models.data.models.map((m) => m.model_id);
  const options = retryModelOptions(current, configured, listed);
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
          detail="The configured model, this run's own model and Other… are still offered."
        />
      ) : null}
    </>
  );
};
