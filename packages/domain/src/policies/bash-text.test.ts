/**
 * WP-260 (backlogs 662, 664, 665, 666 and 667): the join pass, held to bash's own reading, and the
 * census that keeps it the only reader of a line continuation.
 *
 * Every expected text below is what bash 5.3.20 and `/bin/bash` 3.2.57 read (measured with
 * `printf '[%s]'`, `read -r -d ''` and `echo RAN` under `--norc --noprofile`, `env -i`, stdin
 * `/dev/null`, PROGRESS § WP-260), except the two rows marked as 5.3's, where the bashes differ.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';
import { joinLineContinuations } from './bash-text.js';

const C = '\\\n';

describe('joinLineContinuations: removed where bash removes a continuation', () => {
  it.each([
    [`a${C}b "c${C}d"`, 'ab "cd"'],
    [
      `\`printf x${C}y\` $(printf p${C}q) \${HOME:+s${C}t} $((1${C}+2))`,
      `\`printf xy\` $(printf pq) \${HOME:+st} $((1+2))`,
    ],
    // Inside an opener (665, 666) and before an ANSI-C string (667).
    [
      `$${C}(printf r) "$${C}(printf X)" <${C}(true) $${C}((4))`,
      '$(printf r) "$(printf X)" <(true) $((4))',
    ],
    [`$${C}${C}(printf r)`, '$(printf r)'],
    // A comment begins at the word the join leaves, and keeps the pair inside it.
    [`ls ${C}# x ${C}sudo id`, `ls # x ${C}sudo id`],
    [`ls a${C}# x ${C}sudo id`, 'ls a# x sudo id'],
    [`$${C}'\\x41' $${C}'-delete'`, "$'\\x41' $'-delete'"],
    // Inside an operator and a redirection target (662).
    [
      `printf x >${C}/dev/null x${C}y; printf x 2${C}>/dev/null z`,
      'printf x >/dev/null xy; printf x 2>/dev/null z',
    ],
    [`git >o${C}ut status`, 'git >out status'],
    [`cat <${C}<EOF\nq\nEOF`, 'cat <<EOF\nq\nEOF'],
    [`cat <<${C}-EOF\n\tq\n\tEOF`, 'cat <<-EOF\n\tq\n\tEOF'],
    // A backtick body is read flat: single quotes and a comment in it do not keep a pair.
    [`\`printf '%s' 'a${C}b'\``, "`printf '%s' 'ab'`"],
    [`\`printf c # x ${C}echo d\``, '`printf c # x echo d`'],
    // In double quotes a single quote and `$'` are plain characters.
    [`"\${x:-'a${C}b'}"`, `"\${x:-'ab'}"`],
    [`"$'a${C}b'" "$${C}'x'"`, `"$'ab'" "$'x'"`],
    [`$(printf '%s' "'"a${C}b"'")`, `$(printf '%s' "'"ab"'")`],
    // A here-document's delimiter, an unquoted body and its terminator line (664).
    [`cat <<E${C}OF\nz\nEOF`, 'cat <<EOF\nz\nEOF'],
    [`cat <<EOF\nx${C}y\nE${C}OF\necho RAN`, 'cat <<EOF\nxy\nEOF\necho RAN'],
    [`cat <<EOF\n'a${C}b'\nEOF`, "cat <<EOF\n'ab'\nEOF"],
    [`cat <<EOF\nx${C}EOF\necho RAN`, 'cat <<EOF\nxEOF\necho RAN'],
    // `<<-`: leading tabs come off the joined line, so `\tE\⏎OF` ends the body and `\tE\⏎\tOF` does not.
    [`cat <<-EOF\nx\n\tE${C}OF\necho RAN`, 'cat <<-EOF\nx\n\tEOF\necho RAN'],
    [`cat <<-EOF\nx\n\tE${C}\tOF\na${C}b`, 'cat <<-EOF\nx\n\tE\tOF\nab'],
    [`echo "$(cat <<EOF\na${C}b\nEOF\n)"`, 'echo "$(cat <<EOF\nab\nEOF\n)"'],
    [`cat <<A <<B\na${C}A\nA\nb\nB\nx${C}y`, 'cat <<A <<B\naA\nA\nb\nB\nxy'],
  ])('%j reads %j', (raw, joined) => {
    expect(joinLineContinuations(raw)).toBe(joined);
    expect(joinLineContinuations(joined)).toBe(joined);
  });
});

describe('joinLineContinuations: kept where bash keeps it', () => {
  it.each([
    `printf '[%s]' $'e${C}f' 'g${C}h'`,
    `ls $'a${C}b'`,
    `ls 'a${C}';sudo id`,
    // After an escaping backslash: an escaped `\`, then a real newline.
    'ls a\\\\\nsudo id',
    'echo "a\\\\\nb"',
    // A comment runs to its newline, a `\` in it included.
    `ls # x ${C}sudo id`,
    // A command substitution's own quote state (both bashes).
    `printf '[%s]' $(printf '%s' 'a${C}b') "$(printf '%s' 'a${C}b')" <(printf 'a${C}b')`,
    `unset x; printf '[%s]' \${x:-'a${C}b'} \${x:-$'a${C}b'}`,
    `$(case x in x) printf 'a${C}b';; esac)`,
    // A quoted delimiter's body, and a quoted delimiter that keeps its own pair.
    `cat <<'EOF'\nx${C}EOF\nsudo id`,
    `cat <<'E${C}OF'\nz\nE${C}OF\necho RAN`,
    // bash 5.3's reading, where 3.2 joins: a comment and a quoted body inside `$(…)`.
    `printf '[%s]' $(printf c # x ${C}echo d\n)`,
    `printf '[%s]' "$(cat <<'EOF'\na${C}b\nEOF\n)"`,
    // After a `<<-` body's terminator (leading tabs off), and after a `case` pattern's `)`.
    `cat <<-EOF\n\tx\n\tEOF\nls 'a${C}b'`,
    `echo "$(case x in x) printf 'a${C}b';; esac)"`,
    // A `<<` in an arithmetic expansion is a shift: no body follows.
    `echo $[1<<2]\nls # x ${C}sudo id`,
    `echo $((1<<2)) \${x:-<<EOF}\nls # x ${C}sudo id`,
  ])('%j is kept as written', (raw) => {
    expect(joinLineContinuations(raw)).toBe(raw);
  });

  it('removes the continuations around a kept region and keeps the region', () => {
    expect(joinLineContinuations(`l${C}s 'a${C}b' $${C}'c${C}d' # e${C}\nf${C}g`)).toBe(
      `ls 'a${C}b' $'c${C}d' # e${C}\nfg`,
    );
  });
});

/**
 * The census (WP-260 ruling (5)): no non-test source under `packages/domain/src/policies` but the
 * join pass tests for a `\` followed by a newline. Scope: every `.ts` there that git knows about —
 * tracked, staged or untracked and not ignored (`censusPaths`, rule 85) — read without comments.
 * The spellings it refuses: an escaped backslash followed by an escaped newline in one literal or
 * regular expression (`'\\\n'`, `/\\\n/`); a line comparing a character to `'\\'` and to `'\n'`
 * (either quote); the char codes 92 and 10 on one line; and the names of the readers WP-260
 * deleted. **What it cannot see**: a test split across lines (`c === '\\'` on one, the newline on
 * the next), the two characters held in variables (`const nl = '\n'`), a character class
 * (`/[\\][\n]/`), a computed string (`String.fromCharCode`), and a reader outside this directory.
 */
describe('WP-260: the join pass is the only reader of a line continuation (census)', () => {
  const root = path.resolve(import.meta.dirname, '../../../..');
  const JOIN_PASS = 'packages/domain/src/policies/bash-text.ts';
  const SPELLINGS: readonly (readonly [string, RegExp])[] = [
    ['an escaped backslash and newline in one literal', /\\\\\\n/],
    [
      "a character compared to '\\\\' and to '\\n'",
      /(['"`])\\\\\1.*(['"`])\\n\2|(['"`])\\n\3.*(['"`])\\\\\4/,
    ],
    ['the char codes of a backslash and a newline', /\b92\b.*\b10\b|\b10\b.*\b92\b/],
    [
      'a deleted continuation reader',
      /\b(?:isContinuationAt|isLineContinuation|joinContinuations|joinQuotedContinuations|withoutContinuations|continuedNewline)\b/,
    ],
  ];
  const offences = (file: string, source: string): readonly string[] =>
    withoutComments(source)
      .split('\n')
      .flatMap((line, index) =>
        SPELLINGS.filter(([, spelling]) => spelling.test(line)).map(
          ([name]) => `${file}:${index + 1}: ${name}`,
        ),
      );

  it('finds none outside bash-text.ts', () => {
    const files = censusPaths(root, {
      pathspecs: ['packages/domain/src/policies/*.ts'],
      include: (file: string) => !file.endsWith('.test.ts') && file !== JOIN_PASS,
    });
    expect(files).toContain('packages/domain/src/policies/command-policy.ts');
    expect(files).toContain('packages/domain/src/policies/unattended-commands.ts');
    expect(files.flatMap((file: string) => offences(file, censusText(root, file)))).toEqual([]);
  }, 15_000);

  it('refuses each spelling it names (planted)', () => {
    expect(offences('x.ts', "const a = text.includes('\\\\\\n');")).toHaveLength(1);
    expect(offences('x.ts', 'const a = /^(?:\\\\\\n)+/.test(text);')).toHaveLength(1);
    expect(offences('x.ts', "if (c === '\\\\' && text[i + 1] === '\\n') {")).toHaveLength(1);
    expect(offences('x.ts', 'if (t[i + 1] === "\\n" && t[i] === "\\\\") {')).toHaveLength(1);
    expect(
      offences('x.ts', 'if (t.charCodeAt(i) === 92 && t.charCodeAt(i + 1) === 10) {'),
    ).toHaveLength(1);
    expect(offences('x.ts', 'const ok = isContinuationAt(text, index);')).toHaveLength(1);
    // The join pass itself is a reader, which is why it is the one file left out.
    expect(offences(JOIN_PASS, censusText(root, JOIN_PASS)).length).toBeGreaterThan(0);
    // A comment is not read.
    expect(offences('x.ts', "// text.includes('\\\\\\n')")).toEqual([]);
  });
});
