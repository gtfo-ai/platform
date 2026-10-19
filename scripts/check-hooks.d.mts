/** Types for `check-hooks.mjs`, which stays plain JavaScript because `verify:static` runs it. */

import type { Environment } from './git-scratch-env.mjs';

export declare const IGNORED_PATHS: readonly string[];

export interface OutsidePath {
  readonly line: number;
  readonly path: string;
}

export declare function outsidePaths(
  text: string,
  roots: readonly string[],
  excluded?: readonly string[],
): OutsidePath[];

export declare function readHooks(
  hooksDir: string,
): { readonly name: string; readonly text: string }[];

export declare function hookLocations(
  cwd: string,
  env?: Environment,
): { readonly hooksDir: string; readonly roots: string[]; readonly excluded: string[] };

export declare function checkHooks(
  cwd: string,
  env?: Environment,
): {
  readonly hooksDir: string;
  readonly roots: string[];
  readonly excluded: string[];
  readonly hooks: string[];
  readonly findings: (OutsidePath & { readonly hook: string })[];
};
