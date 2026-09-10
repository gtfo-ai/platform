import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type CitationContinuation,
  citationSites,
  collectCitations,
  describeFailure,
  resolveCitations,
  type TestCitation,
  testNamesIn,
} from './citations.js';

/**
 * Every citation of a test, in every tracked source file, resolved against the file it names.
 *
 * Standing rule 11 with rule 30's correction applied: WP-14's divergence register justified its
 * kindest entry with a test that did not exist, and writing that down again would not have stopped
 * the next one. Three parts, and all three are needed:
 *
 *  - the **calibration** below, which drives the resolver with a synthetic repository and watches
 *    it fail (standing rule 21 — an uncalibrated instrument reads whatever you were hoping for);
 *  - the **sweep**, which asks git what is tracked (rule 7) and resolves every citation in it;
 *  - the **recall check**, which finds every place a citation *opens* with a second expression of
 *    that shape and requires the parser to have read one there. "Nothing was reported" is what a
 *    parser that matched nothing also says (rule 29), and round 2 shipped exactly that: a
 *    line-scoped parser under a docblock claiming enforcement.
 *
 * ## The wrapped shape is planted here, not merely described
 *
 * This repository wraps its prose at 100 columns, so a citation that runs past the margin is
 * written across two comment lines — which is how *both* citations in `workspace/provider.ts` came
 * to be invisible to round 2's parser while that file said they were resolved mechanically. A
 * syntactic guard sees one spelling of many, so plant the spelling the repository actually writes
 * (standing rule 48): `workspace/fake.test.ts` › "refuses a project variable that would redirect
 * the run, exactly as Docker does" is a citation this file makes, its name is cut in two by the
 * margin, and the test below reads this file's own source to assert both halves of the claim —
 * that no single line carries the whole name, and that the parser reads it anyway.
 */
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The lower bound on the number of places a citation opens.
 *
 * It exists so the recall check cannot pass by finding nothing (rule 29), not so that deleting a
 * citation fails the build — hence a number below the current count rather than equal to it. The
 * recall check itself is the assertion with teeth: it is per site, so halving what the parser reads
 * fails it whatever this number says.
 */
const MINIMUM_CITATION_SITES = 14;

/**
 * The citation marker, written as an escape so the synthetic fixtures are not claims.
 *
 * The sweep reads this file as text like any other, so a fixture written with the literal marker is
 * a citation of this suite. The two single-line fixtures below therefore *are* real citations of
 * real tests — round 2 left this file red for exactly that reason, and the author's own file is
 * where this guard has to work. The multi-line fixtures cannot be, because their value spans lines
 * that their source does not; they are assembled with the marker escaped, and the wrapped shape is
 * planted in the docblock above instead, where it is real and the sweep resolves it.
 */
const MARKER = '›';

/** How a fixture writes the opening of a citation. */
const cite = (file: string): string => `\`${file}\` ${MARKER}`;

const CITED_SOURCE = /\.(?:ts|tsx|mjs|md)$/;

/** Markdown wraps with no decoration; a docblock wraps with one. */
const continuationFor = (path: string): CitationContinuation =>
  path.endsWith('.md') ? 'prose' : 'comment';

const trackedFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path.length > 0);

describe('the citation parser', () => {
  it('reads a file citation and the names that follow it on the line', () => {
    const citations = collectCitations(
      ' * `workspace/fake.test.ts` › "attach returns a path that no server is listening on", "stops the container even when the run had already finished"\n',
    );
    expect(citations).toEqual([
      {
        file: 'workspace/fake.test.ts',
        name: 'attach returns a path that no server is listening on',
        line: 1,
      },
      {
        file: 'workspace/fake.test.ts',
        name: 'stops the container even when the run had already finished',
        line: 1,
      },
    ]);
  });

  it('does not let a later file name in the same sentence inherit the earlier names', () => {
    const citations = collectCitations(
      ' * `workspace/fake.test.ts` › "attach returns a path that no server is listening on", so WP-15 composes `runner/fake-spawn.ts` rather than "two".\n',
    );
    expect(citations).toEqual([
      {
        file: 'workspace/fake.test.ts',
        name: 'attach returns a path that no server is listening on',
        line: 1,
      },
    ]);
  });

  it('ignores quoted prose that no citation opened', () => {
    expect(collectCitations(' * The flags are "recorded", not enforced.\n')).toEqual([]);
  });

  it('follows a name the margin cut in two, as this file plants it', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const lines = source.split('\n');
    // Assembled from its halves, so this assertion is not satisfied by the line it is written on:
    // reflowing the plant onto one line would fix the instance and leave the hole.
    const cited = [
      'refuses a project variable that would redirect the run,',
      'exactly as Docker does',
    ].join(' ');
    expect(lines.filter((line) => line.includes(cited))).toEqual([]);
    const opensAt = lines.findIndex((line) => line.includes('refuses a project variable')) + 1;
    expect(collectCitations(source)).toContainEqual({
      file: 'workspace/fake.test.ts',
      name: cited,
      line: opensAt,
    });
  });

  it('continues over the wrap after the marker and after the comma of a list', () => {
    const source = [
      ` * ${cite('workspace/fake.test.ts')}`,
      ' * "attach returns a path that no server is listening on",',
      ' * "records a stop before the removal on every path that ends a run"',
    ].join('\n');
    expect(collectCitations(source)).toEqual([
      {
        file: 'workspace/fake.test.ts',
        name: 'attach returns a path that no server is listening on',
        line: 1,
      },
      {
        file: 'workspace/fake.test.ts',
        name: 'records a stop before the removal on every path that ends a run',
        line: 1,
      },
    ]);
  });

  it('does not carry a completed citation onto the next line', () => {
    const source = [
      ` * ${cite('workspace/fake.test.ts')} "attach returns a path that no server is listening on"`,
      ' * The flags are "recorded", not enforced.',
    ].join('\n');
    expect(collectCitations(source).map((citation) => citation.name)).toEqual([
      'attach returns a path that no server is listening on',
    ]);
  });

  it('continues over an undecorated wrap in prose and not in a comment', () => {
    const source = [
      `${cite('workspace/fake.test.ts')} "attach returns a path that no`,
      'server is listening on"',
    ].join('\n');
    expect(collectCitations(source, 'prose')).toEqual([
      {
        file: 'workspace/fake.test.ts',
        name: 'attach returns a path that no server is listening on',
        line: 1,
      },
    ]);
    expect(collectCitations(source, 'comment')).toEqual([]);
  });

  it('counts a site where a citation opens, and not a marker used as a separator', () => {
    const source = [
      ` * ${cite('workspace/fake.test.ts')} "attach returns a path that no server is listening on"`,
      `note(\`── verify ${MARKER} lint ──\`);`,
    ].join('\n');
    expect(citationSites(source)).toEqual([{ file: 'workspace/fake.test.ts', line: 1 }]);
  });

  it('collects the names a file declares, including a table-driven one', () => {
    const names = testNamesIn(
      [
        "describe('a group', () => {",
        "  it('does the thing', () => {});",
        '  it.each([["/"], ["/proc"]])("refuses %s as a bind source", () => {});',
        '  it(`a template literal name`, () => {});',
        '});',
      ].join('\n'),
    );
    expect(names).toEqual(new Set(['a group', 'does the thing', 'refuses %s as a bind source']));
  });

  /**
   * The calibration. Each of the three failure reasons is produced deliberately, so a resolver
   * that returned `[]` for everything — the shape this whole check exists to prevent — cannot pass.
   */
  it('reports a citation of a missing file, an ambiguous name and a missing test', () => {
    const citations: (TestCitation & { source: string })[] = [
      { file: 'nowhere.test.ts', name: 'x', line: 1, source: 'a.ts' },
      { file: 'twice.test.ts', name: 'x', line: 2, source: 'a.ts' },
      { file: 'real.test.ts', name: 'not written yet', line: 3, source: 'a.ts' },
      { file: 'real.test.ts', name: 'written', line: 4, source: 'a.ts' },
    ];
    const failures = resolveCitations({
      citations,
      trackedFiles: ['one/real.test.ts', 'one/twice.test.ts', 'two/twice.test.ts'],
      read: () => "it('written', () => {});",
    });
    expect(failures.map((failure) => failure.reason)).toEqual([
      'no such file',
      'ambiguous file name',
      'no such test',
    ]);
    expect(describeFailure(failures[2] as (typeof failures)[number])).toBe(
      'a.ts:3 cites real.test.ts › "not written yet" — no such test',
    );
  });
});

describe('every citation in this checkout', () => {
  const sources = trackedFiles().filter((path) => CITED_SOURCE.test(path));
  const read = (path: string): string => readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
  const citations = sources.flatMap((path) =>
    collectCitations(read(path), continuationFor(path)).map((citation) => ({
      ...citation,
      source: path,
    })),
  );
  const sites = sources.flatMap((path) =>
    citationSites(read(path)).map((site) => ({ ...site, source: path })),
  );

  it('names a test that exists', () => {
    const failures = resolveCitations({
      citations,
      trackedFiles: sources,
      read,
    });
    expect(failures.map(describeFailure)).toEqual([]);
  });

  it('was read at every site where one opens, so a parser with a blind spot cannot pass', () => {
    const unread = sites.filter(
      (site) =>
        !citations.some(
          (citation) =>
            citation.source === site.source &&
            citation.line === site.line &&
            citation.file === site.file,
        ),
    );
    expect(
      unread.map((site) => `${site.source}:${site.line} opens a citation of ${site.file}`),
    ).toEqual([]);
    expect(sites.length).toBeGreaterThanOrEqual(MINIMUM_CITATION_SITES);
  });
});
