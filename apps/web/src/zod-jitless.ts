/**
 * zod's JIT compilation, turned off before any schema in this bundle is built (WP-15j round 3).
 *
 * zod 4 compiles a schema with `new Function` and decides whether it may by probing `Function("")`
 * once. The bundle is served under `script-src 'self'` (`apps/server/src/web/csp.ts`), so the probe
 * is refused: zod falls back to its interpreted path and everything works, but the browser reports
 * a `securitypolicyviolation` for it — and a violation channel that always has an entry in it is a
 * channel nobody reads.
 *
 * **It is a module of its own, imported first by `main.tsx`, because the decision is memoised.**
 * Measured in Chromium at round 3: the same call at the top of `main.tsx`'s *body* was too late —
 * every module it imports, including the schemas of `@platform/contracts`, has already run by
 * then, and the probe had already happened. A module's imports are evaluated in source order, so
 * the only thing that runs before the schemas is an import placed above them.
 */
import { z } from 'zod';

z.config({ jitless: true });
