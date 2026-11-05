/** Joins the class names that are strings and drops the rest (`false`, `null`, `undefined`, `''`). */
export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter((part) => typeof part === 'string' && part !== '').join(' ');

/**
 * The one focus ring (TD-033 § 2: lavender in dark, indigo in light, ≥ 3:1 on both grounds —
 * `contrast.test.ts`). `focus-visible`, so a mouse click draws none and a keyboard user always sees it.
 */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
