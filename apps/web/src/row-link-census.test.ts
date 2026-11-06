/**
 * **A list row with somewhere to go is clicked anywhere** — the census S-23.26 adds beside the
 * primitive (`ui/row-link.ts`).
 *
 * The owner's report was that a row had to be hit on its title: Home's *Needs you*, *Running now*
 * and *Projects* rows, and every list built the same way. The fix is one primitive — the row's
 * primary control spreads `rowLink()`, and `ListRow` is the host — so the defect comes back the
 * moment a new `ListRow` puts a `<Link>` in its title and forgets the spread. Nothing else would
 * notice: the link still works, every test that clicks the title still passes, and only a person
 * aiming at the meta line finds out.
 *
 * ## What it reads, and what it cannot see
 *
 * Every `.ts`/`.tsx` file under `apps/web/src` that is not a test, read off disk (so a file not yet
 * committed is read too), comments stripped by the repository's one scanner
 * (`scripts/source-scanner.mjs`). For each `<ListRow` it takes the element's text **up to the first
 * later line at the same indentation that closes it** (`/>` or `</ListRow>`) — which leans on the
 * formatter: Biome is enforced by `verify:static`, and it puts an element's close at its opener's
 * indentation. In that text, a `<Link` anywhere (title or action) or a title that opens with a
 * `<button` is a row with a destination, and it must spread `rowLink(`.
 *
 * It is syntactic, and says so (standing rule 48). It **cannot see**: a title or action passed by
 * name (`title={<TitleLink …/>}`, `title={heading}`) — the board's `TaskRow`/`TaskCard` are
 * hand-written rows and their `TitleLink` is checked by `board-card.test.tsx`, not here; a row that
 * is not a `ListRow` (a hand-written `<li>` with a link in it: the shadow report's ticket rows are
 * such, and use `ROW_LINK_HOST` themselves); `createElement(ListRow, …)`; a `ListRow` under an alias;
 * and whether the spread sits on the *right* control — only that one is there. Nor can it tell a
 * row that should have no destination from one that forgot it: a row with neither a link nor a title
 * button (the workers, audit, knowledge-proposal and statistics rows) passes, by design.
 *
 * The second census holds the other half of the pair: a file that spreads `rowLink(` outside a
 * `ListRow` must name `ROW_LINK_HOST`, or its stretched control has no row to cover (the
 * stylesheet's selectors are scoped to the host, so it would stretch over nothing — harmless, and
 * silently not the feature). It cannot see that the host is on the right element.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The text of every `<ListRow …/>` element in `source`, comments removed. */
export const listRowElements = (source: string): string[] => {
  const lines = withoutComments(source).split('\n');
  const elements: string[] = [];
  lines.forEach((line, start) => {
    const at = line.indexOf('<ListRow');
    if (at === -1 || /^<ListRow\w/.test(line.slice(at))) {
      return;
    }
    // Biome writes a row on one line when it fits, and otherwise opens it alone on its line.
    if (line.slice(at).trim() !== '<ListRow') {
      elements.push(line.slice(at));
      return;
    }
    const indent = indentOf(line);
    for (let end = start + 1; end < lines.length; end += 1) {
      const candidate = lines[end] ?? '';
      if (indentOf(candidate) === indent && /^(\/>|<\/ListRow>)/.test(candidate.trimStart())) {
        elements.push(lines.slice(start, end + 1).join('\n'));
        return;
      }
    }
    // No close found: report the rest, so a misread is a failure rather than a skip.
    elements.push(lines.slice(start).join('\n'));
  });
  return elements;
};

/** Whether a `ListRow`'s text gives it a destination: a router link, or a title that is a button. */
const hasDestination = (element: string): boolean =>
  /<Link\b/.test(element) || /\btitle=\{\s*<button\b/.test(element);

/** The `ListRow`s in `source` that have a destination and no `rowLink(` spread. */
export const unstretchedRows = (source: string): string[] =>
  listRowElements(source).filter(
    (element) => hasDestination(element) && !element.includes('rowLink('),
  );

const walk = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const sourceFiles = (): string[] =>
  walk(SOURCE_ROOT).filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path));

describe('a ListRow with a destination is a whole-row target (S-23.26)', () => {
  it('reads the rows, and the ones with a destination', () => {
    const rows = sourceFiles().flatMap((path) => listRowElements(readFileSync(path, 'utf8')));
    // A walk that read no rows would also report no offender: 18 ListRows at S-23.26.
    expect(rows.length).toBeGreaterThanOrEqual(15);
    // 11 with a destination at S-23.26 (Home 3, Projects, Inbox 2, Integrations, a task's runs,
    // the shadow batches, the Agents list 2).
    expect(rows.filter(hasDestination).length).toBeGreaterThanOrEqual(10);
  });

  it('finds no ListRow with a link or a title button that does not spread rowLink()', () => {
    const found = sourceFiles().flatMap((path) =>
      unstretchedRows(readFileSync(path, 'utf8')).map(
        (element) => `${relative(SOURCE_ROOT, path)}: ${element.split('\n').slice(0, 6).join(' ')}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('finds the host beside every rowLink() spread outside a ListRow', () => {
    const found = sourceFiles().filter((path) => {
      const code = withoutComments(readFileSync(path, 'utf8'));
      const spreads = code.split('rowLink(').length - 1;
      const inRows = listRowElements(code).reduce(
        (count, element) => count + element.split('rowLink(').length - 1,
        0,
      );
      return (
        !path.endsWith(join('ui', 'row-link.ts')) &&
        spreads > inRows &&
        !code.includes('ROW_LINK_HOST')
      );
    });
    expect(found.map((path) => relative(SOURCE_ROOT, path))).toEqual([]);
  });

  /** Calibration (standing rule 3): the instrument sees what it forbids, and only that. */
  it.each([
    [
      'a title link',
      [
        '    <ListRow',
        '      title={',
        '        <Link to="/projects/$key" params={{ key }}>',
        '          name',
        '        </Link>',
        '      }',
        '    />',
      ].join('\n'),
    ],
    [
      'an action link under a text title',
      [
        '  <ListRow',
        '    title="Plan approval is waiting for you"',
        '    actions={<Link to="/tasks/$taskId" params={{ taskId }}>Open</Link>}',
        '  />',
      ].join('\n'),
    ],
    [
      'a title button',
      [
        '      <ListRow',
        '        title={',
        '          <button type="button" onClick={open}>x</button>',
        '        }',
        '      />',
      ].join('\n'),
    ],
    ['a one-line row', '  <ListRow title={<Link to="/">x</Link>} />'],
  ])('flags %s', (_name, source) => {
    expect(unstretchedRows(source)).toHaveLength(1);
  });

  it.each([
    [
      'a spread title link',
      [
        '    <ListRow',
        '      title={',
        '        <Link to="/projects/$key" params={{ key }} {...rowLink(\'hover:underline\')}>',
        '          name',
        '        </Link>',
        '      }',
        '    />',
      ].join('\n'),
    ],
    ['a row with nowhere to go', '  <ListRow title="Platform server" meta="runs agents" />'],
    [
      'a link after the row closed',
      ['  <ListRow', '    title="x"', '  />', '  <Link to="/inbox">Inbox</Link>'].join('\n'),
    ],
    [
      'a commented-out link',
      ['  <ListRow', '    // <Link to="/">x</Link>', '    title="x"', '  />'].join('\n'),
    ],
  ])('does not flag %s', (_name, source) => {
    expect(unstretchedRows(source)).toEqual([]);
  });

  it('reads a nested element’s close at a deeper indent as part of the row', () => {
    const source = [
      '  <ListRow',
      '    title={',
      '      <Tooltip',
      '        label="x"',
      '      />',
      '    }',
      '    actions={<Link to="/">x</Link>}',
      '  />',
    ].join('\n');
    expect(listRowElements(source)).toHaveLength(1);
    expect(unstretchedRows(source)).toHaveLength(1);
  });
});
