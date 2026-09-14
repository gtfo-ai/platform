/**
 * product/19 §14's risk classes, from the paths a plan declares (WP-30).
 *
 * Asserted from both sides throughout (standing rule 42): a matcher that answered "every class" and
 * one that answered "no class" would each pass half of this file and fail the other.
 */
import type { RiskClass } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { riskClassesForPaths, riskClassesRequiringPlanApproval } from './risk-classes.js';

const CLASSES: Readonly<Record<string, RiskClass>> = {
  auth: { paths: ['src/auth/**'], require: ['plan_approval'] },
  payments: { paths: ['src/pay/**', 'billing/'], require: ['plan_approval', 'reviewer:@finance'] },
  // A class that matches and asks for something this build does not enforce.
  infra: { paths: ['infra/**'], require: ['reviewer:@ops'] },
};

describe('riskClassesForPaths', () => {
  it('names the classes a set of paths falls into, in declaration order', () => {
    expect(riskClassesForPaths(CLASSES, ['src/pay/checkout.ts', 'src/auth/session.ts'])).toEqual([
      'auth',
      'payments',
    ]);
  });

  it('names none for paths no class covers, and none for a project with no classes', () => {
    expect(riskClassesForPaths(CLASSES, ['docs/readme.md'])).toEqual([]);
    expect(riskClassesForPaths(undefined, ['src/auth/session.ts'])).toEqual([]);
    expect(riskClassesForPaths(CLASSES, [])).toEqual([]);
  });

  it('reads a directory pattern the way an operator writes one', () => {
    // `billing/` covers the directory and everything under it — `pathPatternToRegExp`'s contract,
    // asserted here because this is the first caller that writes a bare directory in a fixture.
    expect(riskClassesForPaths(CLASSES, ['billing/invoice.ts'])).toEqual(['payments']);
    expect(riskClassesForPaths(CLASSES, ['billings/invoice.ts'])).toEqual([]);
  });
});

describe('riskClassesRequiringPlanApproval', () => {
  it('keeps only the classes whose requirement this build enforces', () => {
    // `infra` matches and asks for a named reviewer, which nothing in this build does — so it is
    // **not** returned. A function that returned "the classes that matched" would read as if all
    // three requirements were acted on, which is the claim `risk-classes.ts` refuses to make.
    expect(riskClassesRequiringPlanApproval(CLASSES, ['infra/main.tf'])).toEqual([]);
    expect(riskClassesForPaths(CLASSES, ['infra/main.tf'])).toEqual(['infra']);
    expect(riskClassesRequiringPlanApproval(CLASSES, ['src/auth/session.ts'])).toEqual(['auth']);
    expect(
      riskClassesRequiringPlanApproval(CLASSES, ['src/pay/checkout.ts', 'infra/main.tf']),
    ).toEqual(['payments']);
  });
});
