/**
 * The words `./read-error.ts` and its lazily-loaded sentence table (`./error-sentences.ts`) share
 * (S-25.18): the settings a refusal's paths name, and the sentence for a refusal with no state to
 * name. A module of their own so the table can use them without importing the module that loads it.
 */
import { configFieldLabel } from '../ui/humanize.js';
import type { ApiError } from './http.js';

/**
 * The settings a list of key paths names, as labels, once each: `config.base_url` → "Base URL",
 * `statuses.0` → "Statuses". The last named segment is the setting; an index is not a name.
 */
export const settingNames = (paths: readonly string[]): string[] => [
  ...new Set(
    paths
      .map((path) =>
        path
          .split(/[./[\]]/)
          .filter((segment) => !/^\d+$/.test(segment))
          .filter((segment) => segment !== '')
          .at(-1),
      )
      .filter((segment): segment is string => segment !== undefined && segment !== '')
      .map(configFieldLabel),
  ),
];

/** "Some settings are invalid: Base URL, Project key." — or without the list when none is named. */
export const invalidSettingsSentence = (paths: readonly string[]): string => {
  const names = settingNames(paths);
  return names.length === 0
    ? 'Some settings are invalid.'
    : `Some settings are invalid: ${names.join(', ')}.`;
};

export const fieldNames = (details: ApiError['details']): string[] =>
  settingNames(details.map((detail) => detail.path));

/** The sentence a refusal without its state says: never "reload" as though that were the fix. */
export const TRANSITION_UNKNOWN =
  'This cannot be done in the state it is in now. Open it to see where it stands and what it needs.';
