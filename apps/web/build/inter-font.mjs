/**
 * The SPA's one font, Inter Variable (TD-033 § 3), as the build ships it — two obligations the
 * bundle had not met (S-23.13a, BACKLOG 801 and 803):
 *
 * - **Its licence travels with it.** `@fontsource-variable/inter` is OFL-1.1, whose condition 2
 *   requires the copyright notice and the licence to be distributed with every copy of the Font
 *   Software. The bundle carries the woff2, so it now carries the package's own `LICENSE` beside
 *   it, as {@link INTER_LICENCE_ASSET} at the root of `dist/` — which `apps/server` serves and the
 *   image copies whole. It is at the root rather than under `assets/` on purpose: everything under
 *   `assets/` is served `immutable` for a year because Vite content-hashes it
 *   (`apps/server/src/web/bundle.ts`), and this file's name is fixed so `THIRD_PARTY_NOTICES.md`
 *   can name it (`scripts/notices.mjs` imports the name from here).
 * - **It is preloaded.** research/19 § 4.2 says the font is preloaded; without it a first visit
 *   paints in the system stack and swaps. The woff2's name is a content hash Vite chooses, so the
 *   `<link rel="preload">` is written by a hook that reads the bundle: exactly one Inter woff2 is
 *   expected, and a build with none or several is refused rather than preloading a guess. Same
 *   origin, so the production policy's `font-src 'self'` is unchanged; `crossorigin` is required on
 *   a font preload even then (fonts are fetched in CORS mode, and a preload without it is a second
 *   request).
 *
 * **It lives in `apps/web/`**, beside the config that loads it, because the image's `web` stage
 * (`docker/app.Dockerfile`) copies `apps/web` and `packages/contracts` and nothing else — a config
 * importing from `scripts/` does not load there (review of PR #31). Plain JavaScript because
 * `scripts/notices.mjs` imports its file name and runs as `node scripts/notices.mjs` with no
 * TypeScript resolver loaded; `apps/web/vite.config.ts` builds the plugin.
 */

/** The npm package the font comes from. */
export const INTER_PACKAGE = '@fontsource-variable/inter';

/** The licence's file name at the root of the built bundle. */
export const INTER_LICENCE_ASSET = 'inter-OFL.txt';

/** The one woff2 `apps/web/src/styles.css` declares, once Vite has hashed it into `assets/`. */
const INTER_WOFF2 = /^assets\/inter-latin-wght-normal-[\w-]+\.woff2$/;

/** The bundle's Inter woff2, refusing a bundle with none or with more than one. */
export const interWoff2Of = (fileNames) => {
  const found = [...fileNames].filter((name) => INTER_WOFF2.test(name));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one Inter woff2 in the bundle to preload, found ${found.length}${found.length === 0 ? '' : `: ${found.join(', ')}`}`,
    );
  }
  return found[0];
};

/** The `<link rel="preload">` for the font at `fileName`, as Vite's tag descriptor. */
export const interPreloadTag = (fileName, base = '/') => ({
  tag: 'link',
  attrs: {
    rel: 'preload',
    as: 'font',
    type: 'font/woff2',
    href: `${base}${fileName}`,
    crossorigin: '',
  },
  injectTo: 'head',
});

/** The Vite plugin: the licence beside the bundle and the preload in `index.html` (build only). */
export const interFontPlugin = ({ licenceText }) => {
  if (!/SIL OPEN FONT LICENSE Version 1\.1/.test(licenceText)) {
    throw new Error(`${INTER_PACKAGE}'s LICENSE is not the OFL-1.1 text this build ships`);
  }
  let base = '/';
  return {
    name: 'platform-inter-font',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: INTER_LICENCE_ASSET, source: licenceText });
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        if (context.bundle === undefined) {
          return [];
        }
        return [interPreloadTag(interWoff2Of(Object.keys(context.bundle)), base)];
      },
    },
  };
};
