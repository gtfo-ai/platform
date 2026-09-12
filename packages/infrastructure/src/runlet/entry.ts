/**
 * The bundle entry of `agentic-runlet` — the *only* surface `apps/runlet` imports (WP-22).
 *
 * ## Why this file exists rather than `./index.js`
 *
 * TD-025 §1 says the shim is "a small static shim … compiled to a single file … must have no
 * runtime deps", and until WP-22 the entrypoint imported the package **root**
 * (`import { runlet, runner } from '@platform/infrastructure'`). That barrel re-exports every
 * adapter the platform has, so the run container's shim process loaded `pg`, `pg-boss`,
 * `drizzle-orm` and the Agent SDK — and, through `runlet/testing.js`, **`vitest` and
 * `fast-check`** — none of which it uses and all of which TD-021 says do not belong in a run
 * container ("no platform code"). It worked only because the repository was bind-mounted at
 * `/repo` with a full `node_modules` beside it, which is the arrangement technical/05 forbids and
 * which this work package removes.
 *
 * A bundler cannot fix that by tree-shaking alone: `testing.ts` imports `vitest` at module scope,
 * so the bundle has to *resolve* a devDependency to decide it is unused. The fix is a narrower
 * entry, and the narrowness is the point — five names, and a new import here is a deliberate act
 * rather than a re-export somebody added three packages away.
 *
 * Exposed as the `@platform/infrastructure/runlet` subpath so `apps/runlet` still imports by
 * package name (the dependency rule, technical/01) and never by a relative path.
 */
export { systemClock } from '../runner/clock.js';
export { readRunletConfig } from './config.js';
export { runCredentialHelper } from './credential-helper.js';
export { createRunletLogger } from './logger.js';
export { createRunletShim } from './shim.js';
