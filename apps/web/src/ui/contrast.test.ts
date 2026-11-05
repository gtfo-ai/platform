/**
 * The colour tokens' contrast, enforced rather than remembered (TD-033 § 2).
 *
 * technical/09 used to carry hand-measured ratios; this computes them. It parses `styles.css`,
 * resolves each theme the way the cascade does — `:root` (the palette and the top bar), then
 * `:root, [data-theme="dark"]`, then, for light, `[data-theme="light"]` on top, because
 * `<html data-theme="light">` matches `:root` as well — and asks WCAG 2.2's question of every pair
 * declared below:
 *
 * - **4.5:1** for text (1.4.3): every foreground a screen writes text in, on every ground it sits on;
 * - **3:1** for the non-text pairs (1.4.11): the input border, the focus ring, the selected-tab
 *   underline and the status icons, against the grounds they are drawn on.
 *
 * The pair list is the policy. A token that regresses fails here by name; a new token that a screen
 * writes text in belongs in the list. Two structural checks keep the parse honest (standing rule 4):
 * both themes must resolve every token the pairs name to a hex value, and the light block must
 * re-declare every name the dark block declares, or it would silently inherit dark. The checker
 * itself is calibrated against a planted regression, so "no failures" cannot be the reading of a
 * checker that checks nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The repository's one comment stripper (`source-scanner.test.ts` refuses a second); a stylesheet
// has only block comments, which it removes like any other.
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');

type Tokens = ReadonlyMap<string, string>;

/** The declarations of the first rule whose selector list is exactly `selector`. */
const declarationsOf = (css: string, selector: string): Map<string, string> => {
  const text = withoutComments(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(text);
  const found = new Map<string, string>();
  if (match === null) {
    return found;
  }
  for (const declaration of (match[1] ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const name = declaration.slice(0, colon).trim();
    if (name.startsWith('--')) {
      found.set(name, declaration.slice(colon + 1).trim());
    }
  }
  return found;
};

const SELECTORS = {
  root: ':root',
  dark: ':root,\n[data-theme="dark"]',
  light: '[data-theme="light"]',
} as const;

const themesOf = (css: string): { readonly dark: Tokens; readonly light: Tokens } => {
  const root = declarationsOf(css, SELECTORS.root);
  const dark = declarationsOf(css, SELECTORS.dark);
  const light = declarationsOf(css, SELECTORS.light);
  return {
    dark: new Map([...root, ...dark]),
    light: new Map([...root, ...dark, ...light]),
  };
};

/** A token's value with every `var(--x)` resolved; `undefined` when it does not end in a hex. */
const resolve = (tokens: Tokens, name: string, depth = 0): string | undefined => {
  const value = tokens.get(name);
  if (value === undefined || depth > 10) {
    return undefined;
  }
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference !== null) {
    return resolve(tokens, reference[1] ?? '', depth + 1);
  }
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
};

const luminance = (hex: string): number => {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

interface Pair {
  readonly fg: string;
  readonly bg: string;
  readonly min: 4.5 | 3;
}

const text = (fgs: readonly string[], bgs: readonly string[]): Pair[] =>
  fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, min: 4.5 as const })));
const nonText = (fgs: readonly string[], bgs: readonly string[]): Pair[] =>
  fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, min: 3 as const })));

const GROUNDS = ['--bg-canvas', '--bg-subtle', '--bg-muted'] as const;
const STATUSES = ['success', 'danger', 'attention', 'done', 'running'] as const;
const AVATARS = [
  '--avatar-1',
  '--avatar-2',
  '--avatar-3',
  '--avatar-4',
  '--avatar-5',
  '--avatar-6',
];

/** Every pair a screen draws, by the rule it is held to. */
const PAIRS: readonly Pair[] = [
  // Body text, muted text, placeholders and links on every ground a row can have.
  ...text(['--fg-default', '--fg-muted', '--fg-subtle', '--fg-link'], GROUNDS),
  ...text(['--fg-default', '--fg-muted'], ['--bg-inset']),
  // The beacon button, and text on the link colour used as a fill (`bg-accent text-accent-fg`).
  ...text(['--action-primary-fg'], ['--action-primary-bg', '--action-primary-hover']),
  ...text(['--fg-on-emphasis'], ['--fg-link']),
  // Status words (StateLabel, Flash, Badge): on the page, on a box header, and on their own tint.
  ...STATUSES.flatMap((status) =>
    text([`--${status}-fg`], ['--bg-canvas', '--bg-subtle', `--${status}-bg`]),
  ),
  // A Flash's title and body sit on its tint.
  ...text(
    ['--fg-default', '--fg-muted'],
    STATUSES.map((status) => `--${status}-bg`),
  ),
  ...text(['--danger-fg'], ['--bg-muted']),
  ...text(['--avatar-fg'], AVATARS),
  // Non-text: a field's edge, the focus ring and the selected underline on what they border.
  ...nonText(
    ['--border-input', '--focus-ring', '--accent-selected'],
    ['--bg-canvas', '--bg-subtle'],
  ),
];

/**
 * The top bar is a `data-theme="dark"` scope in both themes (`app/shell.tsx`), so what is drawn on
 * its night ground is the dark tokens' — checked against the dark theme only, where they resolve.
 */
const HEADER_PAIRS: readonly Pair[] = [
  ...text(['--fg-default', '--fg-muted', '--fg-link'], ['--bg-header', '--bg-subtle']),
  ...STATUSES.flatMap((status) => text([`--${status}-fg`], ['--bg-header', `--${status}-bg`])),
  ...nonText(['--focus-ring', '--accent-selected', '--border-input'], ['--bg-header']),
];

/** The pairs that fail in a theme, as readable lines. */
const failures = (tokens: Tokens, pairs: readonly Pair[]): string[] =>
  pairs.flatMap((pair) => {
    const fg = resolve(tokens, pair.fg);
    const bg = resolve(tokens, pair.bg);
    if (fg === undefined || bg === undefined) {
      return [`${pair.fg} on ${pair.bg}: not a resolvable hex value`];
    }
    const ratio = contrast(fg, bg);
    return ratio >= pair.min
      ? []
      : [`${pair.fg} ${fg} on ${pair.bg} ${bg}: ${ratio.toFixed(2)}:1 < ${pair.min}:1`];
  });

const THEMES = themesOf(CSS);

describe('the colour tokens (TD-033 § 2)', () => {
  it('parses all three token blocks', () => {
    // An empty parse would report no failures for ever.
    expect(declarationsOf(CSS, SELECTORS.root).size).toBeGreaterThan(20);
    expect(declarationsOf(CSS, SELECTORS.dark).size).toBeGreaterThan(25);
    expect(declarationsOf(CSS, SELECTORS.light).size).toBeGreaterThan(25);
    expect(PAIRS.length).toBeGreaterThan(50);
  });

  it('declares in the light block every name the dark block declares', () => {
    const dark = [...declarationsOf(CSS, SELECTORS.dark).keys()].sort();
    const light = [...declarationsOf(CSS, SELECTORS.light).keys()].sort();
    expect(light).toEqual(dark);
  });

  it.each(['dark', 'light'] as const)(
    'meets 4.5:1 for text and 3:1 for the rest in %s',
    (theme) => {
      expect(failures(THEMES[theme], PAIRS)).toEqual([]);
    },
  );

  it('meets the same bars on the top bar, which is a dark scope in both themes', () => {
    expect(HEADER_PAIRS.length).toBeGreaterThan(10);
    expect(failures(THEMES.dark, HEADER_PAIRS)).toEqual([]);
  });

  it('keeps the sign-in palette at the values WP-291 measured', () => {
    expect(
      Object.fromEntries(
        ['night', 'ink', 'lit', 'edge', 'text', 'muted', 'beacon'].map((name) => [
          name,
          resolve(THEMES.dark, `--signin-${name}`),
        ]),
      ),
    ).toEqual({
      night: '#15132b',
      ink: '#1f1c3d',
      lit: '#3a3570',
      edge: '#7671b0',
      text: '#ece9ff',
      muted: '#a7a2cc',
      beacon: '#f4b860',
    });
  });

  it('draws the dark theme in the brand palette and the top bar night in both themes', () => {
    expect(resolve(THEMES.dark, '--bg-canvas')).toBe('#15132b');
    expect(resolve(THEMES.dark, '--bg-subtle')).toBe('#1f1c3d');
    expect(resolve(THEMES.dark, '--action-primary-bg')).toBe('#f4b860');
    expect(resolve(THEMES.light, '--bg-canvas')).toBe('#ffffff');
    for (const theme of [THEMES.dark, THEMES.light]) {
      expect(resolve(theme, '--bg-header')).toBe('#0f0d22');
    }
  });

  it('keeps base hex values inside the token blocks', () => {
    const blocks = [SELECTORS.root, SELECTORS.dark, SELECTORS.light].map((selector) =>
      [...declarationsOf(CSS, selector).values()].join(';'),
    );
    const everywhere = withoutComments(CSS).match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    const inBlocks = blocks.join(';').match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(everywhere.length).toBeGreaterThan(0);
    expect(everywhere.length).toBe(inBlocks.length);
  });

  it('is a checker that can fail: a planted regression is reported by name', () => {
    // Lavender links on a white page (2.2:1): the calibration for the two cases above.
    const planted = CSS.replace('--fg-link: #5646d6;', '--fg-link: #b3a8ff;');
    expect(planted).not.toBe(CSS);
    const found = failures(themesOf(planted).light, PAIRS);
    expect(found.some((line) => line.startsWith('--fg-link #b3a8ff on --bg-canvas #ffffff'))).toBe(
      true,
    );
    // And the beacon underline, 1.8:1 on white, fails the 3:1 rule.
    const underline = CSS.replace('--accent-selected: #b7791f;', '--accent-selected: #f4b860;');
    expect(failures(themesOf(underline).light, PAIRS)).toContain(
      '--accent-selected #f4b860 on --bg-canvas #ffffff: 1.77:1 < 3:1',
    );
  });

  it('computes the WCAG ratio (reference values)', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // WP-291's measurement: night on beacon.
    expect(contrast('#15132b', '#f4b860')).toBeCloseTo(10.23, 1);
  });
});
