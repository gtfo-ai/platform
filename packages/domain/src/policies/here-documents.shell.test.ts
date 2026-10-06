/**
 * WP-153 — the scanner's here-document reader against **the shells themselves**.
 *
 * This file starts real processes (`bash`, and `dash` where it is installed — the run image has
 * both, bash 5.2 and dash as `/bin/sh`), which the rest of the unit tier does not: a reader that
 * decides which lines of a command are data is a claim about what the shell runs, and the only
 * instrument that is not a second copy of that reader is the shell (standing rule 65). Each line
 * runs as `<shell> -c` with an empty standard input and a five-second bound, in a temporary
 * directory removed afterwards: a noise line such as `$a->b => 1;` that a shell runs as a command
 * redirects into the files `b` and `1`, and in the checkout those would be stray files.
 *
 * The property is the security half of ruling (b), over-approximated across the shells: **every
 * line any shell executes is a fragment the policy judges, or the line is uncertain.** A marker
 * `echo RAN_<n>` prints `RAN_<n>` only when it runs as a command (or when an unquoted body expands
 * a substitution, which is also a run); `cat` printing a body prints `echo RAN_<n>`. The pieces are
 * the shapes the reader has to refuse (a parameter expansion, an arithmetic shift, a comment, a
 * here-string, a quoted operator, a joined delimiter, a terminator with a space, a continued line,
 * a body a shell runs) mixed with the ones it has to accept, so a reader that skipped one line too
 * many hides a marker the shell printed.
 *
 * Heredocs inside `$(…)` are generated only for a bash of major version 4 or later: bash 3.2 (the
 * macOS `/bin/bash`) closes the substitution at a `)` inside the body, which bash 5.2 and dash do
 * not (measured, PROGRESS § WP-153). The run image's bash is 5.2, so a developer machine with 3.2
 * runs the rest and CI's bash runs all of it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import { commandUncertainty, splitCommandSegments } from './command-policy.js';

const SCRATCH = mkdtempSync(join(tmpdir(), 'wp153-shells-'));
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

const run = (shell: string, script: string): { readonly ok: boolean; readonly stdout: string } => {
  const result = spawnSync(shell, ['-c', script], {
    cwd: SCRATCH,
    input: '',
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
  });
  return { ok: result.error === undefined, stdout: result.stdout ?? '' };
};

/**
 * The shells present. **bash is required** (the first test fails without it); dash and a bash of
 * major version 4 or later are not, and each has a test of its own that is reported as *skipped*
 * when it is missing, so a shrunk oracle says what it did not compare (rule 21, review round 1).
 */
const SHELLS = ['bash', 'dash'].filter((shell) => run(shell, 'echo ok').stdout === 'ok\n');
const BASH_MAJOR = Number(run('bash', `echo "\${BASH_VERSINFO[0]}"`).stdout.trim());

/** A line of a generated command; a marker gets its number when the command is rendered. */
type Piece = { readonly text: string } | { readonly marker: (n: string) => string };

/**
 * A line that opens a here-document — or looks as though it does and must not be read as one — and
 * the word a terminator for it would carry (`decoy`: the word a sloppy reader would stop at).
 */
interface Opener {
  readonly text: string;
  readonly delimiter: string;
  readonly decoy?: string;
}

const OPENERS: readonly Opener[] = [
  { text: 'cat <<EOF', delimiter: 'EOF' },
  { text: "cat <<'EOF'", delimiter: 'EOF' },
  { text: 'cat <<"EOF"', delimiter: 'EOF' },
  { text: 'cat <<-EOF', delimiter: 'EOF' },
  { text: "cat <<-'EOF'", delimiter: 'EOF' },
  { text: "cat <<'A' <<'B'", delimiter: 'B', decoy: 'A' },
  { text: "echo hi; cat <<'EOF'", delimiter: 'EOF' },
  { text: "cat <<'EOF' > /dev/null", delimiter: 'EOF' },
  { text: "cat <<'EOF' | cat", delimiter: 'EOF' },
  // a body a shell runs
  { text: "bash <<'EOF'", delimiter: 'EOF' },
  { text: "cat <<'EOF' | sh", delimiter: 'EOF' },
  { text: "sh -s <<'EOF'", delimiter: 'EOF' },
  // what is not a here-document, whatever a sloppy reader makes of it
  { text: `x=1; echo \${x:-<<EOF }`, delimiter: 'EOF' },
  { text: '((x<<y)); echo', delimiter: 'y' },
  { text: 'echo $((1<<2))', delimiter: '2' },
  { text: 'echo hi # <<EOF', delimiter: 'EOF' },
  { text: 'echo "<<EOF"', delimiter: 'EOF' },
  { text: "echo '<<EOF'", delimiter: 'EOF' },
  { text: 'cat <<< EOF', delimiter: 'EOF' },
  { text: 'cat <<EOF"X"', delimiter: 'EOFX', decoy: 'EOF' },
  { text: `echo \${HOME}; cat <<EOF`, delimiter: 'EOF' },
  // A byte JavaScript's `\s` calls a space and bash keeps in the word: the delimiter is `EOF\r`
  // (`EOF\f`, …), so a sloppy reader that stops at `EOF` hides what bash runs after `EOF\r`.
  { text: "cat <<'EOF'\r", delimiter: 'EOF\r', decoy: 'EOF' },
  { text: 'cat <<EOF\r', delimiter: 'EOF\r', decoy: 'EOF' },
  { text: "cat <<'EOF'\f", delimiter: 'EOF\f', decoy: 'EOF' },
  { text: "cat <<'EOF'\v", delimiter: 'EOF\v', decoy: 'EOF' },
  { text: "cat <<'EOF'\u00a0", delimiter: 'EOF\u00a0', decoy: 'EOF' },
  // a shell named by a glob
  { text: "cat <<'EOF' | /bin/[s]h", delimiter: 'EOF' },
];

/** A here-document inside a substitution: bash 4+ and dash read the body as the shell does. */
const SUBSTITUTION_OPENERS: readonly Opener[] = [
  { text: "x=$(cat <<'EOF'", delimiter: 'EOF' },
  { text: 'x="$(cat <<EOF', delimiter: 'EOF' },
  { text: "sh -c \"$(cat <<'EOF'", delimiter: 'EOF' },
];

/** Lines inside a body or after it: markers that print `RAN_<n>` when they run, and noise. */
const LINES: readonly Piece[] = [
  { marker: (n) => `echo RAN_${n}` },
  { marker: (n) => `\techo RAN_${n}` },
  { marker: (n) => `$(echo RAN_${n})` },
  { marker: (n) => `\`echo RAN_${n}\`` },
  { marker: (n) => `echo RAN_${n}; echo done` },
  { text: "don't" },
  { text: '$a->b => 1;' },
  { text: 'E\\' },
  { text: 'OF' },
  // bash joins the two before comparing with the delimiter (`EOF`); dash does not (measured)
  { text: 'E\\\nOF' },
  { text: ')' },
];

/** The terminator for an opener: its word exactly, or a near miss the shell does not accept. */
const terminator = (opener: Opener): fc.Arbitrary<string> => {
  const word = opener.delimiter;
  const near = [
    `${word} `,
    ` ${word}`,
    `\t${word}`,
    `${word}X`,
    ...(opener.decoy ? [opener.decoy] : []),
  ];
  return fc.oneof(
    { weight: 3, arbitrary: fc.constant(word) },
    { weight: 2, arbitrary: fc.constantFrom(...near) },
  );
};

const lines = (max: number): fc.Arbitrary<readonly Piece[]> =>
  fc.array(fc.constantFrom(...LINES), { maxLength: max });

/** One opener, a body, its terminator (or a near miss), and the lines after it. */
const group = (openers: readonly Opener[]): fc.Arbitrary<readonly Piece[]> =>
  fc
    .constantFrom(...openers)
    .chain((opener) =>
      fc
        .tuple(lines(3), fc.array(terminator(opener), { minLength: 1, maxLength: 2 }), lines(2))
        .map(([body, ends, after]): readonly Piece[] => [
          { text: opener.text },
          ...body,
          { text: ends[0] as string },
          ...after,
          ...ends.slice(1).map((text) => ({ text })),
          ...(opener.text.includes('$(')
            ? [{ text: opener.text.includes('"$(') ? ')"' : ')' }]
            : []),
        ]),
    );

const render = (pieces: readonly Piece[]): string =>
  pieces
    .map((piece, index) => ('text' in piece ? piece.text : piece.marker(String(index))))
    .join('\n');

const commands = (openers: readonly Opener[]): fc.Arbitrary<string> =>
  fc
    .tuple(fc.array(group(openers), { minLength: 1, maxLength: 2 }), lines(2))
    .map(([groups, tail]) => render([...groups.flat(), ...tail]));

/** The marker numbers a shell printed as a line of their own: each one ran. */
const executed = (stdout: string): readonly string[] =>
  stdout
    .split('\n')
    .map((line) => /^RAN_(\d+)$/.exec(line)?.[1])
    .filter((n): n is string => n !== undefined);

const judged = (fragments: readonly string[], n: string): boolean =>
  fragments.some((fragment) => new RegExp(`(?:^|[\\s;])echo RAN_${n}(?:$|[\\s;])`).test(fragment));

/** The property, over the shells present: every marker a shell ran is judged, or the line is uncertain. */
const holds = (generated: fc.Arbitrary<string>, numRuns: number): void => {
  let ran = 0;
  let dataSkipped = 0;
  fc.assert(
    fc.property(generated, (line) => {
      const fragments = splitCommandSegments(line);
      const uncertain = commandUncertainty(line).length > 0;
      const markers = new Set(line.match(/RAN_\d+/g) ?? []);
      for (const shell of SHELLS) {
        const result = run(shell, line);
        expect(result.ok, `${shell} did not finish: ${JSON.stringify(line)}`).toBe(true);
        for (const n of executed(result.stdout)) {
          ran += 1;
          expect(
            uncertain || judged(fragments, n),
            `${shell} ran RAN_${n}, which the policy never judged: ${JSON.stringify(line)}`,
          ).toBe(true);
        }
      }
      if (!uncertain) {
        dataSkipped += [...markers].filter((m) => !judged(fragments, m.slice(4))).length;
      }
    }),
    { numRuns },
  );
  // Rule 10: both branches ran — shells executed markers, and the reader skipped some as data.
  expect(ran).toBeGreaterThan(0);
  expect(dataSkipped).toBeGreaterThan(0);
};

describe('WP-153 — every line a shell runs is judged, or the line is uncertain', () => {
  it('finds the shells it compares against', () => {
    expect(SHELLS).toContain('bash');
  });

  it(
    'holds over generated lines, for every shell present',
    () => {
      holds(commands(OPENERS), 400);
    },
    PROPERTY_TEST_TIMEOUT_MS * 2,
  );

  it.skipIf(!SHELLS.includes('dash'))(
    "compares dash, the run image's /bin/sh, too (skipped where dash is not installed)",
    () => {
      expect(SHELLS).toEqual(['bash', 'dash']);
    },
  );

  it.skipIf(!(BASH_MAJOR >= 4))(
    'holds over here-documents inside a substitution (skipped on a bash older than 4)',
    () => {
      holds(commands(SUBSTITUTION_OPENERS), 150);
    },
    PROPERTY_TEST_TIMEOUT_MS * 2,
  );

  it.each([
    [`x=1; echo \${x:-<<EOF }\necho RAN_1\nEOF`, 'a parameter expansion'],
    ['((x<<1)); echo\necho RAN_1\n1', 'an arithmetic shift'],
    ['echo hi # <<EOF\necho RAN_1\nEOF', 'a comment'],
    ['cat <<EOF"X"\nEOFX\necho RAN_1\nEOF', 'a joined delimiter'],
    ['cat <<EOF\nE\\\nOF\necho RAN_1\nEOF', 'a body line bash joins into the terminator'],
    ["cat <<'EOF'\nok\nEOF\necho RAN_1", 'the line after the terminator'],
    ["bash <<'EOF'\necho RAN_1\nEOF", 'a body bash runs'],
    ["cat <<'EOF' | sh\necho RAN_1\nEOF", 'a body sh runs'],
    ["cat <<'EOF' | /bin/[s]h\necho RAN_1\nEOF", 'a body a shell named by a glob runs'],
    ["cat <<'EOF'\r\nx\nEOF\r\necho RAN_1\nEOF\n", 'a CRLF opener: the delimiter is EOF\\r'],
    ['cat <<EOF\r\nx\nEOF\r\necho RAN_1\nEOF\n', 'a CRLF opener, unquoted'],
    ["cat <<'EOF'\f\nx\nEOF\f\necho RAN_1\nEOF\n", 'a form feed in the word'],
    ["cat <<'EOF'\v\nx\nEOF\v\necho RAN_1\nEOF\n", 'a vertical tab in the word'],
    ["cat <<'EOF'\u00a0\nx\nEOF\u00a0\necho RAN_1\nEOF\n", 'a no-break space in the word'],
  ])('bash runs the marker, and the policy judges it or is uncertain: %j (%s)', (line) => {
    // Rule 43: each payload is one a reader that skipped too much would let through.
    expect(executed(run('bash', line).stdout)).toEqual(['1']);
    expect(judged(splitCommandSegments(line), '1') || commandUncertainty(line).length > 0).toBe(
      true,
    );
  });

  it.each([
    ["cat <<'EOF'\necho RAN_1\nEOF", 'a quoted body'],
    ["cat <<-'EOF'\n\techo RAN_1\n\tEOF", 'a tab-stripped body'],
    ["cat <<'A' <<'B'\necho RAN_1\nA\necho RAN_2\nB", 'two bodies on one line'],
  ])('no shell runs the marker, and the policy reads it as data: %j (%s)', (line) => {
    for (const shell of SHELLS) {
      expect(executed(run(shell, line).stdout), shell).toEqual([]);
    }
    expect(commandUncertainty(line)).toEqual([]);
    expect(judged(splitCommandSegments(line), '1')).toBe(false);
  });
});
