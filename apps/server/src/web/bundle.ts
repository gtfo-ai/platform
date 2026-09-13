/**
 * The SPA bundle on disk, and the path guard in front of it (WP-15j).
 *
 * A static file server is a path guard before it is a convenience (BD-022, technical/05): every
 * byte it may return is chosen by an untrusted string. This module is the part that decides which
 * file a request names, and it is deliberately the *only* place in `apps/server` that turns a
 * request path into a filesystem path.
 *
 * ## Why the guard is written here rather than delegated
 *
 * `@fastify/static@10.1.3` (MIT, `@fastify/send@4.1.1`) was measured against a real socket on this
 * machine (macOS 25.6 / APFS, Node 24) before it was rejected, because rule 13 says read the
 * library's behaviour rather than its docs. What it does:
 *
 * | request                                  | answer                                       |
 * |------------------------------------------|----------------------------------------------|
 * | `GET /../outside.txt`                    | 403 — refused                                 |
 * | `GET /%2e%2e/outside.txt`                | 403 — refused                                 |
 * | `GET /assets/../../outside.txt`          | 403 — refused                                 |
 * | `GET /leak.txt` (symlink → outside root) | **200, and the outside file's bytes**         |
 * | `GET /hosts.txt` (symlink → `/etc/hosts`)| **200, 645 bytes of `/etc/hosts`**            |
 * | `GET /.env`                              | **200, the dotfile's bytes**                  |
 *
 * The `..` half is sound; the symlink half is the one this work package's criterion 3 names, and
 * `send` has no realpath check at all. Taking the dependency would therefore still have left the
 * symlink and dotfile guards here — and then two path semantics would decide one question (rule
 * 15's shape). So the containment test is a **realpath comparison**, which is immune to the
 * equivalence classes rules 15 and 26 were paid for: whatever unicode or case folding APFS applies
 * to the requested name, the kernel answers with the canonical path, and a path that resolves
 * outside the root is refused whether it got there by `..`, by an absolute name or by a symlink
 * somebody planted in `dist/`.
 *
 * ## What it serves, and what it refuses
 *
 * - A **regular file** whose realpath is the bundle root or below it. A directory, a device, a
 *   socket and a symlink out are all `null`.
 * - Nothing whose decoded name begins with `.` — `..`, `.env`, `.git` alike. Vite emits no dotfile,
 *   so this costs nothing and closes the case above.
 * - Nothing whose decoded segment contains a separator (`/`, `\`) or a NUL: `%2f` must not create a
 *   path segment after the split has already happened, which is the percent-encoding half of the
 *   same attack.
 *
 * The bundle is immutable for the life of the process — it is baked into the image — so the root is
 * resolved **once** at start-up. A root that is not there when the process starts is not there
 * later either, and the missing directory is named in a log line instead (`fallback.ts`).
 */
import { realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where `docker/app.Dockerfile` puts the Vite output, expressed once.
 *
 * `apps/server/src/web/bundle.ts` → `apps/web/dist`, which is `/app/apps/web/dist` in the image and
 * the checkout's own `apps/web/dist` in development. `bundle-path.test.ts` holds this equal to the
 * Dockerfile's `COPY` target and to `compose.yml`'s `APP_WEB_ROOT`, so moving either fails a test
 * rather than 404ing only inside the image (criterion 5: one constant, not two).
 */
export const BUNDLED_WEB_ROOT = resolve(
  fileURLToPath(new URL('../../../web/dist', import.meta.url)),
);

/** Vite's own output directory for hashed assets (`build.assetsDir`, left at its default). */
export const ASSET_DIRECTORY = 'assets';

/**
 * A hashed asset may be cached for a year; anything else must be revalidated.
 *
 * The shell carries the asset names, so a shell a browser kept would pin a deleted bundle: it gets
 * `no-cache`, which still allows a 304 but never a blind reuse. Everything Vite content-hashes
 * lives under `assets/`, and a file outside it — a favicon, a `robots.txt` copied from `public/` —
 * is not hashed, so it gets the shell's treatment. The failure direction of that rule is a
 * revalidation nobody needed, never a stale byte after a deploy.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

/**
 * Every content type this server declares, as a closed table.
 *
 * Exported because `encoding.ts` classifies each one as worth compressing or not, and a test
 * fails when an entry is in neither list — so adding a type here is a decision about the wire as
 * well as about the browser.
 */
export const CONTENT_TYPES = {
  css: 'text/css; charset=utf-8',
  gif: 'image/gif',
  html: 'text/html; charset=utf-8',
  ico: 'image/vnd.microsoft.icon',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
} as const satisfies Readonly<Record<string, string>>;

/** An extension nobody declared is a download, never something a browser may sniff. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export const contentTypeFor = (name: string): string => {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return DEFAULT_CONTENT_TYPE;
  }
  const declared: Readonly<Record<string, string | undefined>> = CONTENT_TYPES;
  return declared[name.slice(dot + 1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
};

/**
 * The decoded, structurally safe segments of a request path, or `null` for one that is refused.
 *
 * Refusing rather than sanitising is the same answer `assemblePrompt` and `untrusted.tsx` give: a
 * transform that "cleans" a hostile path leaves a second question about what the cleaning missed,
 * and there is no legitimate request in this application for any of the shapes below.
 */
export const decodeRequestPath = (pathname: string): readonly string[] | null => {
  if (!pathname.startsWith('/')) {
    return null;
  }
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw.length === 0) {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // A malformed escape (`%zz`, a lone `%`) is a path nobody meant.
      return null;
    }
    // No `decoded.length === 0` case: an empty raw segment is skipped above, and no non-empty
    // one decodes to nothing — a guard nothing can reach is a guard no test can hold.
    if (
      decoded.startsWith('.') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      return null;
    }
    segments.push(decoded);
  }
  return segments;
};

export interface BundleFile {
  /** The realpath, which is what is read: the containment test and the read see one path. */
  readonly path: string;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly etag: string;
  readonly lastModified: string;
}

const etagFor = (size: number, mtimeMs: number): string =>
  `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;

/**
 * Resolves the bundle root once, refusing a root that is not a directory.
 *
 * Returns `null` rather than throwing: a missing bundle is an operator's packaging question, not a
 * reason for the API process to refuse to start (criterion 6).
 */
export const resolveBundleRoot = async (root: string): Promise<string | null> => {
  try {
    const real = await realpath(root);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
};

/**
 * The file the segments name, or `null` when there is none this server may serve.
 *
 * `realRoot` must already be a realpath (see {@link resolveBundleRoot}), because comparing a
 * realpath against a path that still contains a symlinked ancestor answers "outside" for every
 * request on a machine where `/tmp` is a link — which is the platform this repository is written
 * on, and rule 55's own measurement.
 */
export const resolveBundleFile = async (
  realRoot: string,
  segments: readonly string[],
): Promise<BundleFile | null> => {
  if (segments.length === 0) {
    return null;
  }
  let real: string;
  try {
    real = await realpath(join(realRoot, ...segments));
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return null;
  }
  const info = await stat(real).catch(() => null);
  if (info === null || !info.isFile()) {
    return null;
  }
  return {
    path: real,
    contentType: contentTypeFor(segments[segments.length - 1] ?? ''),
    cacheControl:
      segments[0] === ASSET_DIRECTORY ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL,
    etag: etagFor(info.size, info.mtimeMs),
    lastModified: new Date(info.mtimeMs).toUTCString(),
  };
};
