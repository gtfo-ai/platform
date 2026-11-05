/**
 * Types for `inter-font.mjs`, which stays plain JavaScript because `notices.mjs` imports it and
 * runs as `node scripts/notices.mjs` with no TypeScript resolver loaded.
 *
 * The plugin's shape is declared structurally rather than imported from `vite`: `vite` is
 * `apps/web`'s dependency, not the root's, and `scripts/inter-font.test.ts` and
 * `scripts/notices.mjs` are type-checked from the root. Vite checks the object it is handed where
 * `apps/web/vite.config.ts` hands it over.
 */
export interface InterPreloadTag {
  readonly tag: 'link';
  readonly attrs: {
    readonly rel: 'preload';
    readonly as: 'font';
    readonly type: 'font/woff2';
    readonly href: string;
    readonly crossorigin: '';
  };
  readonly injectTo: 'head';
}

export interface InterFontPlugin {
  readonly name: string;
  readonly apply: 'build';
  configResolved(config: { readonly base: string }): void;
  generateBundle(this: {
    emitFile(file: { type: 'asset'; fileName: string; source: string }): string;
  }): void;
  readonly transformIndexHtml: {
    readonly order: 'post';
    handler(
      html: string,
      context: { readonly bundle?: Readonly<Record<string, unknown>> },
    ): InterPreloadTag[];
  };
}

export declare const INTER_PACKAGE: string;
export declare const INTER_LICENCE_ASSET: string;
export declare function interWoff2Of(fileNames: Iterable<string>): string;
export declare function interPreloadTag(fileName: string, base?: string): InterPreloadTag;
export declare function interFontPlugin(options: { readonly licenceText: string }): InterFontPlugin;
