/**
 * **Which build this bundle is, and whether the server is still it** (WP-154 (d), PROGRESS backlog
 * 487).
 *
 * An open tab keeps the bundle it loaded, and that bundle's response schemas are strict (an unknown
 * key is an error, CLAUDE.md). So after the server is upgraded, an old tab refuses the new server's
 * answers with *"the server's answer to … did not match the published schema"* — which reads as a
 * server fault when a reload is the whole fix. The bundle therefore carries the commit it was built
 * from, and the SPA compares it with the server's `GET /api/version` `commit`.
 *
 * **Where the commit comes from.** The image build's existing value: `image.yml`'s `meta` step
 * writes `GITHUB_SHA` as `APP_COMMIT`, `scripts/build-images.mjs` passes it as a build argument,
 * `docker/app.Dockerfile` declares it in the `web` stage (for the bundle) and in the final stage
 * (for the server's `/api/version`), and `vite.config.ts` compiles it in as
 * {@link BUILD_COMMIT_GLOBAL} through {@link bundleCommitFrom}. One value, two readers, so the two
 * are equal exactly when the bundle and the server came from one build. A checkout's build has
 * none and is {@link DEV_BUILD}.
 *
 * **When it says "updated".** Only when the two differ **and** neither is `dev` or null
 * ({@link isDifferentBuild}): a developer's bundle against a developer's server has nothing to
 * compare, and a real contract defect between one build's bundle and its own server must stay
 * visible as the schema error it is.
 */

/** The global `vite.config.ts` defines — a string literal in the bundle, absent everywhere else. */
export const BUILD_COMMIT_GLOBAL = '__PLATFORM_BUILD_COMMIT__';

/** What a bundle built with no commit (a checkout, the test tiers) calls itself. */
export const DEV_BUILD = 'dev';

/** The build's commit as the bundle records it: the trimmed value, or {@link DEV_BUILD}. */
export const bundleCommitFrom = (value: string | undefined): string => {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? DEV_BUILD : trimmed;
};

declare const __PLATFORM_BUILD_COMMIT__: string | undefined;

/**
 * This bundle's commit. `typeof` rather than a bare read, because outside a Vite build (the test
 * tiers, `vite.config.ts` itself importing this module) the global is not defined at all.
 */
export const BUNDLE_COMMIT: string =
  typeof __PLATFORM_BUILD_COMMIT__ === 'string'
    ? bundleCommitFrom(__PLATFORM_BUILD_COMMIT__)
    : DEV_BUILD;

/** Is the server a different build from this bundle — both known, and not equal? */
export const isDifferentBuild = (bundle: string, server: string | null): boolean =>
  bundle !== DEV_BUILD && server !== null && server !== DEV_BUILD && server !== bundle;
