/** Types for `semver.mjs` (plain JavaScript for the reason `changelog.d.mts` gives). */

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export declare const FIRST_VERSION: string;
export declare const parseVersion: (text: string) => Version | null;
export declare const tagVersion: (tag: string) => string | null;
export declare const compareVersions: (a: string, b: string) => number;
export declare const latestReleaseTag: (tags: readonly string[]) => string | null;
export declare const releaseTags: (root: string) => string[];
