/**
 * **The core's own digests, and the worker compose file it serves** — WP-284 (2)–(3), TD-032
 * decision 3, research/17 § 6, backlog 743.
 *
 *  - The anonymous OCI `HEAD`: a `401` with a `Bearer` challenge, an anonymous token from the realm
 *    with the challenge's scope, the `HEAD` again with it, and `Docker-Content-Digest` read — the
 *    flow research/17 measured against GHCR. A realm that is not `https` is refused.
 *  - A failure **names the image**; `APP_WORKER_IMAGE_DIGESTS` is the whole answer when set.
 *  - The shipped `compose.worker.yml`, rendered: every `image:` pinned by digest, no `latest`, the
 *    core's URL as `APP_CORE_URL`'s default; the bundle digest is the rendered file's SHA-256.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  composeBundleDigestOf,
  readWorkerComposeTemplate,
  renderWorkerCompose,
  WorkerComposeTemplateError,
} from './compose.js';
import {
  createCoreDigestSource,
  type DigestFetch,
  DigestsUnresolvedError,
  parseBearerChallenge,
  resolveCoreDigests,
} from './digests.js';
import { workerReleaseOf } from './release.js';

const digest = (char: string): string => `sha256:${char.repeat(64)}`;
const DIGESTS = {
  platform: digest('1'),
  platform_launcher: digest('2'),
  platform_runtime: digest('3'),
  platform_egress: digest('4'),
};
const COMMIT = 'feedc0de'.repeat(5);

/** GHCR's anonymous flow, as research/17 § 6 measured it, over a table of image → digest. */
const ghcr = (known: Readonly<Record<string, string>>) => {
  const calls: string[] = [];
  const fetch: DigestFetch = async (url, init) => {
    calls.push(`${init.method ?? 'GET'} ${url}`);
    const parsed = new URL(url);
    if (parsed.pathname === '/token') {
      expect(parsed.searchParams.get('scope')).toMatch(/^repository:acme\/platform[a-z-]*:pull$/);
      return new Response(JSON.stringify({ token: 'FAKE-anonymous-pull-token' }), { status: 200 });
    }
    const auth = (init.headers as Record<string, string>).authorization;
    const name = parsed.pathname.replace('/v2/', '').replace(/\/manifests\/.*$/, '');
    if (auth !== 'Bearer FAKE-anonymous-pull-token') {
      return new Response(null, {
        status: 401,
        headers: {
          'www-authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${name}:pull"`,
        },
      });
    }
    expect(parsed.pathname).toMatch(/\/manifests\/sha-feedc0d$/);
    const found = known[name];
    return found === undefined
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 200, headers: { 'docker-content-digest': found } });
  };
  return { fetch, calls };
};

const ALL = {
  'acme/platform': DIGESTS.platform,
  'acme/platform-launcher': DIGESTS.platform_launcher,
  'acme/platform-runtime': DIGESTS.platform_runtime,
  'acme/platform-egress': DIGESTS.platform_egress,
};

describe('the core’s own digests (WP-284, research/17 § 6)', () => {
  it('resolves sha-<7> of each image with the anonymous token flow, sending no credential of its own', async () => {
    const registry = ghcr(ALL);
    const resolved = await resolveCoreDigests({
      repository: 'ghcr.io/acme',
      commit: COMMIT,
      fetch: registry.fetch,
    });
    expect(resolved).toEqual(DIGESTS);
    expect(registry.calls.filter((call) => call.startsWith('HEAD'))).toHaveLength(8);
    expect(registry.calls.filter((call) => call.includes('/token'))).toHaveLength(4);
  });

  it('names the image it could not resolve', async () => {
    const { platform_egress: _missing, ...rest } = DIGESTS;
    const registry = ghcr({
      'acme/platform': rest.platform,
      'acme/platform-launcher': rest.platform_launcher,
      'acme/platform-runtime': rest.platform_runtime,
    });
    const failed = resolveCoreDigests({
      repository: 'ghcr.io/acme',
      commit: COMMIT,
      fetch: registry.fetch,
    });
    await expect(failed).rejects.toBeInstanceOf(DigestsUnresolvedError);
    await expect(failed).rejects.toThrow(/ghcr\.io\/acme\/platform-egress:sha-feedc0d.*404/);
  });

  it('refuses a build that does not know its commit, by name, asking the registry nothing', async () => {
    const registry = ghcr(ALL);
    await expect(
      resolveCoreDigests({ repository: 'ghcr.io/acme', commit: null, fetch: registry.fetch }),
    ).rejects.toThrow(/APP_COMMIT/);
    expect(registry.calls).toEqual([]);
  });

  it('reads a Bearer challenge, and refuses a realm that is not https', () => {
    expect(
      parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="x"'),
    ).toEqual({ realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'x' });
    expect(parseBearerChallenge('Bearer realm="http://ghcr.io/token"')).toBeNull();
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseBearerChallenge(null)).toBeNull();
  });

  it('answers APP_WORKER_IMAGE_DIGESTS whole and asks no registry', async () => {
    const registry = ghcr({});
    const source = createCoreDigestSource({
      override: DIGESTS,
      repository: 'ghcr.io/acme',
      commit: COMMIT,
      fetch: registry.fetch,
    });
    expect(source.current()).toEqual(DIGESTS);
    expect(await source.refresh()).toEqual(DIGESTS);
    expect(registry.calls).toEqual([]);
  });

  it('keeps a failure named until it resolves, and retries no sooner than its interval', async () => {
    let now = 0;
    let known: Record<string, string> = {};
    const registry: DigestFetch = async (url, init) => ghcr(known).fetch(url, init);
    const source = createCoreDigestSource({
      override: null,
      repository: 'ghcr.io/acme',
      commit: COMMIT,
      fetch: registry,
      now: () => now,
    });
    expect(await source.refresh()).toBeNull();
    expect(source.failure()?.image).toBe('platform');
    known = ALL;
    expect(await source.refresh()).toBeNull();
    now += 60_000;
    expect(await source.refresh()).toEqual(DIGESTS);
    expect(source.failure()).toBeNull();
  });
});

describe('compose.worker.yml rendered for a first install (WP-284 (3), backlog 743)', () => {
  const template = readWorkerComposeTemplate()?.text;

  it('reads the shipped template', () => {
    expect(template).toContain('ROLE: remote-worker');
  });

  it('pins every image by digest — the core’s four and the third-party ones — and never latest', () => {
    const rendered = renderWorkerCompose(template as string, {
      digests: DIGESTS,
      repository: 'ghcr.io/acme',
      coreUrl: 'https://core.example.test/',
    });
    const images = [...rendered.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    expect(images.length).toBeGreaterThanOrEqual(5);
    for (const image of images) {
      expect(image).toMatch(/@sha256:[0-9a-f]{64}\}?$/);
      expect(image).not.toMatch(/latest/);
    }
    expect(rendered).toContain(`ghcr.io/acme/platform@${DIGESTS.platform}`);
    expect(rendered).toContain(`ghcr.io/acme/platform-launcher@${DIGESTS.platform_launcher}`);
    expect(rendered).toContain(`ghcr.io/acme/platform-runtime@${DIGESTS.platform_runtime}`);
    expect(rendered).toContain(`ghcr.io/acme/platform-egress@${DIGESTS.platform_egress}`);
    expect(rendered).toContain('${APP_CORE_URL:-https://core.example.test}');
    expect(rendered).not.toContain(':-platform:dev');
    // The launcher applies the relayed carriage; the worker holds no database and no secret key.
    expect(rendered).toContain('APP_LAUNCHER_DEPLOY_KEY_CARRIAGE: relayed');
    const declarations = rendered
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(declarations).not.toMatch(/DATABASE_URL|APP_SECRET_KEY|env_file/);
  });

  it('refuses a template whose platform image cannot be pinned, rather than serve it half pinned', () => {
    expect(() =>
      renderWorkerCompose('services:\n  a:\n    image: platform:latest\n', {
        digests: DIGESTS,
        repository: 'ghcr.io/acme',
        coreUrl: 'https://core.example.test',
      }),
    ).toThrow(WorkerComposeTemplateError);
    const unpinned = (template as string).replace(
      /image: tecnativa\/docker-socket-proxy:\S+/,
      'image: tecnativa/docker-socket-proxy:latest',
    );
    expect(() =>
      renderWorkerCompose(unpinned, {
        digests: DIGESTS,
        repository: 'ghcr.io/acme',
        coreUrl: 'https://core.example.test',
      }),
    ).toThrow(/unpinned/);
  });

  it('advertises the rendered file’s own SHA-256 as the compose bundle digest', () => {
    const release = workerReleaseOf(DIGESTS, {
      template: template as string,
      repository: 'ghcr.io/acme',
      coreUrl: 'https://core.example.test',
    });
    expect(release?.composeFile).not.toBeNull();
    expect(release?.composeBundleDigest).toBe(
      createHash('sha256')
        .update(release?.composeFile as string, 'utf8')
        .digest('hex'),
    );
    expect(release?.composeBundleDigest).toBe(
      composeBundleDigestOf(release?.composeFile as string),
    );
    // Another core's digests are another bundle.
    const other = workerReleaseOf(
      { ...DIGESTS, platform: digest('9') },
      {
        template: template as string,
        repository: 'ghcr.io/acme',
        coreUrl: 'https://core.example.test',
      },
    );
    expect(other?.composeBundleDigest).not.toBe(release?.composeBundleDigest);
  });
});
