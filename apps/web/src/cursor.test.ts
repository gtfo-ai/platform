/**
 * Every clickable control shows a pointer. Tailwind v4's Preflight resets buttons to
 * `cursor: default`, so the restoration in `styles.css`'s base layer is the only thing that gives
 * them one. Asserted from the stylesheet's text, because happy-dom applies no stylesheet.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
const BASE = /@layer base \{([\s\S]*?cursor: pointer;[\s\S]*?)\n\}/.exec(CSS)?.[1] ?? '';

describe('the pointer cursor', () => {
  it('is restored in the base layer, so a cursor utility still overrides it', () => {
    expect(BASE).not.toBe('');
  });

  it.each([
    'button:not(:disabled)',
    '[role="button"]:not([aria-disabled="true"])',
    'input:is([type="submit"], [type="button"], [type="reset"]):not(:disabled)',
    'select:not(:disabled)',
    'summary',
  ])('covers %s', (selector) => {
    expect(BASE).toContain(selector);
  });
});
