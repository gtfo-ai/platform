/**
 * Types for `census-files.mjs`, which stays plain JavaScript because `check-nul.mjs` and
 * `check-conflict.mjs` run it in `verify` with no TypeScript resolver loaded.
 */
export interface CensusOptions {
  /** git pathspecs narrowing both the tracked and the untracked half. */
  readonly pathspecs?: readonly string[];
  readonly include?: (path: string) => boolean;
}

export interface CensusUnreadable {
  readonly path: string;
  readonly reason: string;
}

export interface CensusFile<C> {
  readonly path: string;
  readonly contents: C;
}

export interface CensusRead<C> {
  readonly files: readonly CensusFile<C>[];
  readonly vanished: readonly string[];
  readonly unreadable: readonly CensusUnreadable[];
}

export declare function censusPaths(root: string, options?: CensusOptions): string[];

export declare function readCensus(
  root: string,
  paths: readonly string[],
  options: { readonly encoding: null },
): CensusRead<Buffer>;
export declare function readCensus(
  root: string,
  paths: readonly string[],
  options?: { readonly encoding?: 'utf8' },
): CensusRead<string>;

export declare class CensusUnreadableError extends Error {
  readonly unreadable: readonly CensusUnreadable[];
  constructor(unreadable: readonly CensusUnreadable[]);
}

export declare function censusFiles(
  root: string,
  options?: CensusOptions,
): readonly CensusFile<string>[];

export declare function censusText(root: string, path: string): string;
