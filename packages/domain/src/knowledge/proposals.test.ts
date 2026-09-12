import type { LibrarianProposal } from '@platform/contracts';
import { MAX_PROPOSAL_DELTA_BYTES } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  curateProposals,
  dispositionFor,
  knowledgeApplyThresholds,
  MAX_INDEX_LINES,
  MAX_PROPOSALS_PER_RUN,
  vaultPathOf,
} from './proposals.js';

const KNOWLEDGE_DIR = '.agentic/knowledge';

const proposal = (overrides: Partial<LibrarianProposal> = {}): LibrarianProposal => ({
  action: 'add',
  kind: 'technical',
  type: 'lesson',
  target_path: 'lessons/L-2026-09-12-locks.md',
  delta: '---\ntype: lesson\n---\n\nTake the advisory lock inside the transaction.\n',
  evidence: ['https://git.example.test/acme/api/-/merge_requests/7'],
  significance: 0.4,
  reason: 'nothing in the vault covers advisory locks',
  ...overrides,
});

const curate = (
  proposals: readonly LibrarianProposal[],
  options: {
    readonly indexedPaths?: readonly string[];
    readonly autoApply?: boolean;
    readonly shadow?: boolean;
  } = {},
) =>
  curateProposals({
    proposals,
    knowledgeDir: KNOWLEDGE_DIR,
    indexedPaths: options.indexedPaths ?? [],
    thresholds: knowledgeApplyThresholds({ auto_apply: options.autoApply ?? false }),
    shadow: options.shadow ?? false,
  });

describe('the thresholds (BD-018)', () => {
  it('reads the platform defaults when the project sets none', () => {
    expect(knowledgeApplyThresholds(undefined)).toEqual({
      autoApply: false,
      discardBelow: 0.2,
      proposalAbove: 0.6,
    });
  });

  it('lets a project override one threshold without losing the others', () => {
    expect(knowledgeApplyThresholds({ discard_below: 0.05 })).toEqual({
      autoApply: false,
      discardBelow: 0.05,
      proposalAbove: 0.6,
    });
  });

  /**
   * Both sides of both edges, and the pair either side of each (standing rule 42). A guard that
   * discarded everything, and a guard that queued everything, each pass half of this.
   */
  it.each([
    [0.199, false, 'discarded'],
    [0.2, false, 'queued'],
    [0.2, true, 'auto_applied'],
    [0.599, true, 'auto_applied'],
    [0.6, true, 'queued'],
    [0.6, false, 'queued'],
    [1, true, 'queued'],
    [0, true, 'discarded'],
  ] as const)('scores %s with auto_apply=%s as %s', (significance, autoApply, expected) => {
    expect(dispositionFor(significance, knowledgeApplyThresholds({ auto_apply: autoApply }))).toBe(
      expected,
    );
  });

  it('resolves an inverted configuration towards the queue, and auto-applies nothing', () => {
    const inverted = knowledgeApplyThresholds({
      auto_apply: true,
      discard_below: 0.8,
      proposal_above: 0.3,
    });
    // The overlap [0.3, 0.8) is both "noise" and "always a proposal"; the queue wins, and the band
    // is empty so `auto_apply` has nothing to act on.
    expect(inverted).toEqual({ autoApply: true, discardBelow: 0.3, proposalAbove: 0.3 });
    expect(dispositionFor(0.5, inverted)).toBe('queued');
    expect(dispositionFor(0.9, inverted)).toBe('queued');
    expect(dispositionFor(0.1, inverted)).toBe('discarded');
  });

  it('treats a significance that is not a number as noise, never as approval', () => {
    const thresholds = knowledgeApplyThresholds({ auto_apply: true });
    expect(dispositionFor(Number.NaN, thresholds)).toBe('discarded');
    expect(dispositionFor(Number.POSITIVE_INFINITY, thresholds)).toBe('discarded');
  });

  it(
    'is monotone in significance: raising a score never moves a proposal towards discard',
    () => {
      const rank = { discarded: 0, auto_applied: 1, queued: 2 } as const;
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.boolean(),
          (a, b, autoApply) => {
            const thresholds = knowledgeApplyThresholds({ auto_apply: autoApply });
            const [low, high] = a <= b ? [a, b] : [b, a];
            expect(rank[dispositionFor(high, thresholds)]).toBeGreaterThanOrEqual(
              rank[dispositionFor(low, thresholds)],
            );
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('vaultPathOf', () => {
  it('joins a vault-relative page onto the project’s knowledge directory', () => {
    expect(vaultPathOf(KNOWLEDGE_DIR, 'lessons/L-1.md')).toBe('.agentic/knowledge/lessons/L-1.md');
    expect(vaultPathOf('knowledge/', 'index.md')).toBe('knowledge/index.md');
  });

  it.each([
    ['climbs out of the vault', '../../.github/workflows/ci.yml'],
    ['climbs out through a subdirectory', 'lessons/../../../etc/passwd'],
    ['is absolute', '/etc/passwd'],
    ['is empty', ''],
    ['is not markdown', 'lessons/L-1.txt'],
    ['has an empty segment', 'lessons//L-1.md'],
    ['is a bare dot segment', './L-1.md'],
    ['uses a Windows separator', 'lessons\\L-1.md'],
    [
      'carries a NUL, written as an escape because the file may not contain one',
      'lessons/L\u0000-1.md',
    ],
    ['is already prefixed with the knowledge directory', '.agentic/knowledge/lessons/L-1.md'],
    ['is the knowledge directory itself', '.agentic/knowledge'],
  ])('refuses a path that %s', (_why, path) => {
    expect(vaultPathOf(KNOWLEDGE_DIR, path)).toBeNull();
  });

  it(
    'never produces a path outside the knowledge directory',
    () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 60 }), (candidate) => {
          const joined = vaultPathOf(KNOWLEDGE_DIR, candidate);
          if (joined === null) {
            return;
          }
          expect(joined.startsWith(`${KNOWLEDGE_DIR}/`)).toBe(true);
          expect(joined.split('/').includes('..')).toBe(false);
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('curateProposals', () => {
  it('records every input, including the ones it refuses', () => {
    const curated = curate([proposal(), proposal({ target_path: '../escape.md' })]);
    expect(curated).toHaveLength(2);
    expect(curated.map((entry) => entry.status)).toEqual(['queued', 'discarded']);
    expect(curated[1]?.reason).toContain('BD-025');
  });

  it('turns an add into an update when the index already holds the page', () => {
    const [curated] = curate([proposal()], {
      indexedPaths: ['.agentic/knowledge/lessons/L-2026-09-12-locks.md'],
    });
    expect(curated?.action).toBe('update');
    expect(curated?.reason).toContain('already indexed');
  });

  it('leaves an explicit update alone, and a deprecate is still a write', () => {
    const curated = curate([
      proposal({ action: 'update' }),
      proposal({ action: 'deprecate', target_path: 'lessons/L-2024-old.md' }),
    ]);
    expect(curated.map((entry) => entry.action)).toEqual(['update', 'deprecate']);
    expect(curated.every((entry) => entry.writes)).toBe(true);
  });

  it('records a no-op with the page it refers to and writes nothing', () => {
    const [curated] = curate([proposal({ action: 'no-op' })]);
    expect(curated?.status).toBe('discarded');
    expect(curated?.writes).toBe(false);
    expect(curated?.repoPath).toBe('.agentic/knowledge/lessons/L-2026-09-12-locks.md');
  });

  it('auto-applies inside the band only when the project asked for it', () => {
    const inside = proposal({ significance: 0.4 });
    expect(curate([inside])[0]?.status).toBe('queued');
    expect(curate([inside], { autoApply: true })[0]?.status).toBe('auto_applied');
  });

  it('queues a shadow task’s proposal even with auto_apply on (BD-021)', () => {
    const curated = curate([proposal({ significance: 0.4 })], { autoApply: true, shadow: true });
    expect(curated[0]?.status).toBe('queued');
    expect(curated[0]?.reason).toContain('shadow');
  });

  it('refuses a page over the byte budget, and accepts one exactly at it', () => {
    const atCap = 'a'.repeat(MAX_PROPOSAL_DELTA_BYTES);
    expect(curate([proposal({ delta: atCap })])[0]?.status).toBe('queued');
    expect(curate([proposal({ delta: `${atCap}a` })])[0]?.status).toBe('discarded');
    expect(curate([proposal({ delta: `${atCap}a` })])[0]?.reason).toContain('byte budget');
  });

  it('holds the vault index to its line budget, from both sides', () => {
    const lines = (count: number) => Array.from({ length: count }, () => '- a page').join('\n');
    const at = curate([proposal({ target_path: 'index.md', delta: lines(MAX_INDEX_LINES) })]);
    const over = curate([proposal({ target_path: 'index.md', delta: lines(MAX_INDEX_LINES + 1) })]);
    expect(at[0]?.status).toBe('queued');
    expect(over[0]?.status).toBe('discarded');
    expect(over[0]?.reason).toContain('line budget');
    // …and the budget is the *index*'s, not every page's.
    const page = curate([proposal({ delta: lines(MAX_INDEX_LINES + 1) })]);
    expect(page[0]?.status).toBe('queued');
  });

  it('keeps the first proposal for a page and refuses the rest', () => {
    const curated = curate([
      proposal({ delta: 'first' }),
      proposal({ delta: 'second' }),
      proposal({ target_path: 'lessons/other.md' }),
    ]);
    expect(curated.map((entry) => entry.writes)).toEqual([true, false, true]);
    expect(curated[1]?.reason).toContain('already writes');
  });

  it('caps how many proposals one run may queue', () => {
    const many = Array.from({ length: MAX_PROPOSALS_PER_RUN + 2 }, (_, index) =>
      proposal({ target_path: `lessons/L-${index}.md` }),
    );
    const curated = curate(many);
    expect(curated.filter((entry) => entry.writes)).toHaveLength(MAX_PROPOSALS_PER_RUN);
    expect(curated.at(-1)?.reason).toContain('past the cap');
  });

  it('never lets a refusal carry a repository path it could be applied with', () => {
    const curated = curate([
      proposal({ target_path: '/etc/passwd.md' }),
      proposal({ significance: 0.01 }),
    ]);
    expect(curated[0]?.repoPath).toBeNull();
    expect(curated.every((entry) => !entry.writes)).toBe(true);
  });
});
