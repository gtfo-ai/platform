/**
 * Types for `verify-shards.mjs`, which stays plain JavaScript because `verify.mjs` runs it with no
 * TypeScript resolver loaded.
 */
export declare const BOUNDED_VITEST: string;

export declare const BLOB_DIRECTORY: string;

export type VerifyMode =
  | { readonly kind: 'whole' }
  | { readonly kind: 'shard'; readonly index: number; readonly count: number }
  | { readonly kind: 'merge'; readonly dir: string };

export declare const parseVerifyMode: (args: readonly string[]) => VerifyMode;

export declare const shardableStep: (
  target: string,
  steps: readonly string[],
  scripts: Readonly<Record<string, string>>,
) => string;

export declare const shardArgs: (index: number, count: number) => string[];

export declare const blobName: (index: number, count: number) => string;

export declare const blobSetProblem: (
  entries: readonly string[] | null,
  dir: string,
) => string | null;
