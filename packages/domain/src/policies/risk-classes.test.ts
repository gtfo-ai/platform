/**
 * product/19 §14's risk classes, from the paths a plan declares (WP-30).
 *
 * Asserted from both sides throughout (standing rule 42): a matcher that answered "every class" and
 * one that answered "no class" would each pass half of this file and fail the other.
 */
import type { RiskClass } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { PLATFORM_DEFAULT_CONFIG } from '../config/effective-config.js';
import {
  PROPOSED_RISK_CLASSES,
  RISK_CLASS_REQUIREMENTS_AWAITING_CHECKLIST,
  reviewersRequiredByClasses,
  riskClassesForPaths,
  riskClassesRequiringPlanApproval,
} from './risk-classes.js';

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
  it('keeps only the classes whose requirement is a plan approval', () => {
    // `infra` matches and asks for a **named reviewer**, which is a different consumer (WP-37's
    // reviewer routing) — so it is not returned here. A function that returned "the classes that
    // matched" would read as if every match were a gate.
    expect(riskClassesRequiringPlanApproval(CLASSES, ['infra/main.tf'])).toEqual([]);
    expect(riskClassesForPaths(CLASSES, ['infra/main.tf'])).toEqual(['infra']);
    expect(riskClassesRequiringPlanApproval(CLASSES, ['src/auth/session.ts'])).toEqual(['auth']);
    expect(
      riskClassesRequiringPlanApproval(CLASSES, ['src/pay/checkout.ts', 'infra/main.tf']),
    ).toEqual(['payments']);
  });
});

describe('reviewersRequiredByClasses', () => {
  it('collects the handles the matched classes ask for, without the prefix', () => {
    expect(reviewersRequiredByClasses(CLASSES, ['payments', 'infra'])).toEqual([
      '@finance',
      '@ops',
    ]);
  });

  it('is driven by the class names it is given, not by the paths', () => {
    // The caller has already matched and stored them (`tasks.risk_classes`); matching twice is how
    // the label on the row and the people on the merge request come to disagree.
    expect(reviewersRequiredByClasses(CLASSES, [])).toEqual([]);
    expect(reviewersRequiredByClasses(CLASSES, ['auth'])).toEqual([]);
    expect(reviewersRequiredByClasses(CLASSES, ['not-a-class'])).toEqual([]);
    expect(reviewersRequiredByClasses(undefined, ['payments'])).toEqual([]);
  });

  it('names a handle once however many classes asked for it', () => {
    const twice: Readonly<Record<string, RiskClass>> = {
      a: { paths: ['a/**'], require: ['reviewer:@security'] },
      b: { paths: ['b/**'], require: ['reviewer:@security'] },
    };
    expect(reviewersRequiredByClasses(twice, ['a', 'b'])).toEqual(['@security']);
  });
});

describe('the platform’s proposal (product/19 §14, WP-37)', () => {
  it('is **not** in the shipped defaults, so no existing project is gated by a deploy', () => {
    // Criterion 1, the half that is easiest to break by accident: `policies.risk_classes` stays
    // absent, and the six classes reach a project only through an acceptance somebody made.
    expect(PLATFORM_DEFAULT_CONFIG.policies).not.toHaveProperty('risk_classes');
    expect(Object.keys(PROPOSED_RISK_CLASSES).length).toBeGreaterThan(0);
  });

  it('proposes only requirements this build acts on', () => {
    for (const [name, declared] of Object.entries(PROPOSED_RISK_CLASSES)) {
      expect(declared.paths.length, name).toBeGreaterThan(0);
      for (const requirement of declared.require) {
        expect(
          requirement === 'plan_approval' || requirement.startsWith('reviewer:'),
          `${name} requires ${requirement}`,
        ).toBe(true);
      }
    }
  });

  it('classifies a migration as `data` and a doc change as nothing (standing rule 42)', () => {
    expect(riskClassesForPaths(PROPOSED_RISK_CLASSES, ['db/migrations/0001_init.sql'])).toEqual([
      'data',
    ]);
    expect(riskClassesForPaths(PROPOSED_RISK_CLASSES, ['docs/readme.md'])).toEqual([]);
  });

  it('names the row it cannot propose, with its reason and its paths', () => {
    // Data rather than prose, because the settings screen renders it: product/19 §14's sixth class
    // has only a checklist requirement, and `checklist:` is refused until Q83 is answered.
    const names = RISK_CLASS_REQUIREMENTS_AWAITING_CHECKLIST.map((entry) => entry.name);
    expect(names).toEqual(['public_api']);
    expect(Object.keys(PROPOSED_RISK_CLASSES)).not.toContain('public_api');
    for (const entry of RISK_CLASS_REQUIREMENTS_AWAITING_CHECKLIST) {
      expect(entry.paths.length).toBeGreaterThan(0);
      expect(entry.reason).toContain('Q83');
    }
  });
});
