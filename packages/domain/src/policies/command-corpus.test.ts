/**
 * WP-208 (TD-030 decision 4): the agent-line corpus, `test/fixtures/commands/`, recomputed cell by
 * cell. Every `<name>.txt` there is a corpus and `<name>.verdicts.json` records each line's attended,
 * `auto` and `deny` cells under the default policy; a scanner change that moves a cell fails here
 * printing `line | cell | before | after` and the three counts a scanner row quotes as its over-ask,
 * and regenerates the file with `node scripts/command-corpus.mjs --write`. The fixture is read as a
 * file, never imported. Nothing executes: the cells are the policy's answers.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type CorpusCells,
  corpusCells,
  corpusDiff,
  corpusLines,
  uncertaintyTag,
} from '../testing/command-corpus.js';
import { unknownProgramRunsJudgedName, xargsCompletesBlockEntry } from './command-policy.js';

const DIRECTORY = new URL('../../../../test/fixtures/commands/', import.meta.url);
const CORPORA = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith('.txt'))
  .sort();

const read = (name: string) => {
  const lines = corpusLines(
    readFileSync(new URL(name, DIRECTORY), 'utf8'),
    `test/fixtures/commands/${name}`,
  );
  const recorded = JSON.parse(
    readFileSync(new URL(name.replace(/\.txt$/, '.verdicts.json'), DIRECTORY), 'utf8'),
  ) as Record<string, Partial<CorpusCells>>;
  return { lines, recorded };
};

describe('the agent-line corpus (test/fixtures/commands/)', () => {
  it('holds the two corpora the row commits', () => {
    expect(CORPORA).toEqual(['agent-lines.txt', 'developer-lines.txt']);
    expect(read('agent-lines.txt').lines).toHaveLength(286);
  });

  it.each(CORPORA)('%s: the verdicts hold exactly one entry per line, in corpus order', (name) => {
    const { lines, recorded } = read(name);
    expect(Object.keys(recorded)).toEqual(lines);
  });

  it.each(CORPORA)('%s: every recorded cell is the one the default policy answers', (name) => {
    const { lines, recorded } = read(name);
    const { changes, newlyRefused, newlyAllowed, newlyAsked } = corpusDiff(recorded, lines);
    const diff = [
      'line | cell | before | after',
      ...changes.map(
        ({ line, cell, before, after }) =>
          `${JSON.stringify(line)} | ${cell} | ${before} | ${after}`,
      ),
      `${changes.length} cells changed: ${newlyRefused} newly refused, ${newlyAllowed} newly allowed, ${newlyAsked} newly asked`,
      'If the change is intended: node scripts/command-corpus.mjs --write, and record the counts.',
    ].join('\n');
    expect(changes, diff).toEqual([]);
  });
});

describe('corpusLines refuses what the verdicts cannot key', () => {
  it('a blank line', () => {
    expect(() => corpusLines('ls\n\npwd\n', 'f')).toThrow('f:2 is blank');
  });

  it('a repeated line', () => {
    expect(() => corpusLines('ls\npwd\nls\n', 'f')).toThrow('f:3 repeats "ls"');
  });
});

describe('corpusCells tags every cell that is not allow with what decided it', () => {
  it.each([
    ['git status', { attended: 'allow', auto: 'allow', deny: 'allow' }],
    ['sudo id', { attended: 'block: sudo *', auto: 'block: sudo *', deny: 'block: sudo *' }],
    [
      'git push origin main',
      {
        attended: 'ask: git push*',
        auto: expect.stringMatching(/^git: /),
        deny: expect.stringMatching(/^git: /),
      },
    ],
    [
      'eval "$x"',
      {
        attended: 'uncertain: handedCommand',
        auto: 'uncertain: handedCommand',
        deny: 'uncertain: handedCommand',
      },
    ],
  ])('%s', (command, cells) => {
    expect(corpusCells(command)).toEqual(cells);
  });

  it('reads a built reason back as its builder and argument, and leaves an unnamed one whole', () => {
    expect(uncertaintyTag(xargsCompletesBlockEntry('rm -rf /*'))).toBe(
      'xargsCompletesBlockEntry(rm -rf /*)',
    );
    expect(uncertaintyTag(unknownProgramRunsJudgedName('fakeroot', 'sudo'))).toBe(
      'unknownProgramRunsJudgedName(fakeroot, sudo)',
    );
    expect(uncertaintyTag('a reason nobody named')).toBe('a reason nobody named');
  });
});

describe('corpusDiff counts what moved', () => {
  it('names the line, the cell and both values, and counts a refusal and an allow', () => {
    const recorded = {
      'sudo id': { attended: 'allow', auto: 'block: sudo *', deny: 'block: sudo *' },
      ls: { attended: 'allow', auto: 'uncertain: handedCommand', deny: 'allow' },
    };
    const { changes, newlyRefused, newlyAllowed } = corpusDiff(recorded, ['sudo id', 'ls']);
    expect(changes).toEqual([
      { line: 'sudo id', cell: 'attended', before: 'allow', after: 'block: sudo *' },
      { line: 'ls', cell: 'auto', before: 'uncertain: handedCommand', after: 'allow' },
    ]);
    expect({ newlyRefused, newlyAllowed }).toEqual({ newlyRefused: 1, newlyAllowed: 1 });
  });

  it('counts an allow that now asks, which is neither refused nor allowed (WP-210)', () => {
    const recorded = {
      'git push origin main': { attended: 'allow' },
      'git status': { attended: 'ask: git status' },
    };
    const { changes, newlyRefused, newlyAllowed, newlyAsked } = corpusDiff(recorded, [
      'git push origin main',
      'git status',
    ]);
    expect(changes.filter(({ cell }) => cell === 'attended')).toEqual([
      { line: 'git push origin main', cell: 'attended', before: 'allow', after: 'ask: git push*' },
      { line: 'git status', cell: 'attended', before: 'ask: git status', after: 'allow' },
    ]);
    expect(newlyAsked).toBe(1);
    expect({ newlyRefused, newlyAllowed }).toEqual({ newlyRefused: 2, newlyAllowed: 0 });
  });

  it('counts an allow that now runs only under auto as newly asked (WP-210 review round 1)', () => {
    const recorded = { 'git diff': { auto: 'allow' }, 'sed -i x f': { auto: 'allow' } };
    const { changes, newlyAsked } = corpusDiff(recorded, ['git diff', 'sed -i x f']);
    expect(changes.filter(({ cell }) => cell === 'auto')).toEqual([
      { line: 'sed -i x f', cell: 'auto', before: 'allow', after: 'auto: unmatched' },
    ]);
    expect(newlyAsked).toBe(1);
  });
});
