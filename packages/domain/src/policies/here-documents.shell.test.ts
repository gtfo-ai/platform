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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  commandUncertainty,
  commandWords,
  splitCommandSegments,
  UNCERTAINTY,
} from './command-policy.js';

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
/** `major * 100 + minor`: 502 for bash 5.2, 302 for the macOS bash 3.2 (WP-158's gates). */
const BASH_VERSION = Number(
  run('bash', `echo "$(( \${BASH_VERSINFO[0]} * 100 + \${BASH_VERSINFO[1]} ))"`).stdout.trim(),
);
/** WP-160: util-linux `script` (the run image's; the BSD one has no `-c`) and `rbash`, if present. */
const SCRIPT_C = run('bash', "script -qc 'echo ok' /dev/null").stdout.includes('ok');
const RBASH = run('bash', "rbash -c 'echo ok'").stdout === 'ok\n';

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
  // WP-158: a value the policy reads as single-quoted data, which bash evaluates as code where an
  // expansion or a command reads it as arithmetic — as a command line, or in an unquoted body.
  // `>&3` reaches the shell's own standard output from inside the subscript.
  // `export`: a bare assignment carrying a `[` would make the level's bodies scripts to the scanner.
  { marker: (n) => `exec 3>&1; export x='b[$(echo RAN_${n} >&3)]'` },
  { text: `\${y[x]}` },
  { text: 'let x' },
  // WP-160: a trap's action runs when the shell exits, and a script piped into a shell runs.
  { marker: (n) => `trap 'echo RAN_${n}' EXIT` },
  { marker: (n) => `echo 'echo RAN_${n}' | sh` },
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
    // WP-158: an operator the reader does not recognise still opens an unquoted body in bash, which
    // expands the `$(…)` the old reading takes for single-quoted text.
    [
      `exec 3>&1; echo \${HOME}; cat <<EOF\nx='$(echo RAN_1 >&3)'\nEOF`,
      `a body after a closed \`\${…}\``,
    ],
    ["exec 3>&1 # c\ncat <<EOF\nx='$(echo RAN_1 >&3)'\nEOF", 'a body after a comment line'],
    ["exec 3>&1\ncat <<EOF\r\nx='$(echo RAN_1 >&3)'\nEOF\r\n", 'a CRLF body, unrecognised'],
  ])('bash runs the marker, and the policy judges it or is uncertain: %j (%s)', (line) => {
    // Rule 43: each payload is one a reader that skipped too much would let through.
    expect(executed(run('bash', line).stdout)).toEqual(['1']);
    expect(judged(splitCommandSegments(line), '1') || commandUncertainty(line).length > 0).toBe(
      true,
    );
  });

  /**
   * WP-158 (backlog 509): the measured payloads, each run by bash, outside a body and inside an
   * unquoted one. A form newer than the bash present is skipped by its gate (`major * 100 +
   * minor`): `@P` needs bash 4.4, and the nameref, `printf -v` and `-v` forms ran on bash 5.2 and
   * not on 3.2 (PROGRESS § WP-158). CI's bash runs all of them.
   */
  const SET = "exec 3>&1; x='b[$(echo RAN_1 >&3)]'";
  const PROMPT = "exec 3>&1; z='$(echo RAN_1 >&3)'";
  // A body row sets the value with `export`: a bare assignment carrying a `[` makes the scanner read
  // the level's bodies as scripts (WP-153's glob-named reader), which would hide the body detector.
  const EXPORTED = `exec 3>&1; export x='b[$(echo RAN_1 >&3)]'`;
  describe.each([
    [`${SET}; echo \${y[x]}`, 0, 'an array subscript'],
    [`${SET}; y=(a); echo \${#y[x]}`, 0, 'a length with a subscript'],
    [`${PROMPT}; echo \${z@P}`, 404, 'a prompt-string transformation'],
    [`${SET}; echo \${!x}`, 0, 'an indirection'],
    [`${SET}; z=abc; echo \${z:x}`, 0, 'an offset'],
    [`${SET}; z=abc; echo \${z:0:x}`, 0, 'a length'],
    [`${SET}; echo $[x]`, 0, '`$[…]`'],
    [`${SET}; ((x))`, 0, 'an arithmetic command'],
    [`${SET}; let x`, 0, '`let`'],
    [`${SET}; declare -i y=x`, 0, '`declare -i`'],
    [`${SET}; [[ x -eq 1 ]]`, 0, '`[[ … -eq … ]]`'],
    [`${SET}; y[x]=1`, 0, 'an element assignment'],
    [`${SET}; y=([x]=1)`, 0, 'a compound element assignment'],
    [`${SET}; declare "$x"=1`, 0, 'a declared name built from an expansion'],
    [`${SET}; read "$x" <<< 1`, 0, '`read`'],
    [`${SET}; b=(1 2); unset "$x"`, 0, '`unset`'],
    [`${SET}; declare -n r=$x; echo $r`, 500, 'a nameref'],
    [`${SET}; printf -v "$x" %s 1`, 500, '`printf -v`'],
    [`${SET}; [[ -v $x ]]`, 500, 'a `-v` test'],
    [`${EXPORTED}; cat <<EOF\n\${y[x]}\nEOF`, 0, 'a subscript in an unquoted body'],
    [`${EXPORTED}; z=abc; cat <<EOF\n\${z:x}\nEOF`, 0, 'an offset in an unquoted body'],
    [`${EXPORTED}; cat <<EOF\n$[x]\nEOF`, 0, '`$[…]` in an unquoted body'],
    [`${PROMPT}; cat <<EOF\n\${z@P}\nEOF`, 404, 'a transformation in an unquoted body'],
    // Review round 1: a redirection target, a line continuation, a wrapper's options.
    [`${SET}; cat > \${y[x]}`, 0, 'a redirection target'],
    [`${SET}; ls 2>\${y[x]}`, 0, 'a descriptor redirection target'],
    [`${PROMPT}; echo hi > \${z@P}`, 404, 'a transformation as a target'],
    [`${SET}; echo $\\\n{y[x]}`, 0, 'a continuation after `$`'],
    [`${SET}; echo \${y\\\n[x]}`, 0, 'a continuation before the subscript'],
    [`${SET}; command -p let x`, 0, '`command -p`'],
    [`${SET}; time -p let x`, 0, '`time -p`'],
    [`${SET}; coproc let x; wait`, 400, '`coproc`'],
  ] as const)('WP-158: %j (%s)', (line, needs, what) => {
    it.skipIf(!(BASH_VERSION >= needs))(
      `bash runs the marker through ${what}, and the policy is uncertain (criterion 4)`,
      () => {
        // bash 3.2 expanded a redirection target twice here (measured), so the marker may print twice.
        expect([...new Set(executed(run('bash', line).stdout))]).toEqual(['1']);
        expect(commandUncertainty(line)).toContain(UNCERTAINTY.evaluatedText);
      },
    );
  });

  // The planted value is a variable each literal form would evaluate if it read one. The quoted
  // body's has no `[`: a `[` in an assignment makes the scanner read that level's bodies as scripts
  // (WP-153's glob-named reader, an over-read), which is not what this row is about.
  it.each([
    [SET, `z=abcdefghij; echo \${z:0:7} \${z:1}`, 'an offset and a length that are plain numbers'],
    [SET, `arr=(a b); echo \${arr[0]} \${#arr[@]} \${arr[*]} \${arr[@]:1:1}`, 'literal subscripts'],
    [SET, '[[ 3 -eq 3 ]]', 'a comparison of two plain numbers'],
    [SET, `echo \${!} \${!x*} \${!x@}`, 'what `${!` reads that is not an indirection'],
    [SET, `arr=(a b); echo \${!arr[@]}`, 'an array’s keys'],
    [PROMPT, `cat <<'EOF'\n\${z@P}\n\${y[z]}\n$[z]\nEOF`, 'a quoted-delimiter body'],
    [SET, `echo hi > '\${y[x]}'`, 'a single-quoted redirection target (review round 1)'],
  ])(
    'WP-158: bash runs no marker beside a planted value (%j), and the policy reads %j (%s, criterion 3)',
    (planted, literal) => {
      const line = `${planted}; ${literal}`;
      expect(executed(run('bash', line).stdout)).toEqual([]);
      expect(commandUncertainty(line)).toEqual([]);
    },
  );

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

/**
 * WP-160 (backlog 511, 513): every form of a command handed over as a string that a shell was
 * measured to run, run here — the marker prints only when it runs — and the policy judges the
 * marker or is uncertain (criterion 5). A gate skips a form the shell present cannot run:
 * `mapfile -C`, `source <(…)` and `. <(…)` need bash 4 (3.2 ran none of them here; it ran
 * `source <(…)` once in the scratchpad table, so it is a race there), `script -c` util-linux and
 * `rbash` its binary — the run image has all of them, and CI's bash runs every row.
 */
describe('WP-160 — a string a shell runs is judged, or the line is uncertain', () => {
  const OUT = 'exec 3>&1; ';
  describe.each([
    ["trap 'echo RAN_1' EXIT", 0, '`trap … EXIT`'],
    ["trap 'echo RAN_1' ERR; false", 0, '`trap … ERR`'],
    ["trap 'echo RAN_1' DEBUG; :", 0, '`trap … DEBUG`'],
    ['x=\'echo RAN_1\'; trap "$x" EXIT', 0, 'a trap action from a variable'],
    [`${OUT}PS4='$(echo RAN_1 >&3)' bash -xc :`, 0, '`PS4` before `bash -x`'],
    [`${OUT}PS4='$(echo RAN_1 >&3)'; set -x; :`, 0, '`PS4` under `set -x`'],
    [`${OUT}export PS4='$(echo RAN_1 >&3)'; set -x; :`, 0, 'an exported `PS4`'],
    [`${OUT}env PS4='$(echo RAN_1 >&3)' bash -xc :`, 0, '`PS4` as an `env` argument'],
    [`${OUT}IFS= read -r PS4 < <(echo '$(echo RAN_1 >&3)'); set -x; :`, 0, '`read` into `PS4`'],
    ["mapfile -C 'echo RAN_1;:' -c 1 a <<< x", 400, '`mapfile -C`'],
    ["readarray -C 'echo RAN_1;:' -c 1 a <<< x", 400, '`readarray -C`'],
    ["shopt -s expand_aliases; alias ll='echo RAN_1'\nll", 0, 'an alias'],
    // `compgen` appends its arguments to the command: `;:` takes them.
    [`${OUT}compgen -C 'echo RAN_1 >&3;:' foo`, 0, '`compgen -C`'],
    ["bash -lc 'echo RAN_1'", 0, '`bash -lc`'],
    ["bash -c -- 'echo RAN_1'", 0, '`bash -c --`'],
    ["bash <<<'echo RAN_1'", 0, '`bash <<<`'],
    ['x=\'echo RAN_1\'; bash <<<"$x"', 0, 'a here-string that is not literal'],
    ["echo 'echo RAN_1' | bash", 0, 'a pipe into `bash`'],
    ["echo 'echo RAN_1' | (bash)", 0, 'a pipe into a subshell'],
    ["echo 'echo RAN_1' | { bash; }", 0, 'a pipe into a group'],
    ["echo 'echo RAN_1' | tee >(bash) >/dev/null; wait", 0, 'a `>(…)` body'],
    ["source /dev/stdin <<<'echo RAN_1'", 0, '`source /dev/stdin <<<`'],
    ["source <(echo 'echo RAN_1')", 400, '`source <(…)`'],
    [". <(echo 'echo RAN_1')", 400, '`. <(…)`'],
    ["bash < <(echo 'echo RAN_1')", 0, '`bash < <(…)`'],
    ["exec 4<<<'echo RAN_1'; bash <&4", 0, 'a shell reading a descriptor'],
    ['find . -maxdepth 0 -exec echo RAN_1 \\;', 0, '`find -exec`'],
    ['find . -maxdepth 0 -execdir echo RAN_1 \\;', 0, '`find -execdir`'],
    ["find . -maxdepth 0 -exec sh -c 'echo RAN_1' \\;", 0, 'a shell under `find -exec`'],
    ["echo x | xargs -I{} sh -c 'echo RAN_1'", 0, '`xargs -I{}` into a shell'],
    // Backlog 513: bash ends the body at its terminator and runs the next line, then fails on `'`.
    ["# note\ncat <<'EOF'\na'\nEOF\necho RAN_1\n'", 0, 'the hypothesis line, whole'],
    ["cat <<\\EOF\na'\nEOF\necho RAN_1\n'", 0, 'a backslash-quoted delimiter, paired'],
    ["cat <<E'OF'\na'\nEOF\necho RAN_1\n'", 0, 'a partly quoted delimiter, paired'],
    ["cat <<\\EOF\ncat <<'X'\nEOF\necho RAN_1\nX", 0, 'an operator in the body'],
    // Review round 1: a script `xargs` supplies, `-W`, and line continuations between words.
    [`echo "'echo RAN_1'" | xargs bash -c`, 0, '`xargs bash -c`'],
    [`echo "'echo RAN_1'" | xargs -L1 bash -c`, 0, '`xargs -L1 bash -c`'],
    [`${OUT}compgen -W '$(echo RAN_1 >&3)' x`, 0, '`compgen -W`'],
    ['find . -maxdepth 0 \\\n-exec echo RAN_1 \\;', 0, 'a continuation before `-exec`'],
    ['find . -maxdepth 0 -exec \\\necho RAN_1 \\;', 0, 'a continuation after `-exec`'],
    ["echo 'echo RAN_1' | \\\nbash", 0, 'a continuation after the pipe'],
    [`${OUT}export \\\nPS4='$(echo RAN_1 >&3)'; set -x; :`, 0, 'a continuation after `export`'],
    ["cat <<\\\nEOF\na'\nEOF\necho RAN_1\n'", 0, 'a continuation before the delimiter'],
  ] as const)('WP-160: %j (%s)', (line, needs, what) => {
    it.skipIf(!(BASH_VERSION >= needs))(
      `bash runs the marker through ${what}, and the policy judges it or is uncertain`,
      () => {
        expect([...new Set(executed(run('bash', line).stdout))]).toEqual(['1']);
        expect(judged(splitCommandSegments(line), '1') || commandUncertainty(line).length > 0).toBe(
          true,
        );
      },
    );
  });

  it.skipIf(!SCRIPT_C)('bash runs the marker through `script -qc` (util-linux’s script)', () => {
    const line = "script -qc 'echo RAN_1' /dev/null";
    expect(executed(run('bash', line).stdout.replaceAll('\r', ''))).toEqual(['1']);
    expect(judged(splitCommandSegments(line), '1')).toBe(true);
  });

  it.skipIf(!RBASH)('bash runs the marker through `rbash -c`', () => {
    const line = "rbash -c 'echo RAN_1'";
    expect(executed(run('bash', line).stdout)).toEqual(['1']);
    expect(judged(splitCommandSegments(line), '1')).toBe(true);
  });

  it('runs nothing for a trap that is reset, and the policy reads it (criterion 4)', () => {
    for (const line of ['trap - EXIT', "trap '' INT", "trap 'echo RAN_1' EXIT; trap - EXIT"]) {
      expect(executed(run('bash', line).stdout), line).toEqual([]);
      expect(commandUncertainty(line), line).toEqual([]);
    }
  });
});

/**
 * WP-161 criteria (7), (10), (12) and (13): the shapes the row closes, run by bash — **marker only**.
 * Each payload is `echo RAN_1` or `./mark`, a script planted in this file's temporary directory that
 * prints `RAN_1` and does nothing else; nothing here runs outside that directory. bash runs the
 * marker through each shape (so the shape is a reach), and the policy reads the line as uncertain
 * with the row's new entry — or, for a continuation, reads the joined name.
 */
describe('WP-161 — what bash runs past the bound, through an expanded or rebound name, and from xargs', () => {
  const MARK = join(SCRATCH, 'mark');
  writeFileSync(MARK, '#!/bin/sh\necho RAN_1\n');
  chmodSync(MARK, 0o755);
  const has = (program: string): boolean => run('bash', `command -v ${program}`).stdout !== '';
  const nested = (levels: number, inner: string) =>
    `${'echo $('.repeat(levels)}${inner}${')'.repeat(levels)}`;

  it.each<readonly [string, string, string]>([
    [`${'nice '.repeat(9)}./mark`, UNCERTAINTY.tooDeep, 'nine wrappers'],
    [
      `${Array.from({ length: 9 }, (_, i) => `V${i}=${i}`).join(' ')} ./mark`,
      UNCERTAINTY.tooDeep,
      'nine assignments',
    ],
    [nested(10, './mark'), UNCERTAINTY.tooDeep, 'ten nested substitutions'],
    ['./m[a]rk', UNCERTAINTY.expandedName, 'a bracket glob in the name'],
    ['./ma?k', UNCERTAINTY.expandedName, 'a `?` glob in the name'],
    ['./{mark,x}', UNCERTAINTY.expandedName, 'a brace with a comma'],
    ['./m{a..a}rk', UNCERTAINTY.expandedName, 'a brace sequence'],
    ['nice ./m[a]rk', UNCERTAINTY.expandedName, 'a glob behind a wrapper'],
    ['hash -p ./mark ls; ls', UNCERTAINTY.reboundName, '`hash -p`'],
    ['echo ./mark | xargs env', UNCERTAINTY.xargsArguments, '`xargs env`'],
    ['echo ./mark | xargs nohup', UNCERTAINTY.xargsArguments, '`xargs nohup`'],
    ['echo ./mark | xargs nice', UNCERTAINTY.xargsArguments, '`xargs nice`'],
    [
      "echo './mark ;' | xargs find . -maxdepth 0 -exec",
      UNCERTAINTY.xargsArguments,
      '`xargs find -exec`',
    ],
  ])('bash runs the marker through %j, and the policy is uncertain (%s, %s)', (line, reason) => {
    expect(executed(run('bash', line).stdout)).toEqual(['1']);
    expect(commandUncertainty(line)).toContain(reason);
  });

  it.skipIf(!has('timeout'))('bash runs the marker through `xargs timeout 5` (coreutils)', () => {
    const line = 'echo ./mark | xargs timeout 5';
    expect(executed(run('bash', line).stdout)).toEqual(['1']);
    expect(commandUncertainty(line)).toContain(UNCERTAINTY.xargsArguments);
  });

  it.skipIf(!has('/usr/bin/nice'))(
    'bash expands a wrapper’s own globbed name (`/usr/bin/ni?e`)',
    () => {
      const line = '/usr/bin/ni?e ./mark';
      expect(executed(run('bash', line).stdout)).toEqual(['1']);
      expect(commandUncertainty(line)).toContain(UNCERTAINTY.expandedName);
    },
  );

  it.each([
    ['./ma\\\nrk', './mark', 'a continuation inside the name'],
    ['ec\\\nho RAN_1', 'echo', 'a continuation inside a builtin’s name'],
    ['nice ./m\\\nark', 'nice', 'a continuation behind a wrapper'],
  ])('bash joins %j, and the policy reads the joined word (%s, criterion (10))', (line, first) => {
    expect(executed(run('bash', line).stdout)).toEqual(['1']);
    expect(commandUncertainty(line)).toEqual([]);
    const words = splitCommandSegments(line).map(commandWords);
    expect(words.some((argv) => argv[0] === first)).toBe(true);
    expect(words.flat()).toContain(first === 'echo' ? 'echo' : './mark');
  });

  it('bash runs the line after a comment ending in a backslash, and the policy judges it (criterion (14))', () => {
    const line = 'ls >/dev/null # x \\\necho RAN_1';
    for (const shell of SHELLS) {
      expect(executed(run(shell, line).stdout), shell).toEqual(['1']);
    }
    expect(judged(splitCommandSegments(line), '1')).toBe(true);
  });

  /** Backlog 531, folded: an option's value of any shape before a globbed name (marker only). */
  const present = (needs: string): boolean =>
    needs === 'bash' ||
    (needs === 'env -C' ? run('bash', 'env -C . true && echo ok').stdout === 'ok\n' : has(needs));
  describe.each([
    ['env -u foo ./m?rk', 'env'],
    ['exec -a x ./m?rk', 'bash'],
    ['env -C . ./m?rk', 'env -C'],
    ['taskset -c 0 ./m?rk', 'taskset'],
    ['timeout -s kill 5 ./m?rk', 'timeout'],
  ])('backlog 531: %j', (line, needs) => {
    it('is uncertain with the expanded-name entry', () => {
      expect(commandUncertainty(line)).toContain(UNCERTAINTY.expandedName);
    });
    it.skipIf(!present(needs))(`bash runs the marker through it (skipped without ${needs})`, () => {
      expect(executed(run('bash', line).stdout)).toEqual(['1']);
    });
  });

  it('runs nothing at the bound that the policy does not read', () => {
    // Eight wrappers and nine substitutions are read: the marker is a fragment the policy judges.
    for (const line of [`${'nice '.repeat(8)}echo RAN_1`, nested(9, 'echo RAN_1')]) {
      expect(executed(run('bash', line).stdout), line).toEqual(['1']);
      expect(judged(splitCommandSegments(line), '1'), line).toBe(true);
    }
  });
});
