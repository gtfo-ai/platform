/**
 * **What this core advertises to its workers** — the four image digests, the compose bundle and its
 * digest (TD-031 §9, TD-032 decision 3), WP-281 and WP-284.
 *
 * The digests are the core's own `sha-<7>` images, resolved with the anonymous OCI `HEAD`
 * (`digests.ts`), or `APP_WORKER_IMAGE_DIGESTS` when an operator pins them (a mirror, an air-gapped
 * registry). While neither has an answer the core **cannot name** them, and `handshake`, `claims`,
 * `release` and `compose.yml` answer `503 digests_unresolved` naming the image rather than advertise or
 * package one nobody chose.
 *
 * **The compose bundle's digest** is, since WP-284 (backlog 743), the SHA-256 of the rendered
 * `compose.worker.yml` — the template baked into this image, pinned to these digests (`compose.ts`).
 * A core whose template cannot be read (a build without `/opt/platform` and no checkout beside it)
 * still advertises its digests; its bundle digest is then the SHA-256 of the four digests' canonical
 * JSON (WP-281's definition, the same meaning — *a different bundle reads as a different digest*) and
 * `compose.yml` answers `503 compose_template_unavailable`.
 */
import { createHash } from 'node:crypto';
import type { CoreImageDigests } from '@platform/contracts';
import {
  composeBundleDigestOf,
  renderWorkerCompose,
  WorkerComposeTemplateError,
} from './compose.js';
import type { CoreDigestSource } from './digests.js';

export interface WorkerRelease {
  readonly digests: CoreImageDigests;
  /** SHA-256 hex of the compose bundle (module docblock). */
  readonly composeBundleDigest: string;
  /** The rendered `compose.worker.yml`, or `null` when its template could not be read. */
  readonly composeFile: string | null;
}

/** The four digests in a fixed key order, as one JSON text. */
const canonical = (digests: CoreImageDigests): string =>
  JSON.stringify({
    platform: digests.platform,
    platform_egress: digests.platform_egress,
    platform_launcher: digests.platform_launcher,
    platform_runtime: digests.platform_runtime,
  });

export interface WorkerReleaseInput {
  /** The template's text, or `null` when none could be read. */
  readonly template: string | null;
  /** `APP_IMAGE_REPOSITORY`. */
  readonly repository: string;
  /** `APP_BASE_URL`. */
  readonly coreUrl: string;
}

/** The release a core advertises, or `null` while it cannot name its digests. */
export const workerReleaseOf = (
  digests: CoreImageDigests | null,
  input: WorkerReleaseInput | null = null,
): WorkerRelease | null => {
  if (digests === null) return null;
  let composeFile: string | null = null;
  if (input !== null && input.template !== null) {
    try {
      composeFile = renderWorkerCompose(input.template, {
        digests,
        repository: input.repository,
        coreUrl: input.coreUrl,
      });
    } catch (error) {
      // A template that cannot be pinned is served by nobody: `compose.yml` answers 503 by name.
      if (!(error instanceof WorkerComposeTemplateError)) throw error;
      composeFile = null;
    }
  }
  return {
    digests,
    composeBundleDigest:
      composeFile === null
        ? createHash('sha256').update(canonical(digests), 'utf8').digest('hex')
        : composeBundleDigestOf(composeFile),
    composeFile,
  };
};

/** The release over a digest source, rendered once per resolved set of digests. */
export const createWorkerReleaseSource = (
  digests: CoreDigestSource,
  input: WorkerReleaseInput,
): { readonly current: () => WorkerRelease | null; readonly unresolved: () => string | null } => {
  let cached: { readonly digests: CoreImageDigests; readonly release: WorkerRelease } | null = null;
  return {
    current: () => {
      const now = digests.current();
      if (now === null) return null;
      if (cached === null || cached.digests !== now) {
        cached = { digests: now, release: workerReleaseOf(now, input) as WorkerRelease };
      }
      return cached.release;
    },
    unresolved: () => digests.failure()?.message ?? null,
  };
};
