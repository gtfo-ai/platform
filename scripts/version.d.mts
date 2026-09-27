/** Types for `version.mjs` (plain JavaScript for the reason `changelog.d.mts` gives). */
import type { ParsedCommit } from './changelog.mjs';

export type Bump = 'major' | 'minor' | 'patch';

export interface NextVersion {
  readonly version: string | null;
  readonly bump: Bump | null;
  readonly reason: string;
}

export declare const releaseBump: (commits: readonly ParsedCommit[]) => Bump | null;
export declare const bumpVersion: (version: string, bump: Bump) => string;
export declare const nextVersion: (input: {
  previousTag: string | null;
  commits: readonly ParsedCommit[];
  firstVersion?: string;
}) => NextVersion;
export declare const nextVersionOf: (
  root?: string,
) => NextVersion & { readonly previousTag: string | null };
