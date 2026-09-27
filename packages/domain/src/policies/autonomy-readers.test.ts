/**
 * `AUTONOMY_POLICY_READERS`, resolved against the tree instead of read (WP-30, review round 2).
 *
 * ## Why this file exists
 *
 * The table shipped naming a reader that is not on disk — `suggestedReadinessMin` cited
 * `routes/autonomy.ts`, a file no work package has written — while its own docblock and
 * `packages/domain/src/policies/autonomy.test.ts` both said the values were *"asserted against a
 * grep of the tree"*. The assertion was `entry.by.length > 0`. That is standing rule **3** (an
 * invariant asserted in a comment is not evidence it holds) sitting inside the fix for standing
 * rule 18, and standing rule **44**: a claim about the tree is only worth what the check behind it
 * enforces. So the grep is written, and the entry that was wrong is a permanent case below rather
 * than a correction nobody can see.
 *
 * ## What a `kind: 'read'` entry must survive
 *
 * 1. It names at least one **repository path** — `packages/…`, `apps/…`, `test/…` or `scripts/…`
 *    ending in `.ts`/`.tsx`. A bare file name is not enough, which WP-24's citation round earned:
 *    two files in this repository are called `review-only.test.ts`.
 * 2. Every path it names is a file **git knows about**: tracked, or untracked and committable
 *    (standing rule 85 — a census blind to an uncommitted file is green locally and red on push).
 * 3. At least one of those files mentions the policy, by its `AutonomyPreset` key or by its wire
 *    name, as a whole word.
 * 4. And that file is **not** `packages/domain/src/policies/autonomy.ts`. The module that holds the
 *    table also declares the field, so citing it would satisfy (3) for every entry and say nothing.
 *
 * ## What it cannot check, stated here rather than discovered later
 *
 * Whether the cited module *acts* on the value — no grep can, which is the same limit
 * `scripts/citations.ts` states about a cited test name. And it cannot police the other direction:
 * an `unread` entry that claims nothing reads a policy something does read. A mechanical version of
 * that check is impossible here because `UNMATERIALISED_PLAN_APPROVAL`
 * (`packages/application/src/pipeline/saga.ts`) is a whole-preset literal that mentions all fifteen
 * keys, so *"unread implies unmentioned"* would fail on every entry in the table. What guards that
 * direction instead is the exact `read`/`unread` split asserted below: moving an entry into `read`
 * requires a citation that resolves, and moving one out changes a list somebody has to edit.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import {
  AUTONOMY_POLICIES_NOT_OVERRIDABLE,
  AUTONOMY_POLICY_OVERRIDE_KEYS,
  AUTONOMY_POLICY_READERS,
  AUTONOMY_POLICY_WIRE_NAMES,
  AUTONOMY_PRESETS,
  type AutonomyOverrideSource,
  type AutonomyPolicyReader,
  autonomyOverridesFromConfig,
} from './autonomy.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/** The module the table lives in: it declares every field, so a citation of it proves nothing. */
const TABLE_MODULE = 'packages/domain/src/policies/autonomy.ts';

/** A citation, in the shape the repository settled on after WP-24: a path from the root. */
const REPO_PATH = /(?:packages|apps|test|scripts)\/[\w./-]*\.tsx?/g;

/** Tracked *and* committable-but-untracked, which is the tree a pre-push hook sees (rule 85). */
const treeFiles = (): ReadonlySet<string> => new Set(censusPaths(REPO_ROOT));

const mentions = (body: string, policy: string): boolean => {
  const wire = AUTONOMY_POLICY_WIRE_NAMES[policy as keyof typeof AUTONOMY_POLICY_WIRE_NAMES];
  return new RegExp(`\\b(?:${policy}|${wire})\\b`).test(body);
};

/**
 * Every `read` entry whose citation does not resolve, as a sentence naming the policy and the
 * reason — a list, not a boolean, so a failure says which entry and what is wrong with it.
 *
 * The table and the file reader are **parameters** so that the negative cases below can run the
 * real check over a deliberately wrong table. Mutating the shipped one in place would be standing
 * rule 77's trap: the mutant that never lands leaves the suite green and reads as coverage.
 */
export const unresolvedReaderCitations = (
  table: Readonly<Record<string, AutonomyPolicyReader>>,
  tree: ReadonlySet<string>,
  read: (file: string) => string,
): readonly string[] => {
  const problems: string[] = [];
  for (const [policy, entry] of Object.entries(table)) {
    if (entry.kind !== 'read') {
      continue;
    }
    const cited = [...new Set(entry.by.match(REPO_PATH) ?? [])].filter(
      (file) => file !== TABLE_MODULE,
    );
    if (cited.length === 0) {
      problems.push(`${policy}: names no repository path outside ${TABLE_MODULE}`);
      continue;
    }
    const missing = cited.filter((file) => !tree.has(file));
    if (missing.length > 0) {
      problems.push(`${policy}: cites ${missing.join(', ')}, which git does not know about`);
      continue;
    }
    if (!cited.some((file) => mentions(read(file), policy))) {
      problems.push(`${policy}: no cited file mentions it — ${cited.join(', ')}`);
    }
  }
  return problems.sort();
};

const readSource = (file: string): string => censusText(REPO_ROOT, file);

describe('the dial’s reader table (standing rule 18)', () => {
  it('has an entry for every policy, and no entry for anything else', () => {
    expect(Object.keys(AUTONOMY_POLICY_READERS).sort()).toEqual(
      Object.keys(AUTONOMY_PRESETS.supervised).sort(),
    );
    expect(Object.keys(AUTONOMY_POLICY_READERS)).toHaveLength(15);
  });

  it('splits into the thirteen policies something reads and the two it does not', () => {
    const byKind = (kind: 'read' | 'unread'): string[] =>
      Object.entries(AUTONOMY_POLICY_READERS)
        .filter(([, entry]) => entry.kind === kind)
        .map(([policy]) => policy)
        .sort();
    // The plan-approval gate's five, the budget gate's one (WP-28), WP-34's two (intake asks
    // `picksUpNewTickets`, the shadow batch command asks `shadowMode`) and **WP-62's five**: the
    // three backlog 72 (a) called a second spelling of a document key (`humanMrRounds`,
    // `questionTimeout`, `knowledgeAutoApply` — each now read where the document is silent) and the
    // two 72 (b) called a halt the compiled pipeline could not express (`businessReview`,
    // `stopAfterStage` — frozen onto the task and read by `compilePipeline`/`interpret`).
    // This list **is** the recurrence guard the entry asked for.
    expect(byKind('read')).toEqual([
      'budgetApprovalThresholdUsd',
      'businessReview',
      'humanMrRounds',
      'knowledgeAutoApply',
      'picksUpNewTickets',
      'planApproval',
      'planApprovalForRiskClasses',
      'planApprovalSizeThreshold',
      'probation',
      'probationTasks',
      'questionTimeout',
      'shadowMode',
      'stopAfterStage',
    ]);
    // Both decided rather than deferred, which is why neither names a work package: the opt-in key
    // wins over `reviewOnly` (BD-028), and `suggestedAutonomyCap` is the one encoding of the ladder.
    expect(byKind('unread')).toEqual(['reviewOnly', 'suggestedReadinessMin']);
    for (const policy of byKind('unread')) {
      const entry = AUTONOMY_POLICY_READERS[policy as keyof typeof AUTONOMY_POLICY_READERS];
      expect(entry.kind === 'unread' && entry.owner, policy).not.toBe('none');
    }
  });

  it('never leaves an absence unexplained', () => {
    for (const [policy, entry] of Object.entries(AUTONOMY_POLICY_READERS)) {
      if (entry.kind === 'unread') {
        expect(entry.owner.length, policy).toBeGreaterThan(0);
        expect(entry.why.length, policy).toBeGreaterThan(20);
      } else {
        expect(entry.by.length, policy).toBeGreaterThan(0);
      }
    }
  });
});

describe('the citation behind every claimed reader', () => {
  it('resolves to a file git knows about that names the policy', () => {
    expect(unresolvedReaderCitations(AUTONOMY_POLICY_READERS, treeFiles(), readSource)).toEqual([]);
  });

  it('reads a tree that includes untracked sources, so a new reader is visible (rule 85)', () => {
    const tree = treeFiles();
    expect(tree.has('packages/application/src/pipeline/saga.ts')).toBe(true);
    expect(tree.has('packages/domain/src/policies/autonomy-readers.test.ts')).toBe(true);
  });

  /**
   * The canary, and the first thing that was run: the entry as it **shipped** in round 1.
   *
   * `routes/autonomy.ts` is not a path from the repository root and there is no such file anywhere,
   * so the check that was promised would have refused it on the day it was written. Keeping the
   * literal here means the defect is recorded where it recurs rather than only in the ledger.
   */
  it('refuses the entry that shipped claiming a reader nobody wrote', () => {
    const asShipped = {
      ...AUTONOMY_POLICY_READERS,
      suggestedReadinessMin: {
        kind: 'read',
        by: "routes/autonomy.ts — published so the dial can say which readiness level a position expects (product/19 §11's last row)",
      },
    } as const;
    expect(unresolvedReaderCitations(asShipped, treeFiles(), readSource)).toEqual([
      `suggestedReadinessMin: names no repository path outside ${TABLE_MODULE}`,
    ]);
  });

  it('refuses a path that no longer exists, which is what a rename leaves behind', () => {
    const renamed = {
      ...AUTONOMY_POLICY_READERS,
      probation: {
        kind: 'read',
        by: 'packages/application/src/pipeline/saga-gates.ts planApprovalGate',
      },
    } as const;
    expect(unresolvedReaderCitations(renamed, treeFiles(), readSource)).toEqual([
      'probation: cites packages/application/src/pipeline/saga-gates.ts, which git does not know about',
    ]);
  });

  it('refuses a real file that does not mention the policy, which is what a stale entry is', () => {
    const stale = {
      ...AUTONOMY_POLICY_READERS,
      probationTasks: { kind: 'read', by: 'apps/server/src/app.ts composes the routes' },
    } as const;
    expect(unresolvedReaderCitations(stale, treeFiles(), readSource)).toEqual([
      'probationTasks: no cited file mentions it — apps/server/src/app.ts',
    ]);
  });

  it('refuses the table’s own module, because it declares every field', () => {
    const circular = {
      ...AUTONOMY_POLICY_READERS,
      planApproval: { kind: 'read', by: `${TABLE_MODULE} defines it` },
    } as const;
    expect(unresolvedReaderCitations(circular, treeFiles(), readSource)).toEqual([
      `planApproval: names no repository path outside ${TABLE_MODULE}`,
    ]);
  });
});

/**
 * Q78's rule — *"widen to exactly the fields that have a reader, and make that the rule rather than
 * a snapshot"* (WP-62).
 *
 * Three assertions make it a rule. The override surface is a subset of the `read` policies (a key
 * for a policy nothing reads is backlog 58's unread-key class); every `read` policy is either
 * overridable or says why not, and never both; and the declared document keys are **driven**
 * through `autonomyOverridesFromConfig` rather than trusted, so a key declared here that the
 * function does not honour — or one it honours that is not declared — fails by name.
 */
describe('the override surface (Q78)', () => {
  const readPolicies = (): string[] =>
    Object.entries(AUTONOMY_POLICY_READERS)
      .filter(([, entry]) => entry.kind === 'read')
      .map(([policy]) => policy)
      .sort();

  /** One value per declared document key — a new key must bring one, or the next case fails. */
  const SAMPLE_VALUES: Readonly<Record<string, unknown>> = {
    'policies.probation_tasks': 2,
    'pipeline.limits.human_rounds': 7,
    'pipeline.limits.question_timeout': '2 working days',
    'policies.knowledge_apply.auto_apply': true,
  };

  const documentSetting = (dotted: string, value: unknown): AutonomyOverrideSource => {
    const root: Record<string, unknown> = {};
    const parts = dotted.split('.');
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      const next: Record<string, unknown> = {};
      cursor[part] = next;
      cursor = next;
    }
    cursor[parts[parts.length - 1] as string] = value;
    return root as AutonomyOverrideSource;
  };

  it('offers an override only for a policy something reads', () => {
    for (const policy of Object.keys(AUTONOMY_POLICY_OVERRIDE_KEYS)) {
      expect(
        AUTONOMY_POLICY_READERS[policy as keyof typeof AUTONOMY_POLICY_READERS].kind,
        policy,
      ).toBe('read');
    }
  });

  it('partitions the read policies into overridable and not, each with its key or its reason', () => {
    const overridable = Object.keys(AUTONOMY_POLICY_OVERRIDE_KEYS);
    const refused = Object.keys(AUTONOMY_POLICIES_NOT_OVERRIDABLE);
    expect(overridable.filter((policy) => refused.includes(policy))).toEqual([]);
    expect([...overridable, ...refused].sort()).toEqual(readPolicies());
    for (const [policy, why] of Object.entries(AUTONOMY_POLICIES_NOT_OVERRIDABLE)) {
      expect(why.length, policy).toBeGreaterThan(40);
    }
    // Today's answer, stated once so a reader need not derive it: the three document keys backlog
    // 72 (a) named plus `probation_tasks` (which also carries `probation`).
    expect([...new Set(Object.values(AUTONOMY_POLICY_OVERRIDE_KEYS))].sort()).toEqual([
      'pipeline.limits.human_rounds',
      'pipeline.limits.question_timeout',
      'policies.knowledge_apply.auto_apply',
      'policies.probation_tasks',
    ]);
  });

  it('honours every declared key, and nothing it does not declare', () => {
    const keys = [...new Set(Object.values(AUTONOMY_POLICY_OVERRIDE_KEYS))];
    expect(Object.keys(SAMPLE_VALUES).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      const declared = Object.entries(AUTONOMY_POLICY_OVERRIDE_KEYS)
        .filter(([, path]) => path === key)
        .map(([policy]) => policy)
        .sort();
      const overridden = Object.keys(
        autonomyOverridesFromConfig(documentSetting(key, SAMPLE_VALUES[key])),
      ).sort();
      expect(overridden, key).toEqual(declared);
    }
    expect(autonomyOverridesFromConfig({})).toEqual({});
    expect(autonomyOverridesFromConfig(undefined)).toEqual({});
  });

  it('carries the document value itself, not a coerced one', () => {
    expect(
      autonomyOverridesFromConfig({
        pipeline: { limits: { human_rounds: 2, question_timeout: '3 working days' } },
        policies: { knowledge_apply: { auto_apply: false }, probation_tasks: 0 },
      }),
    ).toEqual({
      humanMrRounds: 2,
      questionTimeout: '3 working days',
      knowledgeAutoApply: false,
      probationTasks: 0,
      probation: false,
    });
  });
});
