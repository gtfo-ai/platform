/**
 * Types for `os-artefacts.mjs`, which stays plain JavaScript because `check-ignored.mjs` runs as
 * `node scripts/check-ignored.mjs` in `verify` — with no TypeScript resolver loaded, and copied
 * into a throwaway fixture by its own test, where a resolver would have to be copied too.
 */
export declare const OS_ARTEFACT_NAMES: ReadonlySet<string>;
