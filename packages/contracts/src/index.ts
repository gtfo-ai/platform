/**
 * `@platform/contracts` — the zod schemas every ring and the UI share.
 *
 * This package is **leaf-level** (technical/01): it must not import from any other `@platform/*`
 * package. Its only runtime dependency is zod.
 *
 * Conventions in force here:
 *  - The wire format is snake_case (config YAML, event payloads, artifact data, API DTOs,
 *    transcript rows), matching technical/02, /03, /08 and /12; exported identifiers are camelCase.
 *  - Object schemas are **strict**: an unknown key is an error, never silently dropped
 *    (technical/12). The only exceptions are records whose keys are user-chosen — stage ids,
 *    template names, risk-class names, status mappings, and opaque provider payloads — where an
 *    unexpected key is the payload rather than a mistake.
 *  - No `.default()` and no `.transform()` on published schemas, so a schema's input and output
 *    types are identical and the generated JSON Schema is unambiguous. (`z.coerce` appears only in
 *    query-string DTOs, which are not published as JSON Schema.)
 *  - Types are always inferred with `z.infer`; nothing is declared twice.
 */
export * from './api.js';
export * from './artifacts.js';
export * from './common.js';
export * from './config.js';
export * from './events.js';
export * from './pipeline.js';
export * from './records.js';
export * from './runlet.js';
export * from './schemas.js';
export * from './transcript.js';

export const packageId = '@platform/contracts' as const;
