/**
 * **The updater's registry reads** — WP-287 (2), TD-032 decision 3, research/17 § 6.
 *
 * The worker's updater reads three things from an OCI registry, anonymously: a manifest by digest,
 * the **referrers** of a digest (where `actions/attest-build-provenance` with `push-to-registry`
 * stores the build attestation), and a blob. Nothing is pulled into service here — that is the
 * apply's `docker compose pull`, after verification.
 *
 * ## Content addressing is the trust, not the endpoint
 *
 * Every manifest and blob is asked **by digest** and its bytes are hashed and compared before they are
 * parsed; a mismatch is refused. That is what lets `APP_UPDATE_REGISTRY_ENDPOINTS` point a registry
 * host at another origin (a mirror, or the Docker check's local registry) without it being a trust
 * decision: the endpoint can withhold an answer, never change one. The one thing read by **tag** is
 * the referrers fallback (`sha256-<hex>`, OCI 1.1's tag schema — GHCR answers the referrers API
 * `404`, measured at S-22.10), and what it lists is only a list of candidates: each candidate is then
 * fetched by digest and its signature verified (`attestation.ts`).
 *
 * The anonymous token flow is the core's (`workers/digests.ts`): a `401` with a `Bearer` challenge
 * whose realm is `https`, one token per repository, no credential of the worker's ever sent.
 */
import { createHash } from 'node:crypto';
import { parseBearerChallenge, readBounded, TOKEN_ANSWER_MAX_CHARS } from '../workers/digests.js';

export type RegistryFetch = (url: string, init: RequestInit) => Promise<Response>;

/** One request's bound. */
export const REGISTRY_REQUEST_TIMEOUT_MS = 30_000;
/** A manifest (or an index) is a few KiB; past this it is refused. */
export const MANIFEST_MAX_BYTES = 1024 * 1024;

/** The media types a digest may answer with: an index first, then a single manifest. */
export const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** `ghcr.io/acme/platform` → the registry host and the repository name. */
export interface ImageRepository {
  readonly registry: string;
  readonly name: string;
}

export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}

/** `<registry>/<name>` (the registry a host with a dot or a port, or `localhost`), else `null`. */
export const parseImageRepositoryName = (raw: string): ImageRepository | null => {
  const value = raw.trim();
  const match =
    /^((?:[a-z0-9-]+\.)+[a-z0-9-]+(?::[0-9]{1,5})?|localhost(?::[0-9]{1,5})?|[a-z0-9-]+:[0-9]{1,5})\/([a-z0-9]+(?:[._/-][a-z0-9]+)*)$/.exec(
      value,
    );
  if (match === null) return null;
  return { registry: match[1] as string, name: match[2] as string };
};

/** `sha256:<64 hex>` — every read here is by digest. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const sha256Of = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * `APP_UPDATE_REGISTRY_ENDPOINTS`: `host=origin[,host=origin…]` — where a registry host is read
 * from (a mirror; the Docker check's local registry). The origin is `http(s)://host[:port]` and
 * nothing else. Empty: every registry is `https://<host>`.
 */
export const parseRegistryEndpoints = (raw: string | undefined): ReadonlyMap<string, string> => {
  const endpoints = new Map<string, string>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      throw new RegistryError(`APP_UPDATE_REGISTRY_ENDPOINTS: "${trimmed}" is not host=origin`);
    }
    const host = trimmed.slice(0, separator).trim();
    let origin: URL;
    try {
      origin = new URL(trimmed.slice(separator + 1).trim());
    } catch {
      throw new RegistryError(`APP_UPDATE_REGISTRY_ENDPOINTS: ${host}'s origin is not a URL`);
    }
    if (
      (origin.protocol !== 'https:' && origin.protocol !== 'http:') ||
      origin.username !== '' ||
      origin.password !== '' ||
      (origin.pathname !== '/' && origin.pathname !== '') ||
      origin.search !== '' ||
      origin.hash !== ''
    ) {
      throw new RegistryError(
        `APP_UPDATE_REGISTRY_ENDPOINTS: ${host}'s origin must be http(s)://host[:port] and nothing else`,
      );
    }
    endpoints.set(host, origin.origin);
  }
  return endpoints;
};

export interface IndexEntry {
  readonly mediaType: string;
  readonly digest: string;
  readonly artifactType?: string;
  readonly annotations?: Readonly<Record<string, string>>;
  readonly platform?: { readonly os?: string; readonly architecture?: string };
}

export interface FetchedManifest {
  readonly digest: string;
  readonly mediaType: string;
  readonly body: Record<string, unknown>;
}

export interface RegistryClient {
  /** A manifest or an index, asked by digest and refused unless its bytes hash to it. */
  manifest(repository: ImageRepository, digest: string): Promise<FetchedManifest>;
  /** The referrers of a digest: the OCI 1.1 API, else the `sha256-<hex>` tag schema; `[]` for none. */
  referrers(repository: ImageRepository, digest: string): Promise<readonly IndexEntry[]>;
  /** A blob by digest, at most `maxBytes`, refused unless it hashes to the digest. */
  blob(repository: ImageRepository, digest: string, maxBytes: number): Promise<Buffer>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The entries of an index body, keeping only well-formed ones. */
export const indexEntriesOf = (body: unknown): IndexEntry[] => {
  if (!isRecord(body) || !Array.isArray(body.manifests)) return [];
  const entries: IndexEntry[] = [];
  for (const raw of body.manifests) {
    if (!isRecord(raw)) continue;
    if (typeof raw.digest !== 'string' || !DIGEST.test(raw.digest)) continue;
    if (typeof raw.mediaType !== 'string') continue;
    const annotations = isRecord(raw.annotations)
      ? Object.fromEntries(
          Object.entries(raw.annotations).filter(
            (pair): pair is [string, string] => typeof pair[1] === 'string',
          ),
        )
      : undefined;
    const platform = isRecord(raw.platform)
      ? {
          ...(typeof raw.platform.os === 'string' ? { os: raw.platform.os } : {}),
          ...(typeof raw.platform.architecture === 'string'
            ? { architecture: raw.platform.architecture }
            : {}),
        }
      : undefined;
    entries.push({
      mediaType: raw.mediaType,
      digest: raw.digest,
      ...(typeof raw.artifactType === 'string' ? { artifactType: raw.artifactType } : {}),
      ...(annotations === undefined ? {} : { annotations }),
      ...(platform === undefined ? {} : { platform }),
    });
  }
  return entries;
};

const readBytes = async (response: Response, max: number, what: string): Promise<Buffer> => {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryError(`${what} is longer than ${max} bytes; refused`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

export const createRegistryClient = (
  options: {
    readonly fetch?: RegistryFetch;
    readonly endpoints?: ReadonlyMap<string, string>;
    readonly timeoutMs?: number;
  } = {},
): RegistryClient => {
  const fetcher: RegistryFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? REGISTRY_REQUEST_TIMEOUT_MS;
  const tokens = new Map<string, string>();

  const origin = (repository: ImageRepository): string =>
    options.endpoints?.get(repository.registry) ?? `https://${repository.registry}`;

  const timed = async (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(url, { ...init, signal: controller.signal, redirect: 'follow' });
    } catch (error) {
      throw new RegistryError(`${url} could not be reached (${(error as Error).message})`);
    } finally {
      clearTimeout(timer);
    }
  };

  /** A GET, through the anonymous token flow when the registry asks for one. */
  const get = async (
    repository: ImageRepository,
    path: string,
    accept: string | null,
  ): Promise<Response> => {
    const url = `${origin(repository)}/v2/${repository.name}/${path}`;
    const key = `${repository.registry}/${repository.name}`;
    const ask = (token: string | undefined) =>
      timed(url, {
        method: 'GET',
        headers: {
          ...(accept === null ? {} : { accept }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
      });
    let answer = await ask(tokens.get(key));
    if (answer.status === 401) {
      await answer.body?.cancel().catch(() => undefined);
      const challenge = parseBearerChallenge(answer.headers.get('www-authenticate'));
      if (challenge === null) {
        throw new RegistryError(
          `${url} asked for authentication this updater cannot give anonymously`,
        );
      }
      const tokenUrl = new URL(challenge.realm);
      if (challenge.service !== undefined) tokenUrl.searchParams.set('service', challenge.service);
      tokenUrl.searchParams.set('scope', `repository:${repository.name}:pull`);
      const tokenAnswer = await timed(tokenUrl.toString(), { method: 'GET' });
      if (!tokenAnswer.ok) {
        throw new RegistryError(`the registry's token endpoint answered ${tokenAnswer.status}`);
      }
      const text = await readBounded(tokenAnswer, TOKEN_ANSWER_MAX_CHARS);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new RegistryError("the registry's token answer is not JSON");
      }
      const token = isRecord(body)
        ? typeof body.token === 'string'
          ? body.token
          : typeof body.access_token === 'string'
            ? body.access_token
            : ''
        : '';
      if (token === '') throw new RegistryError("the registry's token endpoint answered no token");
      tokens.set(key, token);
      answer = await ask(token);
    }
    return answer;
  };

  const manifest = async (
    repository: ImageRepository,
    digest: string,
  ): Promise<FetchedManifest> => {
    if (!DIGEST.test(digest)) throw new RegistryError(`${digest} is not a sha256 digest`);
    const answer = await get(repository, `manifests/${digest}`, MANIFEST_ACCEPT);
    if (!answer.ok) {
      await answer.body?.cancel().catch(() => undefined);
      throw new RegistryError(
        `${repository.registry}/${repository.name}@${digest} answered ${answer.status}`,
      );
    }
    const bytes = await readBytes(answer, MANIFEST_MAX_BYTES, `the manifest ${digest}`);
    if (sha256Of(bytes) !== digest) {
      throw new RegistryError(
        `${repository.registry}/${repository.name}@${digest}: the bytes served do not hash to the digest asked; refused`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new RegistryError(`the manifest ${digest} is not JSON`);
    }
    if (!isRecord(body)) throw new RegistryError(`the manifest ${digest} is not an object`);
    const mediaType =
      typeof body.mediaType === 'string'
        ? body.mediaType
        : ((answer.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '');
    return { digest, mediaType, body };
  };

  return {
    manifest,
    async referrers(repository, digest) {
      if (!DIGEST.test(digest)) throw new RegistryError(`${digest} is not a sha256 digest`);
      const api = await get(
        repository,
        `referrers/${digest}`,
        'application/vnd.oci.image.index.v1+json',
      );
      if (api.ok) {
        const bytes = await readBytes(api, MANIFEST_MAX_BYTES, `the referrers of ${digest}`);
        try {
          return indexEntriesOf(JSON.parse(bytes.toString('utf8')));
        } catch {
          return [];
        }
      }
      await api.body?.cancel().catch(() => undefined);
      // OCI 1.1's fallback: the referrers index under the tag `sha256-<hex>` (GHCR, measured).
      const tag = await get(
        repository,
        `manifests/sha256-${digest.slice('sha256:'.length)}`,
        'application/vnd.oci.image.index.v1+json',
      );
      if (tag.status === 404) {
        await tag.body?.cancel().catch(() => undefined);
        return [];
      }
      if (!tag.ok) {
        await tag.body?.cancel().catch(() => undefined);
        throw new RegistryError(
          `the referrers of ${repository.registry}/${repository.name}@${digest} answered ${tag.status}`,
        );
      }
      const bytes = await readBytes(tag, MANIFEST_MAX_BYTES, `the referrers of ${digest}`);
      try {
        return indexEntriesOf(JSON.parse(bytes.toString('utf8')));
      } catch {
        return [];
      }
    },
    async blob(repository, digest, maxBytes) {
      if (!DIGEST.test(digest)) throw new RegistryError(`${digest} is not a sha256 digest`);
      const answer = await get(repository, `blobs/${digest}`, null);
      if (!answer.ok) {
        await answer.body?.cancel().catch(() => undefined);
        throw new RegistryError(
          `the blob ${repository.registry}/${repository.name}@${digest} answered ${answer.status}`,
        );
      }
      const bytes = await readBytes(answer, maxBytes, `the blob ${digest}`);
      if (sha256Of(bytes) !== digest) {
        throw new RegistryError(
          `the blob ${digest}: the bytes served do not hash to the digest asked; refused`,
        );
      }
      return bytes;
    },
  };
};
