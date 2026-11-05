/**
 * **The worker's dev mode** (S-22.16): `compose.worker.dev.yml` over `compose.worker.yml`, and the
 * command `pnpm worker:dev` builds out of it (`scripts/worker-dev.mjs`).
 *
 * Read off the two files on disk with a real YAML parser, so a service or a named resource the base
 * gains later (S-22.10 activates the updater beside this slice) fails here until the dev override
 * answers it. What the compose merge then makes of them was checked once by hand with `docker
 * compose config` (the PR records it); this tier has no daemon.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASE_COMPOSE_FILE,
  composePrefix,
  DEFAULT_ENV_FILE,
  DEV_COMPOSE_FILE,
  DEV_PROJECT,
  pageAddress,
  pageTokenFrom,
  planCommand,
  workerOriginFrom,
} from './worker-dev.mjs';

const REPO = join(import.meta.dirname, '..');

interface YamlNode {
  readonly tag?: string;
}
interface YamlDocument {
  readonly errors: readonly unknown[];
  readonly warnings: readonly { readonly message: string }[];
  toJS(): unknown;
  getIn(path: readonly string[], keepScalar: true): YamlNode | undefined;
}
/** `yaml` is `@platform/infrastructure`'s dependency, borrowed as `coverage-budget.test.ts` does. */
const { parseDocument } = createRequire(join(REPO, 'packages/infrastructure/package.json'))(
  'yaml',
) as { parseDocument: (text: string, options: { logLevel: 'silent' }) => YamlDocument };

interface Service {
  readonly image?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly ports?: readonly string[];
  readonly profiles?: readonly string[];
}
interface ComposeFile {
  readonly name?: string;
  readonly services: Readonly<Record<string, Service>>;
  readonly volumes?: Readonly<Record<string, { readonly name?: string } | null>>;
  readonly networks?: Readonly<Record<string, { readonly name?: string } | null>>;
}

const load = (file: string): { text: string; doc: YamlDocument; compose: ComposeFile } => {
  const text = readFileSync(join(REPO, file), 'utf8');
  const doc = parseDocument(text, { logLevel: 'silent' });
  expect(doc.errors, file).toEqual([]);
  // `!override` is compose's tag, which the parser does not know: the only warning admitted.
  expect(
    doc.warnings.filter((warning) => !/Unresolved tag: !override/.test(warning.message)),
    file,
  ).toEqual([]);
  return { text, doc, compose: doc.toJS() as ComposeFile };
};

const base = load(BASE_COMPOSE_FILE);
const dev = load(DEV_COMPOSE_FILE);
const devService = (name: string): Service => dev.compose.services[name] ?? {};

/** The YAML without its comment lines, whose prose names variables in passing. */
const uncommented = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** `${NAME:-default}` → `default`; a literal stays itself. What the value is with nothing set. */
const defaultOf = (value: string): string =>
  value.replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, '$1').replace(/\$\{[A-Z0-9_]+\}/g, '');

/** Our own images: the four `platform*` images, named directly or through a `PLATFORM_*` var. */
const isOurImage = (image: string): boolean =>
  /\$\{PLATFORM_[A-Z_]*IMAGE/.test(image) || /^platform(-[a-z]+)?:/.test(defaultOf(image));

describe('compose.worker.dev.yml pins nothing to a registry digest', () => {
  it('names only local :dev builds, with no digest and no registry host', () => {
    const images = Object.values(dev.compose.services).flatMap((service) => [
      ...(service.image === undefined ? [] : [service.image]),
      ...Object.entries(service.environment ?? {})
        .filter(([key]) => /IMAGE$/.test(key))
        .map(([, value]) => value),
    ]);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toMatch(/^platform(-launcher|-runtime|-egress)?:dev$/);
    }
    expect(dev.text).not.toMatch(/@sha256:|ghcr\.io/);
  });

  it('re-images every base service that runs one of our images, so no PLATFORM_* value leaks in', () => {
    const ours = Object.entries(base.compose.services)
      .filter(([, service]) => service.image !== undefined && isOurImage(service.image))
      .map(([name]) => name);
    expect(ours).toEqual(expect.arrayContaining(['remote-worker', 'launcher', 'launcher-token']));
    for (const name of ours) {
      expect(devService(name).image, name).toMatch(/:dev$/);
    }
    // The references the worker reports holding (TD-031 decision 4), and the launcher's run images.
    for (const [name, service] of Object.entries(base.compose.services)) {
      for (const [key, value] of Object.entries(service.environment ?? {})) {
        if (/IMAGE$/.test(key) && isOurImage(value)) {
          expect(devService(name).environment?.[key], `${name}.${key}`).toMatch(/:dev$/);
        }
      }
    }
  });

  it('never reads a prod variable that could carry a digest or a prod name', () => {
    for (const name of [
      'PLATFORM_IMAGE',
      'PLATFORM_LAUNCHER_IMAGE',
      'PLATFORM_RUNTIME_IMAGE',
      'PLATFORM_EGRESS_IMAGE',
      'APP_WORKER_UI_PORT',
      'APP_WORKER_CONTROL_VOLUME',
      'APP_WORKER_CACHE_VOLUME',
      'APP_WORKER_RUN_NETWORK',
    ]) {
      expect(dev.text).not.toContain(`\${${name}`);
    }
  });
});

describe('compose.worker.dev.yml enables no updater', () => {
  it('moves every updater service of the base under a profile nobody enables, replacing its list', () => {
    const updaters = Object.entries(base.compose.services).filter(
      ([name, service]) => /updater/.test(name) || service.environment?.ROLE === 'updater',
    );
    // The updater and its socket proxy (S-22.10), which mounts the socket with POST allowed.
    expect(updaters.map(([name]) => name)).toEqual(
      expect.arrayContaining(['updater', 'updater-docker-proxy']),
    );
    for (const [name] of updaters) {
      expect(devService(name).profiles, name).toEqual(['worker-dev-never']);
      // Without `!override` compose merges the two lists, and the base's own profile survives.
      expect(dev.doc.getIn(['services', name, 'profiles'], true)?.tag, name).toBe('!override');
    }
  });

  it('starts no updater of its own', () => {
    for (const [name, service] of Object.entries(dev.compose.services)) {
      expect(service.environment?.ROLE, name).not.toBe('updater');
      expect(name in base.compose.services, `${name} is a service the base defines`).toBe(true);
    }
  });
});

describe('compose.worker.dev.yml runs beside a prod worker on one daemon', () => {
  it('is a compose project of its own', () => {
    expect(base.compose.name).toBe('agentic-worker');
    expect(dev.compose.name).toBe(DEV_PROJECT);
    expect(DEV_PROJECT).not.toBe(base.compose.name);
  });

  it('gives every fixed volume and network name of the base a dev name', () => {
    for (const kind of ['volumes', 'networks'] as const) {
      for (const [key, value] of Object.entries(base.compose[kind] ?? {})) {
        if (value?.name === undefined) continue; // project-scoped already
        const devName = dev.compose[kind]?.[key]?.name;
        expect(devName, `${kind}.${key}`).toBeDefined();
        expect(defaultOf(devName ?? '')).not.toBe(defaultOf(value.name));
        expect(defaultOf(devName ?? '')).toMatch(/^agentic-worker-dev-/);
      }
    }
  });

  it("points the launcher at the dev volumes and the dev run network, not the prod worker's", () => {
    const baseEnv = base.compose.services.launcher?.environment ?? {};
    const devEnv = devService('launcher').environment ?? {};
    const named = [
      'APP_WORKSPACE_CONTROL_VOLUME',
      'APP_WORKSPACE_CACHE_VOLUME',
      'APP_WORKSPACE_HELPER_NETWORK',
      'APP_WORKSPACE_EGRESS_NETWORK',
    ];
    for (const key of named) {
      expect(devEnv[key], key).toBeDefined();
      expect(defaultOf(devEnv[key] ?? ''), key).not.toBe(defaultOf(baseEnv[key] ?? ''));
      expect(defaultOf(devEnv[key] ?? ''), key).toMatch(/^agentic-worker-dev-/);
    }
    // The volume the launcher names is the one compose creates, and the network is the run network.
    expect(devEnv.APP_WORKSPACE_CONTROL_VOLUME).toBe(dev.compose.volumes?.ctl?.name);
    expect(devEnv.APP_WORKSPACE_EGRESS_NETWORK).toBe(dev.compose.networks?.['run-egress']?.name);
  });

  it('fixes no container name in either file (a daemon-global name a prod worker would hold)', () => {
    for (const file of [base, dev]) {
      expect(uncommented(file.text)).not.toMatch(/^\s*container_name\s*:/m);
      for (const [name, service] of Object.entries(file.compose.services)) {
        expect(service, name).not.toHaveProperty('container_name');
      }
    }
  });

  it("replaces every base service's published ports with dev ports of its own", () => {
    const publishing = Object.entries(base.compose.services).filter(
      ([, service]) => (service.ports ?? []).length > 0,
    );
    expect(publishing.map(([name]) => name)).toContain('remote-worker');
    for (const [name, service] of publishing) {
      expect(dev.doc.getIn(['services', name, 'ports'], true)?.tag, name).toBe('!override');
      const hostPorts = (ports: readonly string[]): string[] =>
        ports.map((port) => defaultOf(port).split(':').slice(-2, -1)[0] ?? '');
      const prod = hostPorts(service.ports ?? []);
      for (const port of hostPorts(devService(name).ports ?? [])) {
        expect(port, name).toMatch(/^\d+$/);
        expect(prod, name).not.toContain(port);
      }
    }
  });

  it('publishes the local page on its own loopback port, replacing the base list', () => {
    const worker = devService('remote-worker');
    expect(dev.doc.getIn(['services', 'remote-worker', 'ports'], true)?.tag).toBe('!override');
    expect(worker.ports).toHaveLength(1);
    const [published] = worker.ports ?? [];
    const match = /^127\.0\.0\.1:(.+):7357$/.exec(published ?? '');
    expect(match).not.toBeNull();
    const devPort = defaultOf(match?.[1] ?? '');
    const basePort = defaultOf(
      /^127\.0\.0\.1:(.+):7357$/.exec(
        base.compose.services['remote-worker']?.ports?.[0] ?? '',
      )?.[1] ?? '',
    );
    expect(devPort).toMatch(/^\d+$/);
    expect(devPort).not.toBe(basePort);
    // The worker checks `Host` against the port it is told it is published on.
    expect(worker.environment?.APP_WORKER_UI_PORT).toBe(match?.[1]);
  });

  it('leaves APP_CORE_URL to the settings file', () => {
    expect(devService('remote-worker').environment).not.toHaveProperty('APP_CORE_URL');
  });
});

describe('.env.worker.example', () => {
  const example = readFileSync(join(REPO, '.env.worker.example'), 'utf8');
  const values = new Map(
    example
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

  it('defaults the core to the local dev core and holds no token', () => {
    expect(values.get('APP_CORE_URL')).toBe('http://host.docker.internal:8080');
    expect(values.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('');
  });

  it('lists every variable the two files read in dev mode, set or commented out', () => {
    // The prod names the dev override replaces, and so never reads (`compose.worker.dev.yml`).
    const replacedInDev = new Set([
      'PLATFORM_IMAGE',
      'PLATFORM_LAUNCHER_IMAGE',
      'PLATFORM_RUNTIME_IMAGE',
      'PLATFORM_EGRESS_IMAGE',
      'APP_WORKER_UI_PORT',
      'APP_WORKER_CONTROL_VOLUME',
      'APP_WORKER_CACHE_VOLUME',
      'APP_WORKER_RUN_NETWORK',
    ]);
    const read = new Set(
      [...uncommented(`${base.text}\n${dev.text}`).matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(
        ([, name]) => name,
      ),
    );
    const listed = new Set(
      [...example.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => name),
    );
    expect(read.size).toBeGreaterThan(5);
    for (const name of read) {
      if (name === undefined || replacedInDev.has(name)) continue;
      expect(listed.has(name), name).toBe(true);
    }
    expect(values.get('APP_WORKER_UI')).toBe('enabled');
  });

  it('lists every APP_WORKER_DEV_* variable the dev override reads, with its default', () => {
    const read = [...dev.text.matchAll(/\$\{(APP_WORKER_DEV_[A-Z_]+):-([^}]*)\}/g)];
    expect(read.length).toBeGreaterThan(0);
    for (const [, name, fallback] of read) {
      expect(values.get(name ?? ''), name).toBe(fallback);
    }
  });
});

describe('pnpm worker:dev', () => {
  it('runs every compose command as the dev project, over both files, with .env.worker', () => {
    expect(DEFAULT_ENV_FILE).toBe('.env.worker');
    expect(composePrefix(DEFAULT_ENV_FILE)).toEqual([
      'compose',
      '-p',
      'agentic-worker-dev',
      '--env-file',
      '.env.worker',
      '-f',
      'compose.worker.yml',
      '-f',
      'compose.worker.dev.yml',
    ]);
  });

  it('builds and starts by default, and passes the other verbs on', () => {
    expect(planCommand([])).toEqual({ kind: 'up', build: true });
    expect(planCommand(['up', '--no-build'])).toEqual({ kind: 'up', build: false });
    expect(planCommand(['ui'])).toEqual({ kind: 'ui' });
    expect(planCommand(['logs', '-f', 'remote-worker'])).toEqual({
      kind: 'compose',
      args: ['logs', '-f', 'remote-worker'],
    });
    expect(planCommand(['down'])).toEqual({ kind: 'compose', args: ['down'] });
    expect(planCommand(['ps'])).toEqual({ kind: 'compose', args: ['ps'] });
  });

  it('refuses what it does not know rather than ignoring it', () => {
    expect(planCommand(['up', '--no-biuld'])).toMatchObject({ kind: 'usage' });
    expect(planCommand(['restart'])).toMatchObject({ kind: 'usage' });
    expect(planCommand(['ui', '--port'])).toMatchObject({ kind: 'usage' });
    expect(planCommand(['--help'])).toEqual({ kind: 'usage', error: null });
  });

  it("reads the page token off the worker's latest start line", () => {
    const first = 'a'.repeat(43);
    const second = 'B_-'.repeat(14).concat('x');
    const logs = [
      `{"msg":"this worker's page: http://127.0.0.1:7358/#token=${first} (open it on this machine)"}`,
      'unrelated line #token=short',
      `{"msg":"this worker's page: http://127.0.0.1:7358/#token=${second} (open it on this machine)"}`,
    ].join('\n');
    expect(pageTokenFrom(logs)).toBe(second);
    expect(pageTokenFrom('nothing logged yet')).toBeNull();
    expect(pageTokenFrom(`#token=${'a'.repeat(44)}`)).toBeNull();
  });

  it('prints the page address with the token when one was logged, and without when none was', () => {
    const token = 'a'.repeat(43);
    expect(pageAddress('5174', token)).toBe(`http://localhost:5174/worker.html#token=${token}`);
    // A tokenless page (S-22.17's default) is opened as it is — no placeholder, no complaint.
    expect(pageAddress('5174', null)).toBe('http://localhost:5174/worker.html');
  });

  it("reads the worker's published page address off `docker compose port`", () => {
    expect(workerOriginFrom('127.0.0.1:7358\n')).toBe('http://127.0.0.1:7358');
    expect(workerOriginFrom('')).toBeNull();
  });
});
