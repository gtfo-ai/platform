/**
 * Ranking, validate-on-read and the budget fill.
 *
 * The token-budget figure the work package is accepted on is produced in
 * `packages/application/src/knowledge/context-pack.test.ts`, against the fixture vault and through
 * the real parser. What is pinned *here* is the arithmetic that figure rests on, and — the part
 * that matters for standing rules 3 and 10 — that each guard has a test which **names the branch**
 * and dies when the guard is reverted.
 */
import { BUILTIN_STAGE_IDS, type IsoDate } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  type AssembleContextPackInput,
  assembleContextPack,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_EMPHASIS,
  EMPHASIS_LAYER_WEIGHTS,
  emphasisFor,
  MAX_TIER1_DOCUMENTS,
  type RetrievalCandidate,
  STAGE_EMPHASIS,
  scoreCandidate,
  type Tier0Document,
  validateAgainstHead,
} from './retrieval.js';

const TODAY = '2026-09-11' as IsoDate;

const candidate = (overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate => ({
  path: '.agentic/knowledge/technical/a.md',
  layer: 'technical',
  status: 'active',
  confidence: 'confirmed',
  scope: null,
  paths: [],
  expires: null,
  tokens: 100,
  textRank: 0.5,
  ...overrides,
});

const input = (overrides: Partial<AssembleContextPackInput> = {}): AssembleContextPackInput => ({
  stage: 'implementation',
  budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
  tier0: [],
  candidates: [],
  touchedPaths: [],
  repoPaths: ['src/api/session.ts'],
  today: TODAY,
  kbCommit: null,
  ...overrides,
});

const tier0 = (path: string, tokens: number): Tier0Document => ({ path, tokens, reason: 'index' });

describe('the stage emphasis table is parameterised over the stage catalogue', () => {
  // Standing rule 68: a behaviour parameterised over a set gets a test parameterised over the same
  // set, asked of the source rather than transcribed. `BUILTIN_STAGE_IDS` is the source.
  it.each([...BUILTIN_STAGE_IDS])(
    '%s resolves an emphasis with a complete weight table',
    (stage) => {
      const emphasis = emphasisFor(stage);
      expect(Object.hasOwn(STAGE_EMPHASIS, stage)).toBe(true);
      const weights = EMPHASIS_LAYER_WEIGHTS[emphasis];
      for (const weight of Object.values(weights)) {
        expect(weight).toBeGreaterThan(0);
        expect(weight).toBeLessThanOrEqual(1);
      }
    },
  );

  it('covers exactly the builtin stages and nothing else', () => {
    expect(Object.keys(STAGE_EMPHASIS).sort()).toEqual([...BUILTIN_STAGE_IDS].sort());
  });

  it('falls back to the default emphasis for a custom stage and for a stageless run', () => {
    // The value is pinned, not compared with the constant: `toBe(DEFAULT_EMPHASIS)` alone is
    // satisfied by every possible default and so asserts nothing about which one ships (rule 10).
    expect(DEFAULT_EMPHASIS).toBe('technical');
    expect(emphasisFor('deploy_preview')).toBe('technical');
    expect(emphasisFor(null)).toBe('technical');
  });

  it('emphasises the layers product/05 names, per stage family', () => {
    expect(emphasisFor('refinement')).toBe('business');
    expect(emphasisFor('architecture')).toBe('technical');
    expect(emphasisFor('code_review')).toBe('technical');
    expect(emphasisFor('implementation')).toBe('implementation');
    expect(emphasisFor('retrospective')).toBe('history');
    expect(EMPHASIS_LAYER_WEIGHTS.business.business).toBeGreaterThan(
      EMPHASIS_LAYER_WEIGHTS.business.technical,
    );
    expect(EMPHASIS_LAYER_WEIGHTS.implementation.lessons).toBeGreaterThan(
      EMPHASIS_LAYER_WEIGHTS.implementation.business,
    );
  });
});

describe('scoreCandidate', () => {
  it('scores a path match at 1.0 and says which touched paths matched', () => {
    const scoring = scoreCandidate(candidate({ paths: ['src/api/**'], textRank: null }), {
      stage: 'implementation',
      touchedPaths: ['src/api/session.ts'],
      today: TODAY,
    });
    expect(scoring).toEqual({ score: 1, reason: 'paths', matchedPaths: ['src/api/session.ts'] });
  });

  it('returns null — not zero — for a candidate that neither matched a path nor the text query', () => {
    // "did not come back from the query" and "came back with rank 0" are different facts (rule 16).
    expect(
      scoreCandidate(candidate({ textRank: null }), {
        stage: 'implementation',
        touchedPaths: [],
        today: TODAY,
      }),
    ).toBeNull();
  });

  it('multiplies the text rank by the layer weight and the confidence weight', () => {
    const scoring = scoreCandidate(candidate({ layer: 'lessons', confidence: 'proposed' }), {
      stage: 'implementation',
      touchedPaths: [],
      today: TODAY,
    });
    // implementation × lessons = 1, proposed = 0.6 → 0.5 × 1 × 0.6
    expect(scoring?.score).toBeCloseTo(0.3, 10);
    expect(scoring?.reason).toBe('trigger');
  });

  it('demotes an expired document rather than dropping it', () => {
    const live = scoreCandidate(candidate({ expires: '2099-01-01' as IsoDate }), {
      stage: 'implementation',
      touchedPaths: [],
      today: TODAY,
    });
    const expired = scoreCandidate(candidate({ expires: '2025-01-01' as IsoDate }), {
      stage: 'implementation',
      touchedPaths: [],
      today: TODAY,
    });
    expect(expired).not.toBeNull();
    expect(expired?.score).toBeLessThan(live?.score ?? 0);
  });

  it('never leaves the unit interval, and the clamp is not what keeps it there', () => {
    const scoring = scoreCandidate(candidate({ layer: 'lessons', textRank: 1 }), {
      stage: 'implementation',
      touchedPaths: [],
      today: TODAY,
    });
    // The strongest possible combination — rank 1, weight 1, confirmed — lands exactly on 1 rather
    // than above it, so the clamp is defence in depth (rule 22: say so where it is unreachable).
    expect(scoring?.score).toBe(1);
  });
});

describe('validateAgainstHead — technical/07 step 3', () => {
  it('is true for a document that cites no paths', () => {
    expect(validateAgainstHead(candidate({ paths: [] }), [])).toBe(true);
  });

  it('is true when at least one cited glob still resolves', () => {
    expect(
      validateAgainstHead(candidate({ paths: ['src/legacy/**', 'src/api/**'] }), [
        'src/api/session.ts',
      ]),
    ).toBe(true);
  });

  it('is false when none of the cited globs resolve', () => {
    expect(
      validateAgainstHead(candidate({ paths: ['src/legacy/**'] }), ['src/api/session.ts']),
    ).toBe(false);
  });
});

describe('assembleContextPack — the filters, each naming its own branch', () => {
  it('drops a stage-scoped document for a different stage and records it as such', () => {
    const assembly = assembleContextPack(
      input({
        stage: 'implementation',
        candidates: [candidate({ path: 'scoped.md', scope: 'stage:architecture' })],
      }),
    );
    expect(assembly.droppedByScope).toEqual(['scoped.md']);
    expect(assembly.record.tier1).toEqual([]);
    expect(assembly.droppedAsDeprecated).toEqual([]);
  });

  it('admits a stage-scoped document for its own stage', () => {
    const assembly = assembleContextPack(
      input({
        stage: 'architecture',
        candidates: [candidate({ path: 'scoped.md', scope: 'stage:architecture' })],
      }),
    );
    expect(assembly.droppedByScope).toEqual([]);
    expect(assembly.record.tier1.map((entry) => entry.path)).toEqual(['scoped.md']);
  });

  it('drops a deprecated document and records it separately from a scope drop', () => {
    const assembly = assembleContextPack(
      input({ candidates: [candidate({ path: 'old.md', status: 'deprecated' })] }),
    );
    expect(assembly.droppedAsDeprecated).toEqual(['old.md']);
    expect(assembly.droppedByScope).toEqual([]);
    expect(assembly.documents).toEqual([]);
  });

  it('records a document that failed validate-on-read with validated: false and does not admit it', () => {
    const assembly = assembleContextPack(
      input({
        candidates: [candidate({ path: 'gone.md', paths: ['src/legacy/**'] })],
        repoPaths: ['src/api/session.ts'],
      }),
    );
    expect(assembly.droppedByValidation).toEqual(['gone.md']);
    expect(assembly.record.tier1).toEqual([
      {
        path: 'gone.md',
        reason: 'trigger',
        score: expect.any(Number),
        tokens: 100,
        validated: false,
      },
    ]);
    expect(assembly.documents.map((entry) => entry.path)).toEqual([]);
  });
});

describe('assembleContextPack — the budget fill', () => {
  it('orders tier 1 by descending score, breaking ties on path', () => {
    const assembly = assembleContextPack(
      input({
        candidates: [
          candidate({ path: 'b.md', textRank: 0.5 }),
          candidate({ path: 'a.md', textRank: 0.5 }),
          candidate({ path: 'c.md', textRank: 0.9 }),
        ],
      }),
    );
    expect(assembly.record.tier1.map((entry) => entry.path)).toEqual(['c.md', 'a.md', 'b.md']);
  });

  it('stops admitting once the budget is spent, and names what it could not afford', () => {
    const assembly = assembleContextPack(
      input({
        budgetTokens: 250,
        tier0: [tier0('index.md', 100)],
        candidates: [
          candidate({ path: 'a.md', tokens: 100, textRank: 0.9 }),
          candidate({ path: 'b.md', tokens: 100, textRank: 0.8 }),
          candidate({ path: 'c.md', tokens: 100, textRank: 0.7 }),
        ],
      }),
    );
    expect(assembly.outcome).toBe('within_budget');
    expect(assembly.record.total_tokens).toBe(200);
    expect(assembly.record.total_tokens).toBeLessThanOrEqual(250);
    expect(assembly.documents.map((entry) => entry.path)).toEqual(['index.md', 'a.md']);
    expect(assembly.droppedForBudget).toEqual(['b.md', 'c.md']);
    expect(assembly.droppedForCount).toEqual([]);
  });

  it('caps tier 1 at the product/05 ceiling even when the budget would allow more', () => {
    const many = Array.from({ length: MAX_TIER1_DOCUMENTS + 5 }, (_unused, index) =>
      candidate({ path: `doc-${String(index).padStart(2, '0')}.md`, tokens: 1, textRank: 0.5 }),
    );
    const assembly = assembleContextPack(input({ candidates: many }));
    expect(assembly.record.tier1.filter((entry) => entry.validated)).toHaveLength(
      MAX_TIER1_DOCUMENTS,
    );
    // The count ceiling, and **not** the budget: fifteen documents of one token each cannot
    // exhaust 12 000. Round 1 put both causes in one list, which is what made the acceptance
    // test's "the budget stopped the fill" warrant unsound.
    expect(assembly.droppedForCount).toHaveLength(5);
    expect(assembly.droppedForBudget).toEqual([]);
  });

  it('separates the three reasons a candidate is not admitted', () => {
    // One assembly, three causes, three lists — so that a test asserting one of them is asserting
    // the thing it names.
    const byCount = assembleContextPack(
      input({
        candidates: Array.from({ length: MAX_TIER1_DOCUMENTS + 2 }, (_u, index) =>
          candidate({ path: `count-${String(index)}.md`, tokens: 1, textRank: 0.9 }),
        ),
      }),
    );
    expect(byCount.droppedForCount).toHaveLength(2);
    expect(byCount.droppedForBudget).toEqual([]);

    const byBudget = assembleContextPack(
      input({
        budgetTokens: 150,
        candidates: [
          candidate({ path: 'fits.md', tokens: 100, textRank: 0.9 }),
          candidate({ path: 'does-not-fit.md', tokens: 100, textRank: 0.85 }),
        ],
      }),
    );
    expect(byBudget.droppedForBudget).toEqual(['does-not-fit.md']);
    expect(byBudget.droppedForCount).toEqual([]);

    // A weak text match is *not* a third cause: there is no relevance floor, and `retrieval.ts`
    // records the two measurements that rejected both shapes of one.
    const byFloor = assembleContextPack(
      input({
        candidates: [
          candidate({ path: 'strong.md', tokens: 1, textRank: 1 }),
          candidate({ path: 'weak.md', tokens: 1, textRank: 0.1 }),
        ],
      }),
    );
    expect(byFloor.record.tier1.map((entry) => entry.path)).toEqual(['strong.md', 'weak.md']);
    expect(byFloor.droppedForBudget).toEqual([]);
    expect(byFloor.droppedForCount).toEqual([]);
  });

  it('reports tier0_over_budget rather than dropping a tier-0 document or ignoring the budget', () => {
    const assembly = assembleContextPack(
      input({
        budgetTokens: 100,
        tier0: [tier0('index.md', 400)],
        candidates: [candidate({ path: 'a.md', tokens: 1, textRank: 0.9 })],
      }),
    );
    expect(assembly.outcome).toBe('tier0_over_budget');
    // "tier 0 always" holds — the document is still in the pack and in the record …
    expect(assembly.documents.map((entry) => entry.path)).toEqual(['index.md']);
    expect(assembly.record.tier0).toEqual([{ path: 'index.md', tokens: 400 }]);
    // … and the overrun is visible rather than absorbed.
    expect(assembly.record.total_tokens).toBe(400);
    expect(assembly.record.budget_tokens).toBe(100);
    expect(assembly.droppedForBudget).toEqual(['a.md']);
  });

  it('produces a record that satisfies the published contract', async () => {
    const { contextPackRecordSchema } = await import('@platform/contracts');
    const assembly = assembleContextPack(
      input({
        tier0: [tier0('index.md', 10)],
        candidates: [candidate({ path: 'a.md', paths: ['src/api/**'] })],
        touchedPaths: ['src/api/session.ts'],
        kbCommit: 'abc1234',
      }),
    );
    expect(contextPackRecordSchema.parse(assembly.record)).toEqual(assembly.record);
    expect(assembly.record.tier1[0]?.reason).toBe('paths');
    expect(assembly.record.tier1[0]?.score).toBe(1);
  });
});
