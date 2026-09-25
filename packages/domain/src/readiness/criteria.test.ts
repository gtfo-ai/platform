/**
 * The readiness ladder, asserted the way standing rules 42 and 68 ask for.
 *
 * **68** — the level function branches over a *set* (the fourteen criteria and the four rungs), so
 * the tests are parameterised over the same set rather than over the two or three rungs somebody
 * remembered: every rung gets a case, and every criterion of every rung gets a case in which it is
 * the one that is missing. Deleting any single id from `READINESS_LEVEL_REQUIREMENTS` fails a named
 * case.
 *
 * **42** — each threshold is asserted from both sides: the exact passing set reaches the level, and
 * the same set minus one criterion does not.
 */
import { describe, expect, it } from 'vitest';
import {
  findReadinessCriterion,
  KNOWLEDGE_COMPLETENESS_SECTIONS,
  KNOWLEDGE_COMPLETENESS_THRESHOLD,
  knowledgeCompleteness,
  nextReadinessImprovements,
  READINESS_CRITERIA,
  READINESS_CRITERION_IDS,
  READINESS_LEVEL_REQUIREMENTS,
  readinessLevelFor,
} from './criteria.js';

/** Every criterion up to and including rung `level` (1-based, as product/17 numbers them). */
const passingSetFor = (level: number): Set<string> =>
  new Set(READINESS_LEVEL_REQUIREMENTS.slice(0, level).flat());

describe('the criteria table', () => {
  it('is product/17’s fourteen, numbered R1…R14 without a gap or a duplicate', () => {
    expect(READINESS_CRITERION_IDS).toEqual([
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
      'R6',
      'R7',
      'R8',
      'R9',
      'R10',
      'R11',
      'R12',
      'R13',
      'R14',
    ]);
    expect(new Set(READINESS_CRITERION_IDS).size).toBe(READINESS_CRITERIA.length);
  });

  it('names exactly three criteria the platform answers for itself', () => {
    // The split is load-bearing (see the module docblock): a model's claim about these three is
    // ignored, so a criterion moving between the two columns is a security-relevant change.
    expect(
      READINESS_CRITERIA.filter((criterion) => criterion.detectedBy === 'platform').map(
        (criterion) => criterion.id,
      ),
    ).toEqual(['R9', 'R11', 'R12']);
  });

  it('gives every criterion a non-empty “unlocks”, because the score is a value proposition', () => {
    // product/17: "Each criterion states what it unlocks so the score is a value proposition, not a
    // scolding." Asserted over the whole set rather than spot-checked (rule 68).
    for (const criterion of READINESS_CRITERIA) {
      expect(criterion.unlocks.length, criterion.id).toBeGreaterThan(0);
      expect(criterion.title.length, criterion.id).toBeGreaterThan(0);
      expect(criterion.detection.length, criterion.id).toBeGreaterThan(0);
    }
  });

  /**
   * WP-54 (Q69 (ii), PROGRESS backlog 49 criterion 4): R1, R2 and R6 are detected the way
   * product/17 words them — **run**, not read — because the discovery role's baseline now carries
   * the project's declared commands. From WP-21 to WP-54 all three read the CI configuration.
   */
  it('detects R1, R2 and R6 by running the project’s commands, as product/17 words them', () => {
    const detection = (id: string) =>
      READINESS_CRITERIA.find((criterion) => criterion.id === id)?.detection ?? '';
    // product/17:15, verbatim.
    expect(detection('R1')).toBe(
      'test command found in how-to-run.md/CI config and executed in the workspace',
    );
    // product/17:16 is one word, "measured"; the line says what is measured.
    expect(detection('R2')).toMatch(/^measured: /);
    // product/17:20, with the one residual named: a run has no Docker.
    expect(detection('R6')).toContain('executed in the workspace');
    expect(detection('R6')).toContain('a run has no Docker');
    for (const id of ['R1', 'R2', 'R6']) {
      expect(detection(id), id).not.toMatch(/CI timeout|a documented duration/);
    }
  });

  it('uses every criterion in exactly one rung of the ladder', () => {
    const used = READINESS_LEVEL_REQUIREMENTS.flat();
    expect([...used].sort()).toEqual([...READINESS_CRITERION_IDS].sort());
    expect(new Set(used).size).toBe(used.length);
  });

  it('finds a criterion by id and reports an unknown one as absent', () => {
    expect(findReadinessCriterion('R9')?.detectedBy).toBe('platform');
    expect(findReadinessCriterion('R99')).toBeUndefined();
  });
});

describe('readinessLevelFor', () => {
  it('is 0 for a repository that has proved nothing', () => {
    expect(readinessLevelFor(new Set())).toBe(0);
  });

  it('is 4 when everything passes, and never higher', () => {
    expect(readinessLevelFor(new Set(READINESS_CRITERION_IDS))).toBe(4);
  });

  // Both sides of every threshold (rule 42), parameterised over every rung (rule 68).
  for (const [index, requirement] of READINESS_LEVEL_REQUIREMENTS.entries()) {
    const level = index + 1;
    it(`reaches level ${level} on exactly the criteria the rung requires`, () => {
      expect(readinessLevelFor(passingSetFor(level))).toBe(level);
    });

    for (const missing of requirement) {
      it(`stops at level ${level - 1} when ${missing} is the only one missing`, () => {
        const passed = passingSetFor(level);
        passed.delete(missing);
        expect(readinessLevelFor(passed)).toBe(level - 1);
      });
    }
  }

  it('does not let a higher rung compensate for a lower one', () => {
    // R1 and R3 missing, everything else passing: the ladder is cumulative, so this is level 0 and
    // not level 3. Without the `return` in the walk it would be 0 anyway — this case is here for
    // the *reading*, which the docblock states and which a reviewer would otherwise have to infer.
    const passed = new Set(READINESS_CRITERION_IDS);
    passed.delete('R1');
    passed.delete('R3');
    expect(readinessLevelFor(passed)).toBe(0);
  });
});

describe('nextReadinessImprovements', () => {
  it('names the failing criteria of the next rung first', () => {
    const passed = new Set(['R1']);
    expect(nextReadinessImprovements(passed).map((criterion) => criterion.id)).toEqual([
      'R3',
      'R2',
      'R4',
    ]);
  });

  it('still returns three when the next rung is nearly complete', () => {
    const passed = new Set(['R1', 'R3', 'R2', 'R4', 'R5']);
    expect(nextReadinessImprovements(passed).map((criterion) => criterion.id)).toEqual([
      'R9',
      'R6',
      'R8',
    ]);
  });

  it('returns nothing at all when everything passes', () => {
    expect(nextReadinessImprovements(new Set(READINESS_CRITERION_IDS))).toEqual([]);
  });
});

describe('knowledgeCompleteness', () => {
  const paths = KNOWLEDGE_COMPLETENESS_SECTIONS.map((section) => section.path);

  it('is 0 for an empty vault and 1 for one with every section', () => {
    expect(knowledgeCompleteness([])).toBe(0);
    expect(knowledgeCompleteness(paths)).toBe(1);
  });

  it('crosses R12’s threshold at seven of the ten sections, and not at six', () => {
    // Both sides (rule 42): 7/10 ≥ 0.7 and 6/10 < 0.7. The threshold is the *criterion*, so a
    // change to either the section list or the constant has to move this case.
    expect(knowledgeCompleteness(paths.slice(0, 7))).toBeGreaterThanOrEqual(
      KNOWLEDGE_COMPLETENESS_THRESHOLD,
    );
    expect(knowledgeCompleteness(paths.slice(0, 6))).toBeLessThan(KNOWLEDGE_COMPLETENESS_THRESHOLD);
  });

  it('ignores a page that is not one of the sections', () => {
    expect(knowledgeCompleteness(['lessons/L-2026-01-01-thing.md', 'index.md'])).toBe(0);
  });

  it('compares paths exactly, so a differently-cased page is a different page', () => {
    // The index stores the repository's own path; folding case here would make the score depend on
    // the filesystem the vault was committed from (standing rule 26).
    expect(knowledgeCompleteness(['Business/Overview.md'])).toBe(0);
  });
});
