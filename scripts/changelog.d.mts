/**
 * Types for `changelog.mjs`, which stays plain JavaScript for the reason every script in this
 * directory does: `release.yml` runs it as `node scripts/changelog.mjs --upgrade-note` on a runner
 * that has checked out the repository and installed nothing (the `notices.d.mts` precedent).
 *
 * The shapes are what `scripts/changelog.test.ts` drives, so a rename or an argument change is a
 * compile error rather than a surprise on the one run that matters.
 */

export interface ChangelogSection {
  readonly type: string;
  readonly section: string;
  readonly hidden: boolean;
}

export interface ParsedCommit {
  readonly sha: string;
  readonly type: string;
  readonly scope: string | null;
  readonly subject: string;
  readonly breaking: boolean;
}

export interface MigrationVerdict {
  readonly required: boolean;
  readonly added: readonly string[];
  readonly shippedCount: number;
  readonly previousTag: string | null;
}

export interface ModelMeasurement {
  readonly missing: readonly string[];
  readonly measured: boolean;
}

export declare const CHANGELOG_SECTIONS: readonly ChangelogSection[];
export declare const BREAKING_SECTION: string;

export declare const parseCommit: (input: {
  sha: string;
  subject: string;
  body?: string;
}) => ParsedCommit | null;

export declare const readCommits: (
  range: string | null,
  root?: string,
) => { commits: ParsedCommit[]; unparsed: number; total: number };

export declare const groupBySection: (commits: readonly ParsedCommit[]) => {
  breaking: ParsedCommit[];
  sections: Map<string, ParsedCommit[]>;
};

export declare const repositoryUrl: (
  env?: Record<string, string | undefined>,
  root?: string,
) => string;

export declare const shippedMigrations: (root?: string) => string[];
export declare const previousReleaseTag: (root?: string) => string | null;

export declare const migrationVerdict: (input: {
  shipped: readonly string[];
  previous: readonly string[];
  previousTag: string | null;
}) => MigrationVerdict;

export declare const modelMeasurement: (root?: string) => ModelMeasurement;

export declare const upgradeNote: (input: {
  verdict: MigrationVerdict;
  measurement: ModelMeasurement;
}) => string;

export declare const renderChangelog: (input: {
  version: string;
  date: string;
  commits: readonly ParsedCommit[];
  unparsed: number;
  url: string;
  note: string;
  generatedAt: string;
}) => string;

export declare const configuredVersion: (root?: string) => string;

export interface ExitCriterion {
  /** A substring of product/14 § "MVP exit criteria", quoted in the release notes. */
  readonly quote: string;
  readonly status: string;
  readonly note: string;
}

export declare const MVP_EXIT_CRITERIA: readonly ExitCriterion[];
export declare const exitCriteriaNote: (criteria?: readonly ExitCriterion[]) => string;
