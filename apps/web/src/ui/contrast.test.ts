/**
 * The colour tokens' contrast, enforced rather than remembered (TD-033 § 2 and its 2026-11-05
 * amendment: one dark theme, the page darker than its cards).
 *
 * technical/09 used to carry hand-measured ratios; this computes them. It parses `styles.css`'s one
 * `:root` block, resolves every `var(--x)` the way the cascade does, and asks WCAG 2.2's question of
 * every pair declared below:
 *
 * - **4.5:1** for text (1.4.3): every foreground a screen writes text in, on **both** grounds a
 *   screen has — the page (`--bg-canvas`) and the card (`--bg-default`) — and on the header rows,
 *   hover state and inputs' fill that sit on them;
 * - **3:1** for the non-text pairs (1.4.11): the input border, the focus ring, the selected-tab
 *   underline and the status icons, against the grounds they are drawn on.
 *
 * The pair list is the policy. A token that regresses fails here by name; a new token that a screen
 * writes text in belongs in the list. Two structural checks keep the parse honest (standing rule 4):
 * every token the pairs name must resolve to a hex value, and no `[data-theme]` rule may come back.
 * The checker itself is calibrated against a planted regression, so "no failures" cannot be the
 * reading of a checker that checks nothing.
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

/** The one theme: `:root` holds the palette and every semantic token (TD-033's 2026-11-05 amendment). */
const tokensOf = (css: string): Tokens => declarationsOf(css, ':root');

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

/** The two grounds every screen has: the page and the card (TD-033's 2026-11-05 amendment). */
const PAGE_AND_CARD = ['--bg-canvas', '--bg-default'] as const;
/** What sits on them: box header rows and selected rows, the hover state, the inputs' fill. */
const GROUNDS = [...PAGE_AND_CARD, '--bg-subtle', '--bg-muted', '--bg-inset'] as const;
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
  // The beacon button, and text on the link colour used as a fill (`bg-accent text-accent-fg`).
  ...text(['--action-primary-fg'], ['--action-primary-bg', '--action-primary-hover']),
  ...text(['--fg-on-emphasis'], ['--fg-link']),
  // Status words (StateLabel, Flash, Badge): on the page, on a card, on a box header, on their tint.
  ...STATUSES.flatMap((status) =>
    text([`--${status}-fg`], [...PAGE_AND_CARD, '--bg-subtle', '--bg-muted', `--${status}-bg`]),
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
    [...PAGE_AND_CARD, '--bg-subtle', '--bg-inset'],
  ),
];

/** What is drawn on the top bar's ground (`app/shell.tsx`). */
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

const TOKENS = tokensOf(CSS);

describe('the colour tokens (TD-033 § 2, one dark theme)', () => {
  it('parses the token block', () => {
    // An empty parse would report no failures for ever.
    expect(TOKENS.size).toBeGreaterThan(50);
    expect(PAIRS.length).toBeGreaterThan(50);
  });

  it('has one theme: no `[data-theme]` rule, and `color-scheme: dark` on the root', () => {
    expect(withoutComments(CSS)).not.toMatch(/data-theme/);
    expect(withoutComments(CSS)).not.toMatch(/prefers-color-scheme/);
    expect(/:root\s*\{[^}]*color-scheme:\s*dark;/.test(withoutComments(CSS))).toBe(true);
  });

  it('meets 4.5:1 for text and 3:1 for the rest, on the page and on a card', () => {
    expect(failures(TOKENS, PAIRS)).toEqual([]);
  });

  it('meets the same bars on the top bar', () => {
    expect(HEADER_PAIRS.length).toBeGreaterThan(10);
    expect(failures(TOKENS, HEADER_PAIRS)).toEqual([]);
  });

  it('keeps the sign-in palette at the values WP-291 measured', () => {
    expect(
      Object.fromEntries(
        ['night', 'ink', 'lit', 'edge', 'text', 'muted', 'beacon'].map((name) => [
          name,
          resolve(TOKENS, `--signin-${name}`),
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

  it("puts the page on the top bar's deep night and the cards one step lighter", () => {
    expect(resolve(TOKENS, '--bg-header')).toBe('#0f0d22');
    expect(resolve(TOKENS, '--bg-canvas')).toBe('#0f0d22');
    expect(resolve(TOKENS, '--bg-default')).toBe('#15132b');
    expect(resolve(TOKENS, '--bg-subtle')).toBe('#1f1c3d');
    expect(resolve(TOKENS, '--bg-muted')).toBe('#29254d');
    expect(resolve(TOKENS, '--action-primary-bg')).toBe('#f4b860');
    // The order is the point: each layer is lighter than the one it sits on.
    const layers = ['--bg-canvas', '--bg-default', '--bg-subtle', '--bg-muted'].map((name) =>
      luminance(resolve(TOKENS, name) ?? '#000000'),
    );
    expect(layers).toEqual([...layers].sort((a, b) => a - b));
    expect(new Set(layers).size).toBe(layers.length);
  });

  it('maps the cards and the pre-TD-033 surface alias onto the card ground', () => {
    // `bg-surface` (the error boundary's card, the office nameplate) and `bg-default` (Box, Card,
    // ListBox, dialogs, menus) must not read the page colour, or the cards vanish into the page.
    expect(withoutComments(CSS)).toMatch(/--color-surface:\s*var\(--bg-default\);/);
    expect(withoutComments(CSS)).toMatch(/--color-default:\s*var\(--bg-default\);/);
  });

  it('keeps base hex values inside the token block', () => {
    const inBlock = [...declarationsOf(CSS, ':root').values()].join(';');
    const everywhere = withoutComments(CSS).match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    const declared = inBlock.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(everywhere.length).toBeGreaterThan(0);
    expect(everywhere.length).toBe(declared.length);
  });

  it('is a checker that can fail: a planted regression is reported by name', () => {
    // Subtle text dimmed to the border colour: 1.6:1 on the page.
    const planted = CSS.replace('--fg-subtle: #9893c4;', '--fg-subtle: #3a3570;');
    expect(planted).not.toBe(CSS);
    const found = failures(tokensOf(planted), PAIRS);
    expect(
      found.some((line) => line.startsWith('--fg-subtle #3a3570 on --bg-canvas #0f0d22')),
    ).toBe(true);
    expect(
      found.some((line) => line.startsWith('--fg-subtle #3a3570 on --bg-default #15132b')),
    ).toBe(true);
    // And an input edge at the border colour fails the 3:1 rule on a card.
    const edge = CSS.replace('--border-input: var(--brand-edge);', '--border-input: #2c2856;');
    expect(edge).not.toBe(CSS);
    expect(
      failures(tokensOf(edge), PAIRS).some((line) =>
        line.startsWith('--border-input #2c2856 on --bg-default #15132b'),
      ),
    ).toBe(true);
  });

  it('computes the WCAG ratio (reference values)', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // WP-291's measurement: night on beacon.
    expect(contrast('#15132b', '#f4b860')).toBeCloseTo(10.23, 1);
  });
});
