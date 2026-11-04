/**
 * **What this core advertises to its workers** — the four image digests and the compose bundle's
 * digest (TD-031 §9, TD-032 decision 3), WP-281.
 *
 * The digests are `APP_WORKER_IMAGE_DIGESTS` until WP-284 resolves the core's own `sha-<7>` digests
 * (and keeps the variable as the override); unset, the core **cannot name** them, and the handshake
 * and the claim answer `503 digests_unresolved` rather than advertise or package an image by a
 * digest nobody chose.
 *
 * **The compose bundle's digest** is, until WP-284 renders `compose.worker.yml` from the template
 * baked into the image, the SHA-256 of the four pinned digests' canonical JSON: the bundle is that
 * template with exactly these four images, and the template is itself a file of the `platform`
 * image named here, so two cores that advertise one digest advertise one bundle. WP-284 replaces it
 * with the rendered file's own digest; the field's meaning — *a different bundle reads as a different
 * digest* — is unchanged.
 */
import { createHash } from 'node:crypto';
import type { CoreImageDigests } from '@platform/contracts';

export interface WorkerRelease {
  readonly digests: CoreImageDigests;
  /** SHA-256 hex of the compose bundle (module docblock). */
  readonly composeBundleDigest: string;
}

/** The four digests in a fixed key order, as one JSON text. */
const canonical = (digests: CoreImageDigests): string =>
  JSON.stringify({
    platform: digests.platform,
    platform_egress: digests.platform_egress,
    platform_launcher: digests.platform_launcher,
    platform_runtime: digests.platform_runtime,
  });

/** The release a core advertises, or `null` while it cannot name its digests. */
export const workerReleaseOf = (digests: CoreImageDigests | null): WorkerRelease | null =>
  digests === null
    ? null
    : {
        digests,
        composeBundleDigest: createHash('sha256').update(canonical(digests), 'utf8').digest('hex'),
      };
