/**
 * **A bordered box sits on the card ground** (S-25.10, TD-033's 2026-11-05 amendment).
 *
 * The owner, on project Budgets' empty state: "many cards across the platform still use the same
 * background colour as the body/content background itself". The amendment puts the page on deep
 * night (`--bg-canvas`) and every card, box, list box, dialog, menu and blankslate one step lighter
 * on night (`--bg-default`, Tailwind `bg-default`/`bg-surface`). A box drawn with a border and a
 * radius but no ground of its own shows the page through it — `Blankslate` did, so every empty
 * state on the platform was a frame round the page's colour.
 *
 * ### What the scan reads
 *
 * Every intrinsic JSX element (`<div`, `<section`, `<dl`, …) in `apps/web/src` outside `worker/`
 * (git's census, so an untracked file is read too; test files excepted; comments stripped), from
 * its `<` to the `>` that closes it at brace depth 0. Its class text is every string literal in its
 * `className` attribute **plus** what an identifier in that attribute resolves to: a `const NAME = …` in the
 * same file or an exported one anywhere in the sources, and from there one or two more hops through
 * module-level SCREAMING_CASE tables (`look.box` → `LOOK[tone]` → `const LOOK = {…}`). An element
 * fails when that text has a radius (`rounded`, `rounded-md`, …), a whole border (`border`) and no
 * **card-ground** class — an unprefixed `bg-*` that is not `bg-canvas`, `bg-inset`, `bg-header` or
 * `bg-transparent`, which are the page's own colours (or none). `hover:bg-subtle` is a state, not a
 * ground.
 *
 * ### What is exempt, and why
 *
 * - **Controls** (`<input>`, `<select>`, `<textarea>`, `<button>`): a field keeps its own field
 *   ground and edge (`form-edge-census.test.ts`, `ui/select.tsx`), a button its tone's
 *   (`buttonClassName`).
 * - **Pills and dots** (`rounded-full` as the only radius): a badge, a state label, a step number
 *   or the running pill is a mark on whatever it sits on, not a container.
 * - **The list below** — each entry a genuine exception with its reason, matched by a fragment of
 *   the element's own text; an entry that matches nothing fails too, so the list cannot go stale.
 *
 * ### What it cannot see, stated rather than implied
 *
 * - **A component's className prop** (`<Card className=…>`): only intrinsic elements are read, and
 *   a component's own elements are read where it renders them.
 * - **A class that arrives as a prop** (`className={className}` in a wrapper) or **is built at run
 *   time** (`'border-' + tone`).
 * - **A box with a border and no radius** (`border border-line` alone): a divider and a box are
 *   then the same spelling, so a square box is not held.
 * - **A ground that a parent provides**: a bordered box inside a card that is meant to show the
 *   card's colour still needs its own `bg-default` here — which is the same colour, so it costs
 *   nothing.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../scripts/census-files.mjs';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The worker's local page: its session's, not this census's. */
const WORKER_PAGE = 'apps/web/src/worker/';

/** A form control or a button: its ground is the field's or the tone's, never the card's. */
const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button']);

interface Exception {
  readonly path: string;
  /** A fragment of the element's own tag text, which no other element in the file has. */
  readonly fragment: string;
  readonly why: string;
}

/** The genuine exceptions. Each must match exactly one element (both directions are asserted). */
export const CARD_GROUND_EXCEPTIONS: readonly Exception[] = [
  {
    path: 'apps/web/src/app/keyboard.tsx',
    fragment: 'font-mono',
    why: 'a key cap (`/`, `⌘K`) inside the search button: a glyph on the button, not a container',
  },
  {
    path: 'apps/web/src/features/agents.tsx',
    fragment: 'data-testid="fleet-canvas-frame"',
    why: 'the fleet map’s frame: the canvas paints its own ground, the page’s dotted night',
  },
  {
    path: 'apps/web/src/viz/flow/flow-view.tsx',
    fragment: 'data-testid="flow-canvas-frame"',
    why: 'the flow canvas’s frame: its dotted ground is the page colour (technical/09)',
  },
  {
    path: 'apps/web/src/viz/fleet/fleet-canvas.tsx',
    fragment: 'data-fleet-node="slot"',
    why: 'an empty slot on the fleet map, drawn hollow (dashed, no ground) on purpose',
  },
];

/** An intrinsic JSX element's opening. */
const ELEMENT_OPEN = /<([a-z][\w]*)(?=[\s/>])/g;

/** The text of the tag that opens at `start`, up to the `>` that closes it at brace depth 0. */
const tagText = (source: string, start: number): string => {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    } else if (char === '>' && depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
};

/**
 * Every `const NAME = <initialiser>` in `code`: the initialiser's text up to the `;` (or the line
 * end) at bracket depth 0, so a `cx(…)` call or a `{…}` table is taken whole.
 */
export const constInitialisers = (
  code: string,
): ReadonlyMap<string, { readonly text: string; readonly exported: boolean }> => {
  const found = new Map<string, { text: string; exported: boolean }>();
  for (const match of code.matchAll(
    /\b(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?!>)\s*/g,
  )) {
    const name = match[2] ?? '';
    const begin = (match.index ?? 0) + match[0].length;
    let depth = 0;
    let quote: string | null = null;
    let index = begin;
    for (; index < code.length; index += 1) {
      const char = code[index] ?? '';
      if (quote !== null) {
        if (char === '\\') {
          index += 1;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if ('([{'.includes(char)) {
        depth += 1;
      } else if (')]}'.includes(char)) {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      } else if (depth === 0 && (char === ';' || char === '\n')) {
        // A line that ends in an operator continues the expression.
        if (char === '\n' && /[=+,(?:|&]\s*$/.test(code.slice(begin, index))) {
          continue;
        }
        break;
      }
    }
    found.set(name, { text: code.slice(begin, index), exported: match[1] !== undefined });
  }
  return found;
};

/** The value text of every `className=` attribute in a tag: a string, or a `{…}` expression. */
export const classAttributes = (tag: string): string => {
  const values: string[] = [];
  for (const match of tag.matchAll(/\bclassName=/g)) {
    const begin = (match.index ?? 0) + match[0].length;
    const open = tag[begin];
    if (open === '"' || open === "'") {
      const end = tag.indexOf(open, begin + 1);
      values.push(tag.slice(begin, end === -1 ? tag.length : end + 1));
      continue;
    }
    if (open !== '{') {
      continue;
    }
    let depth = 0;
    let quote: string | null = null;
    let index = begin;
    for (; index < tag.length; index += 1) {
      const char = tag[index];
      if (quote !== null) {
        if (char === '\\') {
          index += 1;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    values.push(tag.slice(begin, index + 1));
  }
  return values.join(' ');
};

/** The contents of every string literal in `text`, joined. */
const literalText = (text: string): string =>
  [...text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((match) => match[2] ?? '').join(' ');

/** The identifiers of `text`'s expressions — never a word inside a string literal. */
const identifiersOf = (text: string): Set<string> =>
  new Set(
    text.replace(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g, ' ').match(/\b[A-Za-z_$][\w$]*\b/g) ?? [],
  );

const RADIUS = /^rounded(?:-[\w[\]./-]+)?$/;
const NOT_A_GROUND = /^bg-(?:canvas|inset|header|transparent)(?:\/\d+)?$/;

/** What a class list says about the element: a bordered, rounded box, and whether it has a ground. */
export const boxFacts = (
  classes: readonly string[],
): { readonly box: boolean; readonly pill: boolean; readonly grounded: boolean } => {
  const radii = classes.filter((name) => RADIUS.test(name));
  return {
    box: radii.length > 0 && classes.includes('border'),
    pill: radii.length > 0 && radii.every((name) => name === 'rounded-full'),
    grounded: classes.some((name) => name.startsWith('bg-') && !NOT_A_GROUND.test(name)),
  };
};

export interface GroundOffender {
  readonly line: number;
  readonly tag: string;
  /** The element's tag text, for matching an exception. */
  readonly text: string;
}

/** Every bordered, rounded intrinsic element in `source` with no card ground. */
export const groundlessBoxes = (
  source: string,
  shared: ReadonlyMap<string, string> = new Map(),
): GroundOffender[] => {
  const code = withoutComments(source);
  const local = constInitialisers(code);
  const offenders: GroundOffender[] = [];
  for (const match of code.matchAll(ELEMENT_OPEN)) {
    const tag = match[1] ?? '';
    if (CONTROL_TAGS.has(tag)) {
      continue;
    }
    const start = match.index ?? 0;
    const text = tagText(code, start);
    const classes = classAttributes(text);
    let gathered = classes;
    let frontier = classes;
    const seen = new Set<string>();
    for (let hop = 0; hop < 3 && frontier !== ''; hop += 1) {
      let next = '';
      for (const identifier of identifiersOf(frontier)) {
        if (seen.has(identifier) || (hop > 0 && !/^[A-Z][A-Z0-9_]*$/.test(identifier))) {
          continue;
        }
        seen.add(identifier);
        const value = local.get(identifier)?.text ?? shared.get(identifier);
        if (value !== undefined) {
          next += ` ${value}`;
        }
      }
      gathered += next;
      frontier = next;
    }
    const facts = boxFacts(literalText(gathered).split(/\s+/).filter(Boolean));
    if (facts.box && !facts.pill && !facts.grounded) {
      offenders.push({ line: code.slice(0, start).split('\n').length, tag, text });
    }
  }
  return offenders;
};

/**
 * `Blankslate`'s box as it stood when the owner reported the empty states (S-25.10's canary): the
 * census must refuse it, or a scanner that found nothing would read as a clean tree.
 */
const BLANKSLATE_BEFORE = `
export const Blankslate = (props: BlankslateProps): ReactElement => {
  const { title, hint, icon, secondary, size = 'compact', className, action } = props;
  return (
    <div
      data-blankslate={props.informational === true ? 'informational' : 'actionable'}
      className={cx(
        'flex flex-col items-center gap-2 rounded-md border border-line text-center',
        size === 'spacious' ? 'px-6 py-16' : 'px-6 py-8',
        className,
      )}
    >
      <h3 className="font-black">{title}</h3>
    </div>
  );
};`;

describe('the card-ground scanner', () => {
  it('refuses Blankslate as it was before S-25.10 (the canary)', () => {
    expect(groundlessBoxes(BLANKSLATE_BEFORE).map((found) => found.tag)).toEqual(['div']);
    // And passes it once it has the card ground.
    expect(
      groundlessBoxes(
        BLANKSLATE_BEFORE.replace('border border-line text-center', 'border bg-default'),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a class string', '<section className="rounded-md border border-line p-3" />'],
    ['the page colour as a ground', '<nav className="rounded-md border border-line bg-canvas" />'],
    [
      'the field ground on a box',
      '<div className="mt-2 rounded-md border border-line bg-inset" />',
    ],
    ['a hover state only', '<div className="rounded-lg border hover:bg-subtle" />'],
    [
      'a constant in the file',
      "const BOX = 'rounded-md border border-line p-4';\nconst F = () => <dl className={BOX} />;",
    ],
    [
      'a table looked up through a local',
      "const LOOK = { info: { box: 'border-link' } };\nconst F = ({ tone }) => { const look = LOOK[tone];\n return <div className={cx('rounded-md border', look.box)} />; };",
    ],
  ])('finds %s', (_name, source) => {
    expect(groundlessBoxes(source)).toHaveLength(1);
  });

  it('follows an identifier to a constant exported from another module', () => {
    const shared = new Map([['PANEL', "'rounded-md border border-line'"]]);
    expect(groundlessBoxes('<div className={PANEL} />', shared)).toHaveLength(1);
  });

  it.each([
    ['the card ground', '<div className="rounded-md border border-line bg-default p-4" />'],
    ['the box header ground', '<div className="rounded-md border bg-subtle" />'],
    ['a status tint', '<div className="rounded-md border border-danger/40 bg-danger-bg" />'],
    [
      'a ground chosen at run time from two',
      "<li className={cx('rounded-md border', on ? 'bg-subtle' : 'bg-default')} />",
    ],
    [
      'a table with grounds looked up through a local',
      "const LOOK = { info: { box: 'bg-subtle' } };\nconst F = ({ tone }) => { const look = LOOK[tone];\n return <div className={cx('rounded-md border', look.box)} />; };",
    ],
    ['a pill', '<span className="rounded-full border border-line px-2" />'],
    ['an input (a field keeps its own ground)', '<input className="rounded-md border bg-inset" />'],
    ['a button', '<button className="rounded-md border border-line px-3" />'],
    ['a divider (no radius)', '<div className="border-b border-line" />'],
    ['a radius with no border', '<div className="rounded-md px-2 hover:bg-subtle" />'],
    ['a component (its own elements are read where it renders them)', '<Card className="x" />'],
    ['a comment', '<div /* rounded-md border */ className="p-2" />'],
    ['a class word inside another attribute’s string', '<p title="rounded border" id={id} />'],
  ])('passes %s', (_name, source) => {
    expect(groundlessBoxes(source)).toEqual([]);
  });
});

describe('every bordered box in the application sits on the card ground (S-25.10)', () => {
  const files = censusFiles(REPO_ROOT, {
    pathspecs: ['apps/web/src'],
    include: (path) =>
      /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.startsWith(WORKER_PAGE),
  });
  const shared = new Map<string, string>();
  for (const file of files) {
    for (const [name, value] of constInitialisers(withoutComments(file.contents))) {
      if (value.exported) {
        shared.set(name, value.text);
      }
    }
  }
  const found = files.flatMap((file) =>
    groundlessBoxes(file.contents, shared).map((offender) => ({ path: file.path, ...offender })),
  );
  const excepted = (offender: { path: string; text: string }): Exception | undefined =>
    CARD_GROUND_EXCEPTIONS.find(
      (entry) => entry.path === offender.path && offender.text.includes(entry.fragment),
    );

  it('has the sources to scan, and they hold grounded boxes', () => {
    expect(files.length).toBeGreaterThan(80);
    // A scan that recognised no box at all would report a clean tree of nothing.
    const grounded = files.reduce((total, file) => {
      const code = withoutComments(file.contents);
      return (
        total +
        [...code.matchAll(ELEMENT_OPEN)].filter((match) => {
          const facts = boxFacts(
            literalText(classAttributes(tagText(code, match.index ?? 0)))
              .split(/\s+/)
              .filter(Boolean),
          );
          return facts.box && facts.grounded;
        }).length
      );
    }, 0);
    expect(grounded).toBeGreaterThan(20);
  });

  it('finds no box without a ground outside the stated exceptions', () => {
    expect(
      found
        .filter((offender) => excepted(offender) === undefined)
        .map((offender) => `${offender.path}:${offender.line}: <${offender.tag}>`),
    ).toEqual([]);
  });

  it('has no stale exception: each one matches exactly one element', () => {
    expect(
      CARD_GROUND_EXCEPTIONS.map((entry) => ({
        entry: `${entry.path} ${entry.fragment}`,
        matches: found.filter((offender) => excepted(offender) === entry).length,
      })),
    ).toEqual(
      CARD_GROUND_EXCEPTIONS.map((entry) => ({
        entry: `${entry.path} ${entry.fragment}`,
        matches: 1,
      })),
    );
  });
});
