/**
 * **`compose.worker.yml`, rendered for a first install** — WP-284 (2)–(3), TD-032 decision 3,
 * BD-032 decision 9.
 *
 * The template is the file baked into the `platform` image at {@link WORKER_COMPOSE_TEMPLATE_PATH}
 * (`docker/app.Dockerfile` copies the repository's `compose.worker.yml` there), so the bytes a core
 * serves are the bytes of the build it runs — never a file an operator edited on the core's disk. A
 * checkout with no `/opt/platform` (`pnpm dev`, the test tiers) reads the repository's own copy.
 *
 * {@link renderWorkerCompose} changes exactly two kinds of text, and only defaults:
 *
 *  - `${PLATFORM_IMAGE:-…}` (and `_LAUNCHER_`, `_RUNTIME_`, `_EGRESS_`) → the default becomes
 *    `<APP_IMAGE_REPOSITORY>/<image>@sha256:…`, the core's own digest — **pinned**, so a worker runs
 *    what its core advertises and never `latest`; the variable stays, so the updater's managed `.env`
 *    block re-pins it (TD-032 decision 4);
 *  - `${APP_CORE_URL:-}` (or an older template's `${APP_CORE_URL:?…}`) → `${APP_CORE_URL:-<APP_BASE_URL>}`,
 *    the core that served the file — so a core-served file skips the wizard's platform step (WP-294).
 *
 * A template whose platform images are not all of that shape is refused rather than served half
 * pinned: the unit test holds the shipped file to it (every `image:` by digest, no `latest`).
 *
 * **The compose bundle digest** (`handshake`'s `compose_bundle_digest`, backlog 743) is the SHA-256
 * of the rendered file's bytes: two cores that advertise one digest serve one file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CoreImageDigests } from '@platform/contracts';
import { CORE_IMAGES } from './digests.js';

/** Where the `platform` image carries the template (TD-032 decision 3). */
export const WORKER_COMPOSE_TEMPLATE_PATH = '/opt/platform/compose.worker.yml';

/** The variable each core image is named by in the template. */
export const WORKER_IMAGE_VARIABLE: Readonly<Record<keyof CoreImageDigests, string>> = {
  platform: 'PLATFORM_IMAGE',
  platform_launcher: 'PLATFORM_LAUNCHER_IMAGE',
  platform_runtime: 'PLATFORM_RUNTIME_IMAGE',
  platform_egress: 'PLATFORM_EGRESS_IMAGE',
};

export class WorkerComposeTemplateError extends Error {
  override readonly name = 'WorkerComposeTemplateError';
}

/**
 * The template's text: `explicit` when given (`APP_WORKER_COMPOSE_TEMPLATE`), else the image's copy,
 * else the repository's own `compose.worker.yml`. `null` when none can be read.
 */
export const readWorkerComposeTemplate = (
  explicit: string | null = null,
): { readonly path: string; readonly text: string } | null => {
  const repositoryCopy = fileURLToPath(new URL('../../../../compose.worker.yml', import.meta.url));
  const candidates =
    explicit === null ? [WORKER_COMPOSE_TEMPLATE_PATH, repositoryCopy] : [explicit];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return { path, text: readFileSync(path, 'utf8') };
    } catch {
      // An unreadable candidate is the same as an absent one; the next is tried.
    }
  }
  return null;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The template rendered for a first install: the core's images by digest, the core's URL. */
export const renderWorkerCompose = (
  template: string,
  input: {
    readonly digests: CoreImageDigests;
    /** `APP_IMAGE_REPOSITORY`, `<registry>/<namespace>`. */
    readonly repository: string;
    /** `APP_BASE_URL`. */
    readonly coreUrl: string;
  },
): string => {
  const repository = input.repository.replace(/\/+$/, '');
  let rendered = template;
  for (const { key, image } of CORE_IMAGES) {
    const variable = WORKER_IMAGE_VARIABLE[key];
    const pattern = new RegExp(`\\$\\{${escapeRegExp(variable)}:-[^}]*\\}`, 'g');
    if (!pattern.test(rendered)) {
      throw new WorkerComposeTemplateError(
        `the worker compose template names no \${${variable}:-…}, so ${image} cannot be pinned`,
      );
    }
    rendered = rendered.replace(
      pattern,
      `\${${variable}:-${repository}/${image}@${input.digests[key]}}`,
    );
  }
  rendered = rendered.replace(
    /\$\{APP_CORE_URL:[?-][^}]*\}/g,
    `\${APP_CORE_URL:-${input.coreUrl.replace(/\/+$/, '')}}`,
  );
  for (const line of rendered.split('\n')) {
    const image = /^\s*image:\s*(\S+)\s*$/.exec(line)?.[1];
    if (image === undefined) continue;
    const pinned = /^\$\{[A-Z_]+:-(.+)\}$/.exec(image)?.[1] ?? image;
    if (!/@sha256:[0-9a-f]{64}$/.test(pinned) || /:latest(@|$)/.test(pinned)) {
      throw new WorkerComposeTemplateError(
        `the rendered worker compose file would run ${image} unpinned; every image is pinned by digest`,
      );
    }
  }
  return rendered;
};

/** SHA-256 hex of the rendered file's bytes — the compose bundle digest (backlog 743). */
export const composeBundleDigestOf = (rendered: string): string =>
  createHash('sha256').update(rendered, 'utf8').digest('hex');
