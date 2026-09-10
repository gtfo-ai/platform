import { describe, expect, it } from 'vitest';
import {
  FLAGGED_CONFIG_PATHS,
  guardWriteContent,
  guardWritePath,
  matchesPathPattern,
  writeContentsOf,
  writeTargetOf,
} from './path-guard.js';

const config = {
  workspacePath: '/workspace/task-1',
  protectedPaths: ['infra/**', 'db/migrations/**', 'Dockerfile'],
  plannedProtectedPaths: [] as string[],
};

describe('the path glob', () => {
  it.each([
    ['infra/**', 'infra/main.tf', true],
    ['infra/**', 'infra/modules/vpc/main.tf', true],
    ['infra/**', 'infrastructure/main.tf', false],
    ['infra', 'infra/main.tf', true],
    ['infra/', 'infra/main.tf', true],
    ['Dockerfile', 'Dockerfile', true],
    ['Dockerfile', 'docker/Dockerfile', false],
    ['src/*.ts', 'src/index.ts', true],
    ['src/*.ts', 'src/nested/index.ts', false],
    ['my dir/*', 'my dir/file.ts', true],
    ['my dir/*', 'myXdir/file.ts', false],
    // A directory pattern covers the directory node itself, which is what the docblock says and
    // what `infra/**` did not do.
    ['infra/**', 'infra', true],
    ['infra/', 'infra', true],
    ['.claude/**', '.claude', true],
  ])('%s vs %s', (pattern, path, expected) => {
    expect(matchesPathPattern(pattern, path)).toBe(expected);
  });

  /**
   * The filesystem decides which names are the same file, and on APFS and NTFS `.ENV` **is**
   * `.env` — verified by writing `.ENV` on an APFS volume during WP-12's review and watching it
   * overwrite `.env`. Protected paths have no container backstop, so a case-sensitive match here
   * is BD-024 failing open on `local` mode and on every macOS or Windows bind mount.
   *
   * The rows after the case ones are the classes lowercase *mapping* misses and the filesystem's
   * full case *folding* catches. `path-guard.filesystem.test.ts` puts every one of them to a real
   * volume rather than to Unicode theory, which is how they were found.
   */
  it.each([
    ['.env', '.ENV'],
    ['.env', '.Env'],
    ['infra/**', 'INFRA/main.tf'],
    ['infra/**', 'infra/MAIN.TF'],
    ['.claude/**', '.CLAUDE/settings.json'],
    ['CLAUDE.md', 'claude.md'],
    // U+FB01 / U+FB02 ligatures: `con\uFB01g/app.yaml` wrote straight through `config/app.yaml`.
    ['config/**', 'con\uFB01g/app.yaml'],
    ['conflict/**', 'con\uFB02ict/app.yaml'],
    // U+017F LATIN SMALL LETTER LONG S.
    ['secrets/**', '\u017Fecrets/token.txt'],
    ['src/**', '\u017Frc/index.ts'],
    // U+00DF sharp s, which NFKC does *not* expand, and U+1E9E its capital.
    ['assets/**', 'a\u00DFets/logo.svg'],
    ['strasse/**', 'stra\u00DFe/x.tf'],
    ['strasse/**', 'stra\u1E9Ee/x.tf'],
    // The singleton compatibility letters: Kelvin, Ohm, Angstrom.
    ['k8s/**', '\u212A8s/deploy.yaml'],
    ['\u2126/**', '\u03C9/x.tf'],
    ['\u212Bngstrom/**', '\u00E5ngstrom/x.tf'],
  ])('matches %s against the variant %s the volume treats as the same file', (pattern, target) => {
    expect(matchesPathPattern(pattern, target)).toBe(true);
  });

  /**
   * NFKC folds more than the filesystem does, and that is deliberate: `x\u00B2` and `x2` are
   * *different* files on APFS (different inodes — see the filesystem test) and the same string
   * here, so the guard denies a write that would not have collided. A false deny plus a reason
   * string the agent can act on is the direction BD-024 asks to err in; it is written as an
   * assertion so that narrowing the fold later has to come past it.
   */
  it.each([
    ['x2/**', 'x\u00B2/a.tf'],
    ['ix/**', '\u2168/a.tf'],
    ['my dir/*', 'my\u00A0dir/a.tf'],
  ])('is deliberately wider than the volume: %s vs %s', (pattern, target) => {
    expect(matchesPathPattern(pattern, target)).toBe(true);
  });

  /**
   * The one widening that would fail **open**, and the reason the fold is per segment — and it is a
   * **class of characters, not one character**. Five code points in the whole of Unicode fold to
   * something containing `/` (swept U+0001–U+10FFFF on Node 25.1, ICU 77.1 / Unicode 16.0):
   * U+FF0F FULLWIDTH SOLIDUS, which the review found, and the four compatibility abbreviations
   * U+2100 (`a/c`), U+2101 (`a/s`), U+2105 (`c/o`) and U+2106 (`c/u`). The volume folds none of
   * them — `a\uFF0Fb.ts` is one ordinary file with its own inode, and so is `a\u2100b.ts`. A fold
   * that let one become a separator would split the name in two, and `src/*.ts` — whose `*` may
   * not cross `/` — would answer *allow* for a file the operator's glob covers.
   *
   * The pin in `path-guard.ts` is a plain `replaceAll`, so it covers the class rather than the
   * character that was found first: a sixth code point in a later Unicode version needs no change
   * there, and it would arrive here as one more row.
   */
  it.each([
    ['U+FF0F FULLWIDTH SOLIDUS', '\uFF0F'],
    ['U+2100 ACCOUNT OF', '\u2100'],
    ['U+2101 ADDRESSED TO THE SUBJECT', '\u2101'],
    ['U+2105 CARE OF', '\u2105'],
    ['U+2106 CADA UNA', '\u2106'],
  ])('does not let %s become a path separator', (_name, char) => {
    // What a whole-string fold would have turned the name into: a path, not a name.
    const split = char.normalize('NFKC').toLowerCase();
    expect(split).toContain('/');
    expect(matchesPathPattern('src/*.ts', `src/a${char}b.ts`)).toBe(true);
    expect(matchesPathPattern('src/*', `src/a${char}b`)).toBe(true);
    // The pattern side folds identically, so an operator who writes the character into
    // `protected_paths` still names one segment, and it is not the same as a real separator.
    expect(matchesPathPattern(`src/a${char}b.ts`, `src/a${char}b.ts`)).toBe(true);
    expect(matchesPathPattern(`src/a${char}b.ts`, `src/a${split}b.ts`)).toBe(false);
  });

  /**
   * The stand-in for a fold-produced `/` is a **literal character**, and three values would break
   * that in three different ways: `/` itself is the fail-open it exists to prevent; `''` erases the
   * character, making `a\uFF0Fb.ts` and `ab.ts` one path; and anything the glob compiler reads as
   * syntax — U+E000, which stands in for `**`, or `*`, or `?` — turns a *pattern* containing one
   * of these characters into a wildcard. Every other value is a widening and therefore fails closed,
   * which is why the review's `'*'` mutation survived all 77 tests: nothing asserted the property
   * that separates a literal from syntax. This does.
   */
  it('pins the stand-in for a fold-produced solidus to a literal character', () => {
    // `''` would make these two the same path.
    expect(matchesPathPattern('src/ab.ts', 'src/a\uFF0Fb.ts')).toBe(false);
    expect(matchesPathPattern('src/a\uFF0Fb.ts', 'src/ab.ts')).toBe(false);
    // `*`, `?` or U+E000 would make the pattern match names that merely look like it.
    expect(matchesPathPattern('src/a\uFF0Fb.ts', 'src/aXb.ts')).toBe(false);
    expect(matchesPathPattern('src/a\uFF0Fb.ts', 'src/aXYZb.ts')).toBe(false);
    // `/` itself is killed by the rows above: a *subject* holding one of the five must still match
    // `src/*.ts`, which it cannot once the fold has split it across a separator.
  });

  it('matches across Unicode normalisation forms, which APFS also folds together', () => {
    // `café/secret.tf` composed (NFC) as a pattern, decomposed (NFD) as the write target.
    expect(matchesPathPattern('caf\u00E9/**', 'cafe\u0301/secret.tf')).toBe(true);
    expect(matchesPathPattern('cafe\u0301/**', 'caf\u00E9/secret.tf')).toBe(true);
  });

  it('still separates names that differ by more than case', () => {
    expect(matchesPathPattern('infra/**', 'infrastructure/main.tf')).toBe(false);
    expect(matchesPathPattern('.env', '.env.example')).toBe(false);
    // The Turkish pair: the volume keeps `\u0131` and `\u0130` apart from `i` (different inodes),
    // and so does this fold, because `toLowerCase` is locale-free.
    expect(matchesPathPattern('infra/**', '\u0131nfra/main.tf')).toBe(false);
    expect(matchesPathPattern('infra/**', '\u0130nfra/main.tf')).toBe(false);
  });
});

describe('guardWritePath', () => {
  it('allows an ordinary file inside the workspace', () => {
    const verdict = guardWritePath('src/index.ts', config);
    expect(verdict.decision).toBe('allow');
    expect(verdict.relativePath).toBe('src/index.ts');
  });

  it('denies an absolute path outside the workspace', () => {
    const verdict = guardWritePath('/etc/passwd', config);
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('outside the task workspace');
  });

  it('denies a relative path that climbs out with `..`', () => {
    const verdict = guardWritePath('../../etc/passwd', config);
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('outside the task workspace');
  });

  it('denies the workspace root itself, which is a directory and not a file', () => {
    expect(guardWritePath('/workspace/task-1', config).decision).toBe('deny');
  });

  it('denies an empty path rather than resolving it to the workspace root', () => {
    expect(guardWritePath('   ', config).decision).toBe('deny');
  });

  it('denies a path carrying a NUL, which the guard and a C library would read differently', () => {
    const verdict = guardWritePath('CLAUDE.md\u0000.txt', config);
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('NUL byte');
  });

  /** The three the review actually wrote on an APFS volume, end to end through the verdict. */
  it('denies a protected path spelled in a different case (BD-024 has no container backstop)', () => {
    const verdict = guardWritePath('INFRA/main.tf', config);
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('the approved plan does not list it');
  });

  it('denies `.ENV` when `.env` is protected', () => {
    const verdict = guardWritePath('.ENV', { ...config, protectedPaths: ['infra/**', '.env'] });
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('matches the protected path ".env"');
  });

  it('flags `.CLAUDE/settings.json`, which is the same file as `.claude/settings.json`', () => {
    const verdict = guardWritePath('.CLAUDE/settings.json', config);
    expect(verdict.decision).toBe('flag');
    expect(verdict.reason).toContain('flagged for Code review');
  });

  it('reports the path as the model wrote it, not in the folded form it was matched in', () => {
    expect(guardWritePath('INFRA/main.tf', config).relativePath).toBe('INFRA/main.tf');
  });

  it('lets the plan list a protected path in a different case, since the fold is symmetric', () => {
    const verdict = guardWritePath('INFRA/main.tf', {
      ...config,
      plannedProtectedPaths: ['infra/**'],
    });
    expect(verdict.decision).toBe('allow');
  });

  it('denies a protected path the plan does not list (BD-024)', () => {
    const verdict = guardWritePath('infra/modules/vpc/main.tf', config);
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('the approved plan does not list it');
  });

  it('allows a protected path the plan does list', () => {
    const verdict = guardWritePath('infra/modules/vpc/main.tf', {
      ...config,
      plannedProtectedPaths: ['infra/modules/**'],
    });
    expect(verdict.decision).toBe('allow');
  });

  it.each(FLAGGED_CONFIG_PATHS.map((pattern) => [pattern]))(
    'flags a write to %s rather than denying it',
    (pattern) => {
      const target = pattern.replace('/**', '/rules.md');
      const verdict = guardWritePath(target, config);
      expect(verdict.decision).toBe('flag');
      expect(verdict.reason).toContain('flagged for Code review');
    },
  );

  it('decides "outside the workspace" before any pattern, so the reason is the true one', () => {
    // `/workspace/other/infra/main.tf` would match `infra/**` if it were matched relatively.
    const verdict = guardWritePath('/workspace/other/infra/main.tf', config);
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('outside the task workspace');
    expect(verdict.reason).not.toContain('protected path');
  });
});

describe('guardWriteContent', () => {
  it('denies content that carries a credential shape, naming the rule', () => {
    const verdict = guardWriteContent('GITLAB_TOKEN=glpat-FAKE000000000000000\n');
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('gitlab-token');
  });

  it('allows ordinary source', () => {
    expect(guardWriteContent('export const two = 1 + 1;\n').decision).toBe('allow');
  });
});

describe('reading the tool input', () => {
  it.each([
    [{ file_path: 'a.ts' }, 'a.ts'],
    [{ path: 'b.ts' }, 'b.ts'],
    [{ notebook_path: 'c.ipynb' }, 'c.ipynb'],
    [{}, null],
    ['not an object', null],
  ])('reads the target out of %s', (input, expected) => {
    expect(writeTargetOf(input)).toBe(expected);
  });

  it('finds content nested inside an edits array, not only at the top level', () => {
    const contents = writeContentsOf({
      file_path: 'a.ts',
      edits: [{ old_string: 'x', new_string: 'SECRET-ONE' }, { new_string: 'SECRET-TWO' }],
    });
    expect(contents).toEqual(['SECRET-ONE', 'SECRET-TWO']);
  });

  it('reads a plain Write body', () => {
    expect(writeContentsOf({ file_path: 'a.ts', content: 'body' })).toEqual(['body']);
  });
});
