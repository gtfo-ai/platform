/**
 * **The core's own image digests** — WP-284, TD-032 decision 3, research/17 § 6.
 *
 * A worker runs the images the core names **by digest** (TD-031 decision 4: the launcher never pulls
 * at create, and a package names its run and egress images by digest), and a worker's compose file is
 * pinned by digest for its first install (BD-032 decision 9). So the core must know its own four
 * images' digests: `platform`, `platform-launcher`, `platform-runtime` and `platform-egress` as
 * `image.yml` publishes them — `<APP_IMAGE_REPOSITORY>/<image>:sha-<first 7 of APP_COMMIT>`.
 *
 * ## How: the anonymous OCI `HEAD` (research/17 § 6)
 *
 * `HEAD /v2/<name>/manifests/sha-<7>` with the OCI index and Docker manifest-list `Accept`, answered
 * `200` with `Docker-Content-Digest` — the **index** digest a multi-arch pin uses. A registry that
 * requires a token answers `401` with `WWW-Authenticate: Bearer realm=…,service=…,scope=…` (GHCR,
 * measured live in research/17); the token is asked anonymously from the realm with that scope and the
 * `HEAD` repeated once with it. Nothing is pulled, and no credential of the platform's is sent: a
 * private registry is the case `APP_WORKER_IMAGE_DIGESTS` exists for.
 *
 * ## When
 *
 * Resolved once per process and cached for its life (TD-032 §3: a running build's digests do not
 * change). A failure is **named** — which image, and why — and answered `503 digests_unresolved` by
 * the routes; it is retried by the next caller after {@link DIGEST_RETRY_MS}, so a registry that was
 * briefly unreachable at start does not leave the core unable to name its images until a restart.
 * `APP_WORKER_IMAGE_DIGESTS` overrides the whole resolution (a mirror, an air-gapped registry).
 */
import type { CoreImageDigests } from '@platform/contracts';
import { coreImageDigestsSchema, imageDigestSchema } from '@platform/contracts';

/** The four product images, in `CoreImageDigests`' key order, as each is named in the registry. */
export const CORE_IMAGES = [
  { key: 'platform', image: 'platform' },
  { key: 'platform_launcher', image: 'platform-launcher' },
  { key: 'platform_runtime', image: 'platform-runtime' },
  { key: 'platform_egress', image: 'platform-egress' },
] as const satisfies readonly { key: keyof CoreImageDigests; image: string }[];

/** How long after a failed resolution the next caller tries again. */
export const DIGEST_RETRY_MS = 60_000;

/** One registry request's bound. */
export const DIGEST_REQUEST_TIMEOUT_MS = 10_000;

/** The manifest types a multi-arch `sha-<7>` tag may answer with (OCI index first). */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export type DigestFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Why the core cannot name one of its images — the `503`'s words. */
export class DigestsUnresolvedError extends Error {
  override readonly name = 'DigestsUnresolvedError';
  /** The image that could not be resolved, or `null` when no image was asked (configuration). */
  readonly image: string | null;
  constructor(image: string | null, message: string) {
    super(message);
    this.image = image;
  }
}

/** `ghcr.io/acme` → `{ registry: 'ghcr.io', namespace: 'acme' }`; `null` for anything else. */
export const parseImageRepository = (
  raw: string,
): { readonly registry: string; readonly namespace: string } | null => {
  const value = raw.trim().replace(/\/+$/, '');
  const match = /^([a-z0-9.-]+(?::[0-9]{1,5})?)\/([a-z0-9._/-]+)$/.exec(value);
  if (match === null) return null;
  const namespace = match[2] as string;
  if (namespace.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return null;
  }
  return { registry: match[1] as string, namespace };
};

/** The `Bearer` challenge's parameters, or `null` when the header is not one. */
export const parseBearerChallenge = (
  header: string | null,
): { readonly realm: string; readonly service?: string; readonly scope?: string } | null => {
  if (header === null || !/^Bearer\s+/i.test(header)) return null;
  const parameters: Record<string, string> = {};
  for (const match of header.replace(/^Bearer\s+/i, '').matchAll(/([a-z]+)="([^"]*)"/gi)) {
    parameters[(match[1] as string).toLowerCase()] = match[2] as string;
  }
  const realm = parameters.realm;
  if (realm === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(realm);
  } catch {
    return null;
  }
  // The realm is the registry's answer: an https URL and nothing else, so a hostile registry cannot
  // point the core at `file:` or a plain-text token endpoint.
  if (parsed.protocol !== 'https:') return null;
  return {
    realm,
    ...(parameters.service === undefined ? {} : { service: parameters.service }),
    ...(parameters.scope === undefined ? {} : { scope: parameters.scope }),
  };
};

const timed = async (
  fetcher: DigestFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
};

/** One image's `sha-<7>` digest, through the anonymous token flow when the registry asks for one. */
export const resolveImageDigest = async (input: {
  readonly registry: string;
  readonly name: string;
  readonly tag: string;
  readonly fetch: DigestFetch;
  readonly timeoutMs?: number;
}): Promise<string> => {
  const timeoutMs = input.timeoutMs ?? DIGEST_REQUEST_TIMEOUT_MS;
  const url = `https://${input.registry}/v2/${input.name}/manifests/${input.tag}`;
  const head = (authorization: string | null) =>
    timed(
      input.fetch,
      url,
      {
        method: 'HEAD',
        headers: {
          accept: MANIFEST_ACCEPT,
          ...(authorization === null ? {} : { authorization }),
        },
      },
      timeoutMs,
    );
  let answer = await head(null);
  if (answer.status === 401) {
    const challenge = parseBearerChallenge(answer.headers.get('www-authenticate'));
    if (challenge === null) {
      throw new Error(`${url} asked for authentication this core cannot give anonymously`);
    }
    const tokenUrl = new URL(challenge.realm);
    if (challenge.service !== undefined) tokenUrl.searchParams.set('service', challenge.service);
    tokenUrl.searchParams.set('scope', challenge.scope ?? `repository:${input.name}:pull`);
    const tokenAnswer = await timed(input.fetch, tokenUrl.toString(), { method: 'GET' }, timeoutMs);
    if (!tokenAnswer.ok) {
      throw new Error(`the registry's token endpoint answered ${tokenAnswer.status}`);
    }
    const body = (await tokenAnswer.json()) as { token?: unknown; access_token?: unknown };
    const token =
      typeof body.token === 'string'
        ? body.token
        : typeof body.access_token === 'string'
          ? body.access_token
          : null;
    if (token === null || token === '') {
      throw new Error("the registry's token endpoint answered no token");
    }
    answer = await head(`Bearer ${token}`);
  }
  if (!answer.ok) {
    throw new Error(`${url} answered ${answer.status}`);
  }
  const digest = imageDigestSchema.safeParse(answer.headers.get('docker-content-digest'));
  if (!digest.success) {
    throw new Error(`${url} answered no Docker-Content-Digest a pin can use`);
  }
  return digest.data;
};

/** The four digests of the build `commit` in `repository`, or a {@link DigestsUnresolvedError}. */
export const resolveCoreDigests = async (input: {
  readonly repository: string | null;
  readonly commit: string | null;
  readonly fetch: DigestFetch;
  readonly timeoutMs?: number;
}): Promise<CoreImageDigests> => {
  if (input.repository === null) {
    throw new DigestsUnresolvedError(
      null,
      'APP_IMAGE_REPOSITORY is unset, so this core cannot look up its own images; set it (for example ghcr.io/<owner>) or pin them with APP_WORKER_IMAGE_DIGESTS',
    );
  }
  const repository = parseImageRepository(input.repository);
  if (repository === null) {
    throw new DigestsUnresolvedError(
      null,
      `APP_IMAGE_REPOSITORY is not <registry>/<namespace>: ${input.repository}`,
    );
  }
  const commit = input.commit?.trim() ?? '';
  if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    throw new DigestsUnresolvedError(
      null,
      'this build does not know its commit (APP_COMMIT), so it has no sha-<7> tag to resolve; pin the images with APP_WORKER_IMAGE_DIGESTS',
    );
  }
  const tag = `sha-${commit.slice(0, 7)}`;
  const resolved: Record<string, string> = {};
  for (const { key, image } of CORE_IMAGES) {
    const name = `${repository.namespace}/${image}`;
    try {
      resolved[key] = await resolveImageDigest({
        registry: repository.registry,
        name,
        tag,
        fetch: input.fetch,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
    } catch (error) {
      throw new DigestsUnresolvedError(
        image,
        `${repository.registry}/${name}:${tag} could not be resolved to a digest: ${(error as Error).message}`,
      );
    }
  }
  return coreImageDigestsSchema.parse(resolved);
};

/** The cache a process keeps: resolved once, a failure retried after {@link DIGEST_RETRY_MS}. */
export interface CoreDigestSource {
  /** The digests, or `null` while they are unresolved (never throws). */
  current(): CoreImageDigests | null;
  /** Why they are unresolved, naming the image — `null` once resolved. */
  failure(): DigestsUnresolvedError | null;
  /** Resolves now (or answers the cached digests); never throws. */
  refresh(): Promise<CoreImageDigests | null>;
}

export const createCoreDigestSource = (input: {
  /** `APP_WORKER_IMAGE_DIGESTS`: the whole answer, nothing is resolved. */
  readonly override: CoreImageDigests | null;
  readonly repository: string | null;
  readonly commit: string | null;
  readonly fetch?: DigestFetch;
  readonly now?: () => number;
  readonly onFailure?: (error: DigestsUnresolvedError) => void;
}): CoreDigestSource => {
  const now = input.now ?? Date.now;
  let digests: CoreImageDigests | null = input.override;
  let failure: DigestsUnresolvedError | null = null;
  let failedAt: number | null = null;
  let inFlight: Promise<CoreImageDigests | null> | null = null;
  const refresh = (): Promise<CoreImageDigests | null> => {
    if (digests !== null) return Promise.resolve(digests);
    if (failedAt !== null && now() - failedAt < DIGEST_RETRY_MS) return Promise.resolve(null);
    inFlight ??= resolveCoreDigests({
      repository: input.repository,
      commit: input.commit,
      fetch: input.fetch ?? ((url, init) => fetch(url, init)),
    })
      .then((resolved) => {
        digests = resolved;
        failure = null;
        failedAt = null;
        return resolved;
      })
      .catch((error: unknown) => {
        failure =
          error instanceof DigestsUnresolvedError
            ? error
            : new DigestsUnresolvedError(null, (error as Error).message);
        failedAt = now();
        input.onFailure?.(failure);
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return {
    current: () => {
      if (digests === null) void refresh();
      return digests;
    },
    failure: () => (digests === null ? failure : null),
    refresh,
  };
};
