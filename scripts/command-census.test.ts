/**
 * The recorded-command census's classes and counts without a database (WP-225). The read itself,
 * the read-only session and the command's stdout are `command-census.integration.test.ts`'s, on
 * PostgreSQL. Every line here is composed.
 */
import { describe, expect, it } from 'vitest';
import {
  censusCounts,
  formatCensus,
  parseCensusArguments,
  type RecordedCall,
  TIER3_CLASSES,
  tier3ClassesOf,
} from './command-census.js';

const classes = (line: string, written: readonly string[] = []): string[] =>
  [...tier3ClassesOf(line, new Set(written))].sort();

const bash = (runId: string, toolUseId: string | null, command: string | null): RecordedCall => ({
  runId,
  toolUseId,
  toolName: 'Bash',
  command,
  filePath: null,
});

describe('the tier-3 classes, one heuristic each', () => {
  it.each([
    'python3 -c "import os; print(os.getcwd())"',
    'python3.12 -I -c "print(1)"',
    'python3 -W error -c "print(1)"',
    'node -e "process.exit(0)"',
    'node --eval=1',
    'nodejs -p 1+1',
    "perl -ne 'print if /x/' f",
    "ruby -r json -e 'p 1'",
    "php -r 'echo 1;'",
    'deno eval "1"',
    'cat x.py | python3',
    'python3 - <<EOF\nprint(1)\nEOF',
    'env FOO=1 timeout 5 python3 -c "print(1)"',
  ])('%j is an inline script to a composing interpreter', (line) => {
    expect(classes(line)).toEqual(['inline_interpreter']);
  });

  it.each([
    'python3 -m pytest -q',
    'python3 script.py',
    'node --version',
    'node dist/index.js',
    'perl -v',
    'grep -c python3 notes.txt',
  ])('%j is no inline script', (line) => {
    expect(classes(line)).toEqual([]);
  });

  it.each([
    ['bash build-helper.sh', ['build-helper.sh']],
    ['sh ./tools/build-helper.sh --fast', ['build-helper.sh']],
    ['./tools/build-helper.sh', ['build-helper.sh']],
    ['. ./env.sh && make', ['env.sh']],
    ['python3 gen.py', ['gen.py']],
  ])('%j runs a script the run wrote', (line, written) => {
    expect(classes(line, written)).toEqual(['written_script']);
  });

  it.each([
    ['bash build-helper.sh', []],
    ['bash scripts/existing.sh', ['build-helper.sh']],
    ['cat ./tools/build-helper.sh', ['build-helper.sh']],
  ])('%j runs no script the run wrote (written: %j)', (line, written) => {
    expect(classes(line, written)).toEqual([]);
  });

  it('counts a script written and run on one line, and only in the run that wrote it', () => {
    const counts = censusCounts([
      bash('a', 'a1', "printf 'git status' > run.sh; sh run.sh"),
      bash('b', 'b1', 'sh run.sh'),
      { runId: 'b', toolUseId: 'b2', toolName: 'Write', command: null, filePath: '/w/later.sh' },
      bash('b', 'b3', 'sh later.sh'),
    ]);
    expect(counts.tier3.written_script.lines).toBe(2);
  });

  it.each(['git -C ../other status', 'git -c core.pager=cat -C sub log', 'env git -C x diff'])(
    '%j is git -C',
    (line) => {
      expect(classes(line)).toEqual(['git_dash_c']);
    },
  );

  it.each(['git status', 'git --git-dir=x status', 'git log -C'])('%j is not git -C', (line) => {
    expect(classes(line)).toEqual([]);
  });

  it.each([
    'frobnicate --target "$TARGET"',
    'frobnicate `cat list`',
    'frobnicate $x id',
    'frobnicate --in "$(cat list)"',
  ])('%j is a wrapper the policy does not know, handed an expansion', (line) => {
    expect(classes(line)).toEqual(['unshipped_wrapper_expansion']);
  });

  it.each(["frobnicate '$x'", 'frobnicate plain', 'echo "$HOME"', 'ls "$dir"', 'echo "$(date)"'])(
    '%j is not',
    (line) => {
      expect(classes(line)).toEqual([]);
    },
  );
});

describe('the counts', () => {
  it('counts each line once, through the three cells, and every class by name', () => {
    const counts = censusCounts([
      bash('a', 'a1', 'ls -la'),
      bash('a', 'a1', 'ls -la'),
      bash('a', 'a2', null),
      bash('a', 'a3', 'python3 -c "print(1)"'),
      bash('a', 'a4', 'zzunknown sudo id'),
      bash('a', null, 'git status'),
    ]);
    expect(counts.lines).toBe(4);
    expect(counts.skippedNoCommand).toBe(1);
    expect(counts.runs).toBe(1);
    for (const mode of ['attended', 'auto', 'deny'] as const) {
      expect(Object.values(counts.cells[mode]).reduce((a, b) => a + b, 0)).toBe(4);
    }
    expect(counts.uncertainty.unknownProgramRunsJudgedName).toBe(1);
    expect(counts.tier3.inline_interpreter).toEqual({ lines: 1, ranUnderAuto: 1 });
    expect(counts.tier3.any.lines).toBe(1);
  });

  it('counts each call stored with the normaliser’s `unknown` id, and dedups a real id', () => {
    const counts = censusCounts([
      bash('a', 'unknown', 'ls -la'),
      bash('a', 'unknown', 'ls -la'),
      bash('a', 'toolu_1', 'ls -la'),
      bash('a', 'toolu_1', 'ls -la'),
    ]);
    expect(counts.lines).toBe(3);
  });

  it('prints counts under fixed names and never a word of a line (rule 43)', () => {
    const token = 'zzcensustoken9f3a';
    // A reason-tag printer would leak the program name; a cell-tag printer the matched entry.
    const counts = censusCounts([
      bash('r', 't1', `${token} sudo id`),
      bash('r', 't2', `python3 -c "print('${token}')"`),
      bash('r', 't3', `git -C ${token} status`),
      bash('r', 't4', `cat ${token}.txt`),
    ]);
    const text = formatCensus({ rowsRead: 4, capReached: false, skippedBlobRows: 0 }, counts, {
      since: new Date('2026-10-01T00:00:00Z'),
      cap: 10,
    });
    expect(text).not.toContain(token);
    expect(text).toContain('uncertainty.unknownProgramRunsJudgedName: 1');
    for (const line of text.trimEnd().split('\n')) {
      expect(line).toMatch(/^[a-z0-9_]+(?:\.[A-Za-z0-9_]+)*: (?:[-0-9TZ:.]+|yes|no)$/);
    }
    for (const name of TIER3_CLASSES) {
      expect(text).toContain(`tier3.${name}: `);
    }
  });
});

describe('the arguments', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  it('defaults to thirty days and 100 000 rows', () => {
    expect(parseCensusArguments([], now)).toEqual({
      since: new Date('2026-09-19T00:00:00Z'),
      cap: 100_000,
    });
  });
  it('reads --since and --cap and refuses anything else', () => {
    expect(parseCensusArguments(['--since', '2026-01-01', '--cap', '5'], now)).toEqual({
      since: new Date('2026-01-01'),
      cap: 5,
    });
    expect(parseCensusArguments(['--since', 'yesterday'], now)).toMatch(/ISO 8601/);
    expect(parseCensusArguments(['--cap', '0'], now)).toMatch(/integer/);
    expect(parseCensusArguments(['--cap', '1.5'], now)).toMatch(/integer/);
    expect(parseCensusArguments(['--cap', '1'], now)).toMatchObject({ cap: 1 });
    expect(parseCensusArguments(['--cap', '10000000'], now)).toMatchObject({ cap: 10_000_000 });
    expect(parseCensusArguments(['--cap', '10000001'], now)).toMatch(/integer/);
    expect(parseCensusArguments(['--write'], now)).toMatch(/usage/);
  });
});
