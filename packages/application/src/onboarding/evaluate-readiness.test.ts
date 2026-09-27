/**
 * The readiness fold — WP-21.
 *
 * The file is `evaluate-readiness.test.ts` rather than `readiness.test.ts` because
 * `scripts/citations.test.ts` resolves a cited test by **file name** across the whole checkout, and
 * `apps/server/src/readiness.test.ts` (the `/readyz` report) already owns that one: a second file
 * with the name turns every existing citation to it into "ambiguous file name". The guard found it
 * the first time this file was tracked.
 *
 * The three rules `readiness.ts` states are each asserted as a *behaviour*, not as a comment:
 *
 *  - a model claim about R9, R11 or R12 is dropped, including the hostile case where the artifact
 *    asserts the opposite of what the platform measured (standing rule 3: mutation-check the guard
 *    — removing the `agentAnswerable` filter makes that case fail by name);
 *  - `unlocks` comes from `READINESS_CRITERIA` for every criterion, agent-detected included;
 *  - an unanswered criterion is `false`, and an id outside the table never reaches the row.
 *
 * Both sides of every bound (rule 42): the cap keeps a string exactly at the limit and cuts the one
 * a character past it; a redaction happens before the cut, asserted with a secret planted across
 * the boundary.
 */
import type { Id } from '@platform/contracts';
import { READINESS_CRITERIA, READINESS_CRITERION_IDS } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor, noSecretsRedactor } from '../integrations/redaction.js';
import {
  CARRIED_EVIDENCE_PREFIX,
  evaluateReadiness,
  MAX_READINESS_EVIDENCE_CHARS,
  type ReadinessObservations,
  recheckReadiness,
} from './evaluate-readiness.js';
import type { PlatformReadinessSignals, ReadinessEvaluation } from './ports.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1' as Id;
const EVALUATION = '00000000-0000-4000-8000-0000000000d2' as Id;
const AT = '2026-09-13T04:00:00.000Z' as never;

/** Obviously fake, planted so the redaction assertion has something to look for (rule 45). */
const PLANTED_SECRET = 'FAKE-discovery-credential-not-a-real-secret';

const SECTIONS = [
  'business/overview.md',
  'business/personas.md',
  'business/rules.md',
  'business/glossary.md',
  'business/direction.md',
  'business/quality-bar.md',
  'business/review-expectations.md',
  'technical/overview.md',
  'technical/how-to-run.md',
  'technical/conventions.md',
];

const signals = (overrides: Partial<PlatformReadinessSignals> = {}): PlatformReadinessSignals => ({
  defaultBranchProtected: null,
  boundIntegrationTypes: [],
  indexedKnowledgePaths: [],
  ...overrides,
});

const evaluate = (input: {
  readonly claims?: { id: string; passed: boolean; evidence: string }[];
  readonly signals?: Partial<PlatformReadinessSignals>;
  readonly secrets?: boolean;
}) =>
  evaluateReadiness({
    id: EVALUATION,
    projectId: PROJECT,
    evaluatedAt: AT,
    source: 'discovery',
    agentClaims: input.claims,
    signals: signals(input.signals),
    redactor:
      input.secrets === true
        ? exactSecretRedactor([{ name: 'discovery_key', value: PLANTED_SECRET }])
        : noSecretsRedactor(),
  });

const criterion = (result: ReturnType<typeof evaluate>, id: string) =>
  result.evaluation.criteria.find((entry) => entry.id === id);

describe('evaluateReadiness', () => {
  it('writes a row for every criterion in the table, in the table’s order', () => {
    const { evaluation } = evaluate({});
    expect(evaluation.criteria.map((entry) => entry.id)).toEqual(READINESS_CRITERION_IDS);
    expect(evaluation.projectId).toBe(PROJECT);
    expect(evaluation.evaluatedAt).toBe(AT);
    expect(evaluation.source).toBe('discovery');
  });

  it('fails every criterion nobody answered, and says so rather than inventing evidence', () => {
    const { evaluation } = evaluate({});
    expect(evaluation.level).toBe(0);
    expect(evaluation.criteria.every((entry) => !entry.passed)).toBe(true);
    expect(criterion(evaluate({}), 'R1')?.evidence).toContain('did not report');
  });

  it('takes the agent’s answer for an agent-detected criterion', () => {
    const result = evaluate({
      claims: [
        { id: 'R1', passed: true, evidence: 'ran `pnpm test`: 42 passed' },
        { id: 'R3', passed: true, evidence: '.github/workflows/ci.yml triggers on pull_request' },
      ],
    });
    expect(criterion(result, 'R1')?.passed).toBe(true);
    expect(criterion(result, 'R1')?.evidence).toBe('ran `pnpm test`: 42 passed');
    expect(result.evaluation.level).toBe(1);
  });

  it('drops a model claim about a platform-detected criterion, even one that contradicts it', () => {
    // The hostile case: the repository says R9 passes and the git provider says it does not. This
    // is the assertion that fails if the `agentAnswerable` filter is removed (standing rule 3).
    const result = evaluate({
      claims: [
        { id: 'R9', passed: true, evidence: 'trust me, the branch is protected' },
        { id: 'R11', passed: true, evidence: 'we have Sentry, honestly' },
        { id: 'R12', passed: true, evidence: 'the knowledge base is complete' },
      ],
      signals: {
        defaultBranchProtected: false,
        boundIntegrationTypes: [],
        indexedKnowledgePaths: [],
      },
    });
    for (const id of ['R9', 'R11', 'R12']) {
      expect(criterion(result, id)?.passed, id).toBe(false);
      expect(criterion(result, id)?.detectedBy, id).toBe('platform');
    }
    expect(criterion(result, 'R9')?.evidence).toBe(
      'the git provider reports the default branch as unprotected',
    );
    expect(criterion(result, 'R9')?.evidence).not.toContain('trust me');
  });

  it('passes the platform criteria when the platform’s own signals say so', () => {
    // The other side of the case above (rule 42): the guard must not be "always false".
    const result = evaluate({
      signals: {
        defaultBranchProtected: true,
        boundIntegrationTypes: ['errors', 'logs'],
        indexedKnowledgePaths: SECTIONS,
      },
    });
    expect(criterion(result, 'R9')?.passed).toBe(true);
    expect(criterion(result, 'R11')?.passed).toBe(true);
    expect(criterion(result, 'R12')?.passed).toBe(true);
    expect(criterion(result, 'R12')?.evidence).toContain('100%');
  });

  it('tells “could not ask” apart from “unprotected” for R9', () => {
    // Standing rule 18: an absent answer that silently becomes a permissive — or here, a
    // *definitive* — one is the defect. `null` fails the criterion and the evidence says why.
    const result = evaluate({ signals: { defaultBranchProtected: null } });
    expect(criterion(result, 'R9')?.passed).toBe(false);
    expect(criterion(result, 'R9')?.evidence).toContain('could not ask');
  });

  it('reports R12 as unknown when the project has never been indexed', () => {
    const result = evaluate({ signals: { indexedKnowledgePaths: null } });
    expect(criterion(result, 'R12')?.passed).toBe(false);
    expect(criterion(result, 'R12')?.evidence).toContain('has not been indexed');
  });

  it('copies `unlocks` from the platform’s table for every criterion', () => {
    const result = evaluate({
      claims: [{ id: 'R1', passed: true, evidence: 'green' }],
    });
    for (const entry of result.evaluation.criteria) {
      const table = READINESS_CRITERIA.find((c) => c.id === entry.id);
      expect(entry.unlocks, entry.id).toBe(table?.unlocks);
      expect(entry.detectedBy, entry.id).toBe(table?.detectedBy);
    }
  });

  it('ignores an id that is not in product/17’s table', () => {
    const result = evaluate({ claims: [{ id: 'R99', passed: true, evidence: 'made up' }] });
    expect(result.evaluation.criteria.map((entry) => entry.id)).toEqual(READINESS_CRITERION_IDS);
  });

  it('keeps the first of two claims for one criterion', () => {
    const result = evaluate({
      claims: [
        { id: 'R1', passed: true, evidence: 'first' },
        { id: 'R1', passed: false, evidence: 'second' },
      ],
    });
    expect(criterion(result, 'R1')?.evidence).toBe('first');
  });

  it('caps evidence at the budget, and keeps a string exactly at it', () => {
    const exact = 'x'.repeat(MAX_READINESS_EVIDENCE_CHARS);
    expect(
      criterion(evaluate({ claims: [{ id: 'R1', passed: true, evidence: exact }] }), 'R1')
        ?.evidence,
    ).toBe(exact);
    const over = 'x'.repeat(MAX_READINESS_EVIDENCE_CHARS + 1);
    const cut = criterion(
      evaluate({ claims: [{ id: 'R1', passed: true, evidence: over }] }),
      'R1',
    )?.evidence;
    expect(cut).toHaveLength(MAX_READINESS_EVIDENCE_CHARS + 1);
    expect(cut?.endsWith('…')).toBe(true);
  });

  it('redacts before it cuts, so a secret straddling the cap cannot survive halved', () => {
    // The order matters and is the one `ticket-snapshot.ts` states: an exact-match redactor cannot
    // find a secret a cut has already halved. The secret is planted to straddle the boundary.
    const prefix = 'a'.repeat(MAX_READINESS_EVIDENCE_CHARS - 10);
    const result = evaluate({
      claims: [{ id: 'R1', passed: true, evidence: `${prefix}${PLANTED_SECRET} trailing` }],
      secrets: true,
    });
    const evidence = criterion(result, 'R1')?.evidence ?? '';
    expect(evidence).not.toContain(PLANTED_SECRET);
    expect(evidence).not.toContain(PLANTED_SECRET.slice(0, 12));
    expect(evidence).toContain('[REDACTED');
    expect(result.redactions).toBe(1);
  });

  it('does not redact platform-written evidence, because no untrusted byte is in it', () => {
    const result = evaluate({ signals: { defaultBranchProtected: true }, secrets: true });
    expect(result.redactions).toBe(0);
    expect(criterion(result, 'R9')?.evidence).not.toContain('[REDACTED');
  });
});

// ── The re-check after a merge (WP-64) ───────────────────────────────────────

describe('recheckReadiness', () => {
  const LATER = '2026-09-20T04:00:00.000Z' as never;
  /**
   * A discovery evaluation that claimed **everything**, R9 and R12 included — the hostile shape for
   * criterion 5: a re-check must not inherit the model's word for a platform criterion.
   */
  const everythingClaimed = (): ReadinessEvaluation =>
    evaluate({
      claims: READINESS_CRITERION_IDS.map((id) => ({
        id,
        passed: true,
        evidence: `the model says ${id} passes`,
      })),
      signals: { defaultBranchProtected: true, indexedKnowledgePaths: SECTIONS },
    }).evaluation;
  const nothingObserved: ReadinessObservations = {
    agentInstructions: null,
    mergeRequestPipelines: null,
  };
  const recheck = (input: {
    readonly previous?: ReadinessEvaluation;
    readonly signals?: Partial<PlatformReadinessSignals>;
    readonly observations?: Partial<ReadinessObservations>;
  }) =>
    recheckReadiness({
      id: EVALUATION,
      projectId: PROJECT,
      evaluatedAt: LATER,
      previous: input.previous ?? everythingClaimed(),
      signals: signals(input.signals),
      observations: { ...nothingObserved, ...input.observations },
    });
  const row = (evaluation: ReadinessEvaluation, id: string) =>
    evaluation.criteria.find((criterion) => criterion.id === id);

  it('is written as a recheck, with a level of its own', () => {
    const evaluation = recheck({});
    expect(evaluation.source).toBe('recheck');
    expect(evaluation.evaluatedAt).toBe(LATER);
    expect(evaluation.criteria.map((criterion) => criterion.id)).toEqual([
      ...READINESS_CRITERION_IDS,
    ]);
  });

  it('asks the platform again for R9, R11 and R12 and never carries them (criterion 5)', () => {
    // The previous evaluation passed all three; the platform now says otherwise, and wins.
    const evaluation = recheck({
      signals: { defaultBranchProtected: false, indexedKnowledgePaths: SECTIONS.slice(0, 3) },
    });
    expect(row(evaluation, 'R9')?.passed).toBe(false);
    expect(row(evaluation, 'R11')?.passed).toBe(false);
    expect(row(evaluation, 'R12')?.passed).toBe(false);
    expect(row(evaluation, 'R12')?.evidence).toContain('knowledge completeness is 30%');
    for (const id of ['R9', 'R11', 'R12']) {
      expect(row(evaluation, id)?.evidence, id).not.toContain('the model says');
      expect(row(evaluation, id)?.evidence, id).not.toContain(CARRIED_EVIDENCE_PREFIX);
    }
    // …and the other direction: what the platform now observes passes (rule 42).
    const passing = recheck({
      previous: evaluate({}).evaluation,
      signals: {
        defaultBranchProtected: true,
        boundIntegrationTypes: ['errors'],
        indexedKnowledgePaths: SECTIONS,
      },
    });
    expect(['R9', 'R11', 'R12'].map((id) => row(passing, id)?.passed)).toEqual([true, true, true]);
  });

  it('answers R8 from the files in both directions, and carries it when they could not be read', () => {
    const gained = recheck({
      previous: evaluate({}).evaluation,
      observations: {
        agentInstructions: { passed: true, evidence: 'CLAUDE.md has 12 lines and links' },
      },
    });
    expect(row(gained, 'R8')).toMatchObject({
      passed: true,
      evidence: 'CLAUDE.md has 12 lines and links',
    });
    // Who answered it: the platform's file read, not the model that answered it at discovery.
    expect(row(gained, 'R8')?.detectedBy).toBe('platform');
    expect(row(recheck({}), 'R8')?.detectedBy).toBe('agent');
    const lost = recheck({
      observations: { agentInstructions: { passed: false, evidence: 'CLAUDE.md is absent' } },
    });
    expect(row(lost, 'R8')?.passed).toBe(false);
    const unread = recheck({});
    expect(row(unread, 'R8')?.passed).toBe(true);
    expect(row(unread, 'R8')?.evidence.startsWith(CARRIED_EVIDENCE_PREFIX)).toBe(true);
  });

  it('passes R3 on an observed event and carries it otherwise — never fails it on silence', () => {
    const observed = recheck({
      previous: evaluate({}).evaluation,
      observations: { mergeRequestPipelines: { passed: true, evidence: 'observed 2' } },
    });
    expect(row(observed, 'R3')).toMatchObject({ passed: true, evidence: 'observed 2' });
    // …and a later re-check that observes nothing carries it with who answered it.
    const carriedObserved = recheck({ previous: observed });
    expect(row(carriedObserved, 'R3')).toMatchObject({ passed: true, detectedBy: 'platform' });
    expect(row(carriedObserved, 'R3')?.evidence).toContain('carried from the recheck evaluation');
    const silent = recheck({});
    expect(row(silent, 'R3')?.passed).toBe(true);
    expect(row(silent, 'R3')?.detectedBy).toBe('agent');
    expect(row(silent, 'R3')?.evidence).toContain('the model says R3 passes');
  });

  it('carries the nine it cannot answer, saying from where and why', () => {
    const evaluation = recheck({});
    const carried = READINESS_CRITERIA.filter((criterion) => criterion.recheck === 'carried');
    expect(carried).toHaveLength(9);
    for (const criterion of carried) {
      const stored = row(evaluation, criterion.id);
      expect(stored?.passed, criterion.id).toBe(true);
      expect(stored?.evidence, criterion.id).toBe(
        `${CARRIED_EVIDENCE_PREFIX}discovery evaluation of ${AT} (not re-checked after a merge: ${criterion.recheckReason}): the model says ${criterion.id} passes`,
      );
    }
  });

  it('does not stack a second prefix on evidence a previous re-check already carried', () => {
    const first = recheck({});
    const second = recheckReadiness({
      id: EVALUATION,
      projectId: PROJECT,
      evaluatedAt: '2026-09-27T04:00:00.000Z' as never,
      previous: first,
      signals: signals(),
      observations: nothingObserved,
    });
    expect(row(second, 'R1')?.evidence).toBe(row(first, 'R1')?.evidence);
    expect(row(second, 'R1')?.evidence).toContain('discovery evaluation of');
  });

  it('keeps carried evidence inside the per-criterion cap', () => {
    const long = evaluate({
      claims: [{ id: 'R1', passed: true, evidence: 'x'.repeat(MAX_READINESS_EVIDENCE_CHARS) }],
    }).evaluation;
    const evidence = row(recheck({ previous: long }), 'R1')?.evidence ?? '';
    expect(evidence.length).toBe(MAX_READINESS_EVIDENCE_CHARS + 1);
    expect(evidence.endsWith('…')).toBe(true);
  });

  it('fails a criterion the previous evaluation had no row for', () => {
    const partial: ReadinessEvaluation = {
      ...evaluate({}).evaluation,
      criteria: [],
    };
    const evaluation = recheck({ previous: partial });
    expect(row(evaluation, 'R1')?.passed).toBe(false);
    expect(row(evaluation, 'R1')?.evidence).toContain('did not report');
  });

  it('moves the level when the repository gains the missing criterion', () => {
    // Level 2 everywhere except R8; the file read then finds it.
    const claims = READINESS_CRITERION_IDS.filter((id) => id !== 'R8').map((id) => ({
      id,
      passed: true,
      evidence: `${id} ok`,
    }));
    const platform = { defaultBranchProtected: true, indexedKnowledgePaths: SECTIONS };
    const before = evaluate({ claims, signals: platform }).evaluation;
    expect(before.level).toBe(2);
    const after = recheck({
      previous: before,
      signals: platform,
      observations: { agentInstructions: { passed: true, evidence: 'CLAUDE.md links' } },
    });
    expect(after.level).toBe(3);
  });
});
