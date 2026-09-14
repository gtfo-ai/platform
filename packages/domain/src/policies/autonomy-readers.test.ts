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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_POLICY_READERS,
  AUTONOMY_POLICY_WIRE_NAMES,
  AUTONOMY_PRESETS,
  type AutonomyPolicyReader,
} from './autonomy.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/** The module the table lives in: it declares every field, so a citation of it proves nothing. */
const TABLE_MODULE = 'packages/domain/src/policies/autonomy.ts';

/** A citation, in the shape the repository settled on after WP-24: a path from the root. */
const REPO_PATH = /(?:packages|apps|test|scripts)\/[\w./-]*\.tsx?/g;

const gitFiles = (args: readonly string[]): string[] =>
  execFileSync('git', [...args, '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file.length > 0);

/** Tracked *and* committable-but-untracked, which is the tree a pre-push hook sees (rule 85). */
const treeFiles = (): ReadonlySet<string> =>
  new Set([...gitFiles(['ls-files']), ...gitFiles(['ls-files', '--others', '--exclude-standard'])]);

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

const readSource = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

describe('the dial’s reader table (standing rule 18)', () => {
  it('has an entry for every policy, and no entry for anything else', () => {
    expect(Object.keys(AUTONOMY_POLICY_READERS).sort()).toEqual(
      Object.keys(AUTONOMY_PRESETS.supervised).sort(),
    );
    expect(Object.keys(AUTONOMY_POLICY_READERS)).toHaveLength(15);
  });

  it('splits into the five policies something reads and the ten it does not', () => {
    const byKind = (kind: 'read' | 'unread'): string[] =>
      Object.entries(AUTONOMY_POLICY_READERS)
        .filter(([, entry]) => entry.kind === kind)
        .map(([policy]) => policy)
        .sort();
    // The plan-approval gate's five. `suggestedReadinessMin` is **not** among them: the document it
    // travels in is published, and the *suggestion* the screen shows is `suggestedAutonomyCap` over
    // `projects.readiness_level` — a separate function that never reads this field.
    expect(byKind('read')).toEqual([
      'planApproval',
      'planApprovalForRiskClasses',
      'planApprovalSizeThreshold',
      'probation',
      'probationTasks',
    ]);
    expect(byKind('unread')).toHaveLength(10);
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
