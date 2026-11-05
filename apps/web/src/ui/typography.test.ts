/**
 * The type foundation (TD-033 § 3, research/19 § 4.1), asserted from the stylesheet's text because
 * happy-dom applies no stylesheet:
 *
 * - Inter Variable is **self-hosted**: one `@font-face`, the latin woff2 of
 *   `@fontsource-variable/inter`, `font-display: swap`, the whole 100–900 weight axis (so the
 *   sign-in headline's `font-black` is Inter Black), and no other origin — the production policy's
 *   `font-src 'self'` is unchanged (`test/web-e2e/csp.spec.ts` loads it under that policy);
 * - the body is Inter at 14 px with the system stack behind it, and monospace is untouched;
 * - the type scale is GitHub's 12 / 14 / 16 / 20 / 24 / 32, and a box's radius is 6 px.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');
const FONT_FACES = [...CSS.matchAll(/@font-face \{([^}]*)\}/g)].map((match) => match[1] ?? '');

const themeValue = (name: string): string | undefined =>
  new RegExp(`\\n\\s*${name}:\\s*([^;]+);`)
    .exec(/@theme \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? '')?.[1]
    ?.trim();

describe('the font (TD-033 § 3)', () => {
  it('declares exactly one font face, the self-hosted latin Inter Variable', () => {
    expect(FONT_FACES).toHaveLength(1);
    const [face] = FONT_FACES;
    expect(face).toContain('font-family: "Inter Variable"');
    expect(face).toContain('font-display: swap');
    expect(face).toContain('font-weight: 100 900');
    expect(face).toContain('url("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2")');
    // Nothing fetched from another origin: the stylesheet's only URL is that package path.
    expect([...CSS.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1])).toEqual([
      '"@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"',
    ]);
  });

  it('sets the body in Inter at 14 px with the system stack behind it', () => {
    expect(themeValue('--font-sans')).toMatch(/^"Inter Variable", ui-sans-serif, system-ui,/);
    expect(themeValue('--font-mono')).toBeUndefined();
    const body = /\nbody \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(body).toContain('font-family: var(--font-sans);');
    expect(body).toContain('font-size: var(--text-sm);');
  });
});

describe('the scale (research/19 § 4.1)', () => {
  it.each([
    ['--text-xs', '0.75rem'],
    ['--text-sm', '0.875rem'],
    ['--text-base', '1rem'],
    ['--text-lg', '1.25rem'],
    ['--text-xl', '1.25rem'],
    ['--text-2xl', '1.5rem'],
    ['--text-3xl', '2rem'],
    ['--radius-lg', '0.375rem'],
  ])('%s is %s', (name, value) => {
    expect(themeValue(name)).toBe(value);
  });
});
