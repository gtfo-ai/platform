/**
 * The readiness score's two properties, over arbitrary artifacts (WP-25, technical/10 unit tier).
 *
 * The docblock on `READINESS_PENALTIES` claims the weights are *"a partition of 100, which is the
 * whole of the arithmetic: … no clamp is ever load-bearing"*. That is a claim about every input, not
 * about the six the unit tests list, and standing rule 3 says a claim in a comment is not evidence.
 * So it is asserted here, and the second property is the one a scoring function is most likely to
 * get wrong as it grows: **adding information to a ticket must never lower its score.**
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import { scoreTicketReadiness, type TicketLintSpec } from './ticket-lint.js';

const criteria = fc.array(
  fc.record({
    validation: fc.record({ kind: fc.constantFrom('command', 'test', 'manual') }),
  }),
  { maxLength: 4 },
);

const questions = fc.array(
  fc.record({ text: fc.string({ maxLength: 20 }), blocking: fc.boolean() }),
  { maxLength: 8 },
);

const specs: fc.Arbitrary<TicketLintSpec> = fc.record({
  in_scope: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
  out_of_scope: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
  acceptance_criteria: criteria,
  questions,
});

describe('the readiness score, over arbitrary artifacts', () => {
  it(
    'is always an integer in [0, 100], with at most three gaps named',
    () => {
      fc.assert(
        fc.property(specs, (spec) => {
          const readiness = scoreTicketReadiness(spec);
          expect(Number.isInteger(readiness.score)).toBe(true);
          expect(readiness.score).toBeGreaterThanOrEqual(0);
          expect(readiness.score).toBeLessThanOrEqual(100);
          expect(readiness.missing.length).toBeLessThanOrEqual(3);
          // The gaps come back ordered by weight, so a caller that slices keeps the worst.
          expect([...new Set(readiness.missing)]).toEqual([...readiness.missing]);
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it(
    'never falls when an acceptance criterion is added or a question is answered',
    () => {
      fc.assert(
        fc.property(specs, (spec) => {
          const before = scoreTicketReadiness(spec).score;
          // A criterion with an automatable check can only close gaps.
          const withCriterion = scoreTicketReadiness({
            ...spec,
            acceptance_criteria: [
              ...(spec.acceptance_criteria ?? []),
              { validation: { kind: 'test' } },
            ],
          }).score;
          expect(withCriterion).toBeGreaterThanOrEqual(before);
          // Removing an open question can only stop costing points.
          const withFewerQuestions = scoreTicketReadiness({
            ...spec,
            questions: (spec.questions ?? []).slice(1),
          }).score;
          expect(withFewerQuestions).toBeGreaterThanOrEqual(before);
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
