/**
 * Types for `os-artefacts.mjs`, which stays plain JavaScript because `check-ignored.mjs` runs as
 * `node scripts/check-ignored.mjs` in `verify` — with no TypeScript resolver loaded, and copied
 * into a throwaway fixture by its own test, where a resolver would have to be copied too.
 */
export declare const OS_ARTEFACT_NAMES: ReadonlySet<string>;

/** Root-anchored paths the local tools write; an entry ending in `/` is a directory. */
export declare const LOCAL_TOOL_PATHS: ReadonlySet<string>;

export declare function isLocalToolPath(path: string): boolean;
