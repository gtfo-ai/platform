/**
 * Use cases, event handlers, sagas and ports.
 *
 * Ports are interfaces only: the ring may depend on `@platform/domain` and `@platform/contracts`
 * and on nothing else (technical/01 dependency rule, enforced by `biome.json`).
 */
export * from './ports/jobs.js';
export * from './scheduling/working-calendar.js';
export * from './scheduling/zoned-time.js';

export const packageId = '@platform/application' as const;
