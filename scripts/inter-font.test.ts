/**
 * `apps/web/vite-plugins/inter-font.mjs` (S-23.13a, BACKLOG 801 and 803): the Vite plugin that
 * ships Inter's OFL-1.1 text beside the bundle and preloads the hashed woff2. Driven through its hooks
 * with a stand-in bundle; the built bundle itself is the browser tier's (`test/web-e2e/csp.spec.ts`
 * fetches the licence and reads the preload under the production policy). The test lives here
 * because no vitest project collects `apps/web/vite-plugins/`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  INTER_LICENCE_ASSET,
  INTER_PACKAGE,
  interFontPlugin,
  interPreloadTag,
  interWoff2Of,
} from '../apps/web/vite-plugins/inter-font.mjs';

const WOFF2 = 'assets/inter-latin-wght-normal-Dx4kXJAl.woff2';
const licenceText = readFileSync(
  createRequire(new URL('../apps/web/package.json', import.meta.url)).resolve(
    `${INTER_PACKAGE}/LICENSE`,
  ),
  'utf8',
);

describe('the Inter preload', () => {
  it('names the one Inter woff2 of the bundle, and refuses none or two rather than guessing', () => {
    expect(interWoff2Of(['assets/index-a1.js', WOFF2, 'assets/index-b2.css'])).toBe(WOFF2);
    expect(() => interWoff2Of(['assets/index-a1.js'])).toThrow(/exactly one Inter woff2.*found 0/);
    expect(() => interWoff2Of([WOFF2, 'assets/inter-latin-wght-normal-Zz9.woff2'])).toThrow(
      /found 2: /,
    );
    // Another face of the family is not the one `styles.css` declares.
    expect(() => interWoff2Of(['assets/inter-latin-ext-wght-normal-x1.woff2'])).toThrow(/found 0/);
  });

  it('is a same-origin font preload in CORS mode, under the build’s base', () => {
    expect(interPreloadTag(WOFF2)).toEqual({
      tag: 'link',
      attrs: {
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        href: `/${WOFF2}`,
        crossorigin: '',
      },
      injectTo: 'head',
    });
    expect(interPreloadTag(WOFF2, '/ui/').attrs.href).toBe(`/ui/${WOFF2}`);
  });
});

describe('the plugin', () => {
  it('emits the package’s own OFL text at the bundle’s root and writes the preload into index.html', () => {
    const plugin = interFontPlugin({ licenceText });
    expect(plugin.apply).toBe('build');
    const emitted: { type: string; fileName: string; source: string }[] = [];
    plugin.generateBundle.call({
      emitFile: (file) => {
        emitted.push(file);
        return file.fileName;
      },
    });
    expect(emitted).toEqual([
      { type: 'asset', fileName: INTER_LICENCE_ASSET, source: licenceText },
    ]);
    expect(INTER_LICENCE_ASSET).toBe('inter-OFL.txt');
    expect(licenceText).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(licenceText).toContain('Copyright 2016 The Inter Project Authors');

    plugin.configResolved({ base: '/' });
    expect(plugin.transformIndexHtml.order).toBe('post');
    expect(
      plugin.transformIndexHtml.handler('<html></html>', { bundle: { [WOFF2]: {}, 'x.js': {} } }),
    ).toEqual([interPreloadTag(WOFF2)]);
    // The dev server has no bundle: nothing is preloaded there, and nothing is refused.
    expect(plugin.transformIndexHtml.handler('<html></html>', {})).toEqual([]);
  });

  it('refuses a licence text that is not the OFL-1.1 it claims to ship', () => {
    expect(() => interFontPlugin({ licenceText: 'MIT License' })).toThrow(/not the OFL-1.1 text/);
  });
});
