/**
 * `compose.yml` composes the instance it says it does — asserted against `docker compose` itself.
 *
 * ## The defect this exists for
 *
 * WP-22 first shipped local mode as a second service, `app-local`, behind `profiles: ['local']`.
 * That is not what a profile does: a service **without** `profiles` always runs, so
 * `COMPOSE_PROFILES=local docker compose up` started *both* `app` and `app-local`, each publishing
 * `${APP_PORT:-8080}:8080`, and the second could not bind. The file read as though the profile
 * replaced the service; nothing said otherwise, because nothing read the file.
 *
 * So local mode is an override file now, and this reads the merged result under each arrangement.
 * The check that matters is **the set of services and the set of published ports**, because those
 * are what "one instance" means and what a second service silently breaks.
 *
 * ## Why it runs `docker compose` rather than parsing YAML
 *
 * The property is about the *merge*: anchors, `extends`, profile selection, override precedence and
 * variable interpolation are compose's semantics, and a YAML parse would be a second implementation
 * of them that agrees with compose exactly until the day it matters (standing rule 65's shape). The
 * command is `config`, which is **client-side** — it resolves and prints, and never contacts a
 * daemon — so this needs the CLI and not the Docker socket.
 *
 * It lives in the e2e tier because that is where a deployment belongs and where the docker CLI is
 * known to exist (CI's `e2e-fake-claude` job); it deliberately does **not** skip when the CLI is
 * absent, because a compose file that is never read is exactly the state this test was written in
 * response to.
 *
 * ## WP-50: what the `app` service's environment actually contains
 *
 * The second defect this file exists for. `compose.yml` used to write the `app` service's
 * environment out by hand — eighteen keys — and nothing compared that list with what the process
 * reads, so twenty of the names `loadServerConfig` asks for never arrived. The symptom an operator
 * met was `POST /api/integrations` refusing every credential name with `(declared: none)` while
 * `APP_INTEGRATION_SECRET_ENV` was set in their `.env`.
 *
 * The file passes `.env` through now, and these tests are the comparison, in **both** directions:
 *
 *  - every name the server reads reaches the container, and
 *  - every name that reaches the container is either one the server reads or a **named residual**,
 *    where the residual is a table of groups with a reason each — and a group that matches nothing
 *    fails too, so the table cannot go stale in either direction.
 *
 * **The read list is derived, never copied** (standing rule 7). `loadServerConfig` is called with a
 * recording `Proxy` for its environment, so the names are whatever the code asks for — including
 * the `_FILE` variants `readEnvWithFile` probes and the three sub-loaders' `APP_DB_*`,
 * `APP_DISPATCH_*` and `APP_JOBS_*`. What that derivation does **not** see is stated rather than
 * implied: `buildInfo` in `runtime.ts` reads `APP_VERSION`/`APP_COMMIT`/`APP_BUILT_AT` (asserted
 * separately, and they must *not* be delivered — see the test), and the integration credential
 * names are read by `routes/onboarding.ts` out of `process.env` by an **operator-declared** name,
 * which is the whole reason a curated passthrough list cannot be complete.
 *
 * **Every case here fixes its own project directory**, so `.env` is a file the test wrote rather
 * than whatever a developer's checkout happens to hold. `--project-directory` moves both halves at
 * once — compose's interpolation `.env` and the service's `env_file` — measured, not assumed.
 *
 * The **live** half of WP-50 is not here and cannot be: `docker compose config` never starts a
 * container, so "a stock instance reaches a created integration" needs a running one.
 * `scripts/compose-stock-check.mjs` is that check, and `.github/workflows/image.yml` runs it on
 * both architectures against the image it is about to publish — the job that has a daemon *and* the
 * images, which CI's `e2e-fake-claude` job has not (it builds `platform-runtime` and
 * `platform-egress` only).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from '@platform/server';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The variables `compose.yml` refuses to interpolate without. Obviously fake (BD-002). */
const ENV = {
  ...process.env,
  APP_SECRET_KEY: 'compose-config-test-not-a-real-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'compose-config-test-not-a-real-token',
  COMPOSE_PROFILES: '',
};

/**
 * A project directory of this test's own, holding the `.env` it was given.
 *
 * Compose resolves both the interpolation `.env` and a service's `env_file` against the project
 * directory, so this one knob makes a case independent of the checkout it runs in — which matters
 * now that `.env` reaches the container: a developer with a real `.env` would otherwise measure
 * their own credentials.
 */
const projectWith = (env: string | null): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'compose-config-'));
  if (env !== null) {
    writeFileSync(path.join(directory, '.env'), env, 'utf8');
  }
  return directory;
};

/** `.env.example`, which is what `cp .env.example .env` gives an operator. */
const STOCK_ENV = readFileSync(path.join(REPO, '.env.example'), 'utf8');

/** A checkout with no `.env` at all: `env_file` is `required: false`, so this must still resolve. */
const NO_ENV_PROJECT = projectWith(null);

interface ComposeConfig {
  readonly services: Record<string, { readonly ports?: { published?: string; target?: number }[] }>;
}

const config = (
  files: readonly string[],
  env: Readonly<Record<string, string>> = {},
  projectDirectory: string = NO_ENV_PROJECT,
): ComposeConfig => {
  const args = files.flatMap((file) => ['-f', path.join(REPO, file)]);
  const raw = execFileSync(
    'docker',
    ['compose', ...args, '--project-directory', projectDirectory, 'config', '--format', 'json'],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...ENV, ...env },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return JSON.parse(raw) as ComposeConfig;
};

/** One service's resolved environment. */
const serviceEnvironment = (service: string, projectDirectory: string): Record<string, string> =>
  (
    config(['compose.yml'], {}, projectDirectory) as unknown as {
      services: Record<string, { environment: Record<string, string> }>;
    }
  ).services[service]?.environment ?? {};

/** The `app` service's resolved environment, which is the subject of the WP-50 cases. */
const appEnvironment = (projectDirectory: string): Record<string, string> =>
  serviceEnvironment('app', projectDirectory);

/**
 * The **product services** — both of them since WP-53.
 *
 * WP-50's census exists because a service's environment drifting from what the server reads is
 * invisible otherwise, and `runner` is the same image running the same `loadServerConfig`. Covering
 * `app` alone would have left the second product container asserted for four launcher names and
 * nothing else, which is the shape the census was written against.
 */
const PRODUCT_SERVICES = ['app', 'runner'] as const;

/**
 * Every environment variable name `loadServerConfig` reads, asked of the code itself.
 *
 * The `Proxy` answers `undefined` for everything, so the loader takes every default and then
 * throws (`APP_SECRET_KEY` has none, `DATABASE_URL` has none) — after the whole object literal it
 * parses has been built, which is where the reads are. The throw is expected and ignored; what is
 * kept is the set of names asked for.
 */
const namesServerReads = (): ReadonlySet<string> => {
  const seen = new Set<string>();
  const recorder = new Proxy({} as Record<string, string | undefined>, {
    get: (_target, key) => {
      if (typeof key === 'string') {
        seen.add(key);
      }
      return undefined;
    },
    has: (_target, key) => {
      if (typeof key === 'string') {
        seen.add(key);
      }
      return false;
    },
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
  try {
    loadServerConfig(recorder);
  } catch {
    // Expected: with nothing set there is no valid configuration. The reads have happened.
  }
  return seen;
};

const services = (result: ComposeConfig): string[] => Object.keys(result.services).sort();

const publishers = (result: ComposeConfig): string[] =>
  Object.entries(result.services)
    .filter(([, service]) => (service.ports ?? []).length > 0)
    .map(([name, service]) => `${name} ${(service.ports ?? []).map((p) => p.published).join(',')}`)
    .sort();

/**
 * Six since WP-53: `runner` is the second product container, and TD-028 decision 6 is what put it
 * there — `app` keeps **no** `ctl` mount and **no** launcher token, and the service that gains
 * both is the only one that runs agent stages.
 */
const BASE_SERVICES = ['app', 'db', 'docker-socket-proxy', 'launcher', 'migrate', 'runner'];

describe('compose.yml', () => {
  it('starts one instance: six services, one of them publishing a port', () => {
    const result = config(['compose.yml']);
    expect(services(result)).toEqual(BASE_SERVICES);
    expect(publishers(result)).toEqual(['app 8080']);
  });

  it('keeps exactly those services under the local override — not one more app', () => {
    const result = config(['compose.yml', 'compose.local.yml']);
    // The defect, as an assertion: with `app-local` this was six services and two publishers of
    // 8080, and `docker compose up` failed on the second bind.
    expect(services(result)).toEqual(BASE_SERVICES);
    expect(publishers(result)).toEqual(['app 8080']);
  });

  it('switches the provider mode rather than adding a process', () => {
    // The positive that makes the assertion above mean something (standing rule 42): the override
    // does change something, and it changes it on the service that already exists.
    const local = config(
      ['compose.yml', 'compose.local.yml'],
      {},
      projectWith(STOCK_ENV),
    ) as unknown as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    expect(local.services['app']?.environment['APP_PROVIDER_MODE']).toBe('local');
    expect(local.services['app']?.environment['CLAUDE_CODE_OAUTH_TOKEN']).toBe(
      'compose-config-test-not-a-real-token',
    );
    // **Both** product services, since WP-53: `runner` is the one that runs an agent, and an
    // instance whose two containers disagreed about the mode would index under one credential and
    // run under another.
    expect(local.services['runner']?.environment['APP_PROVIDER_MODE']).toBe('local');
    expect(local.services['runner']?.environment['CLAUDE_CODE_OAUTH_TOKEN']).toBe(
      'compose-config-test-not-a-real-token',
    );
    // `api` is `.env`'s since WP-50 (and `SERVER_CONFIG_DEFAULTS`' when there is no `.env`) rather
    // than a line on the service — what this case is about is that the override still wins over it.
    const base = config(['compose.yml'], {}, projectWith(STOCK_ENV)) as unknown as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    expect(base.services['app']?.environment['APP_PROVIDER_MODE']).toBe('api');
  });

  /**
   * The defect, exactly: **enabling `local` must add nothing.**
   *
   * The first version of this file asserted the default and the override arrangement, pinned
   * `COMPOSE_PROFILES` to empty in its own environment, and therefore could not see a service
   * behind a profile at all — re-introducing `app-local` left it green (measured, on a copy). What
   * catches it is asking compose for the merged config *with the profile enabled*, which is the
   * shape the operator uses.
   */
  it('has no `local` profile: enabling one adds no service and no second publisher', () => {
    const enabled = config(['compose.yml'], { COMPOSE_PROFILES: 'local' });
    expect(services(enabled)).toEqual(BASE_SERVICES);
    expect(publishers(enabled)).toEqual(['app 8080']);
  });

  it('declares exactly one profile, and it is `backup`', () => {
    // The general form, so the next profile-gated service is a deliberate edit of this list rather
    // than a surprise at `docker compose up` (standing rule 7: ask the file, do not carry a list).
    const result = config(['compose.yml'], {
      COMPOSE_PROFILES: 'local,backup,anything',
    }) as unknown as {
      services: Record<string, { profiles?: string[] }>;
    };
    const declared = [
      ...new Set(Object.values(result.services).flatMap((service) => service.profiles ?? [])),
    ].sort();
    expect(declared).toEqual(['backup']);
  });

  it('adds the backup service only when its profile is enabled, and adds nothing else', () => {
    // `backup` *is* a profile, correctly: `db-backup` is an addition rather than a replacement, so
    // the thing profiles do is the thing wanted.
    const enabled = config(['compose.yml'], { COMPOSE_PROFILES: 'backup' });
    expect(services(enabled)).toEqual([...BASE_SERVICES, 'db-backup'].sort());
    expect(publishers(enabled)).toEqual(['app 8080']);
  });

  /**
   * The backup image's major is the database's — read off the file, never listed here.
   *
   * `pg_dump` refuses a server newer than itself, so a backup service one major behind fails every
   * night and produces nothing: measured against WP-22's first pin, *"aborting because of server
   * version mismatch / server version: 18.6; pg_dump version: 17.6"*. The two images are bumped by
   * different people at different times, which is exactly the pair a check has to hold together
   * (standing rule 7 — ask the file, do not carry a copy of the answer).
   *
   * The digest is deliberately ignored: it pins *which build*, and the question here is which
   * **major**, which is what the tag carries and what `pg_dump` compares.
   */
  it('backs up with a pg_dump of the database’s own major version', () => {
    const result = config(['compose.yml'], { COMPOSE_PROFILES: 'backup' }) as unknown as {
      services: Record<string, { image: string }>;
    };
    const major = (image: string): string => {
      const reference = image.split('@')[0] ?? '';
      const tag = reference.slice(reference.lastIndexOf(':') + 1);
      const parsed = /^([0-9]+)/.exec(tag);
      if (parsed === null) {
        throw new Error(`no major version in the image reference ${JSON.stringify(image)}`);
      }
      return parsed[1] as string;
    };
    const database = major(result.services['db']?.image ?? '');
    const backup = major(result.services['db-backup']?.image ?? '');
    expect(backup).toBe(database);
    // And the comparison is not vacuous: both sides are a real major, not two empty strings.
    expect(Number(database)).toBeGreaterThanOrEqual(18);
  });

  /**
   * TD-021's container half, in the form that survives WP-50.
   *
   * It used to assert that `DOCKER_HOST` was set on exactly one service. That assertion is gone,
   * and deliberately: `.env` is the `app` container's environment now, and `.env.example` declares
   * `DOCKER_HOST`, so a stock instance does put the variable there. Keeping the old assertion would
   * have meant either reverting the fix or passing for the wrong reason — it only stayed green here
   * because this repository happens to have no `.env`.
   *
   * What the property rests on is asserted instead, and it is stronger than a variable name: the
   * socket is bound into one service, and the network that reaches the filtered daemon is joined by
   * two — the proxy and the launcher — so the container serving `/webhooks/*` has no route to
   * either. The source half (no Docker client is constructed, and `DOCKER_HOST` is read, outside
   * `apps/launcher/src/`) is `apps/launcher/src/docker-access.test.ts`, over every tracked file.
   */
  it('binds the docker socket into one service and the proxy network into two (TD-021)', () => {
    const result = config(['compose.yml'], {}, projectWith(STOCK_ENV)) as unknown as {
      services: Record<
        string,
        {
          volumes?: { source?: string }[];
          networks?: Record<string, unknown>;
          environment: Record<string, string>;
        }
      >;
    };
    const withSocket = Object.entries(result.services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) => (volume.source ?? '').includes('docker.sock')),
      )
      .map(([name]) => name);
    expect(withSocket).toEqual(['docker-socket-proxy']);

    const onProxyNetwork = Object.entries(result.services)
      .filter(([, service]) => Object.keys(service.networks ?? {}).includes('docker-proxy'))
      .map(([name]) => name)
      .sort();
    expect(onProxyNetwork).toEqual(['docker-socket-proxy', 'launcher']);
    expect(onProxyNetwork).not.toContain('app');
    // TD-028's own network, and the same claim one level out: the container that talks to the
    // launcher is **not** the container that talks to the daemon, and neither is `app`.
    const onLauncherNetwork = Object.entries(result.services)
      .filter(([, service]) => Object.keys(service.networks ?? {}).includes('launcher-api'))
      .map(([name]) => name)
      .sort();
    expect(onLauncherNetwork).toEqual(['launcher', 'runner']);
    expect(onProxyNetwork).not.toContain('runner');

    // The residual, measured rather than claimed: the variable *is* in the app container on a
    // stock instance, and it is an address to a daemon this service can reach by neither route.
    expect(result.services['app']?.environment['DOCKER_HOST']).toBe('unix:///var/run/docker.sock');
    expect(result.services['launcher']?.environment['DOCKER_HOST']).toBe(
      'tcp://docker-socket-proxy:2375',
    );
  });
});

/**
 * WP-50: the `app` service's environment against the names the server reads.
 *
 * The residual table below is the second half of the comparison. Each group says *why* something
 * the server never reads is in the container anyway, and both directions are checked: a delivered
 * name matching no group fails, and a group matching no delivered name fails too — so a variable
 * removed from `.env.example` leaves a dead row behind rather than a silent one.
 */
const RESIDUAL: readonly { group: string; reason: string; matches: (name: string) => boolean }[] = [
  {
    group: 'the launcher’s',
    // Inert here: this service binds no socket and joins no network that reaches the proxy, and no
    // source outside `apps/launcher/src/` constructs a Docker client (docker-access.test.ts).
    reason: 'read by `readLauncherConfig`, in the one container with a route to the daemon',
    // `APP_LAUNCHER_PORT` joined this group at WP-53: it is the port the *launcher* listens on and
    // the `runner` service interpolates it into its own `APP_LAUNCHER_URL`; no server source reads
    // it. `APP_LAUNCHER_URL`/`APP_LAUNCHER_TOKEN` are **not** here — the server does read those.
    matches: (name) =>
      name === 'DOCKER_HOST' || name === 'APP_LAUNCHER_PORT' || name.startsWith('APP_WORKSPACE_'),
  },
  {
    group: 'the run shim’s',
    reason: 'read inside a run container by `agentic-runlet`; the launcher renders them per run',
    matches: (name) =>
      name.startsWith('RUNLET_') ||
      name === 'CLAUDE_CODE_DISABLE_AUTO_MEMORY' ||
      name === 'DISABLE_AUTOUPDATER',
  },
  {
    group: 'provider credentials',
    // The reason a curated passthrough list cannot be complete: which of these the server reads is
    // decided by the operator's `APP_INTEGRATION_SECRET_ENV`, so the set is unknowable here.
    reason: 'read by name at run time through the operator-declared allow-list (TD-020, WP-21)',
    // `CLAUDE_CODE_OAUTH_TOKEN` **left this group at WP-53**: the server reads it now (PROGRESS
    // backlog 128), so it is in `namesServerReads()` and a row for it here would be a dead one.
    matches: (name) =>
      ['GITLAB_', 'JIRA_', 'SLACK_', 'SENTRY_', 'LOKI_'].some((prefix) => name.startsWith(prefix)),
  },
  {
    group: 'compose’s own',
    // `POSTGRES_PASSWORD` is the residual the backlog entry named first, and it is no new exposure:
    // the `DATABASE_URL` this file computes already carries it into the same container.
    reason:
      'read by `docker compose`, not by any process — the `db` service is what they configure',
    matches: (name) =>
      name.startsWith('POSTGRES_') ||
      name.startsWith('BACKUP_') ||
      name === 'PLATFORM_TAG' ||
      name === 'APP_PORT',
  },
  {
    group: 'development and CI',
    reason: '`pnpm dev`’s Vite proxy and the eval budgets; nothing in the image reads them',
    matches: (name) =>
      name.startsWith('APP_DEV_') || name === 'EVAL_MAX_USD' || name === 'LLM_CI_MAX_USD',
  },
  {
    group: 'declared with no reader in this build',
    // Not this row's to fix: each is documented in `.env.example` and read by nothing. They are
    // listed by name so that a tenth is a decision somebody makes rather than a line somebody adds.
    // `APP_WORKING_DAYS`, `APP_WORKING_HOURS` and `APP_HOLIDAYS` **left** at WP-56: the server
    // reads them now (the working calendar), so they are in `namesServerReads()` instead.
    reason: 'documented in `.env.example`; no source reads them (PROGRESS, WP-50 discovered work)',
    matches: (name) =>
      [
        'APP_DISABLE_TELEMETRY',
        'APP_RUNNER_MAX_PARALLEL',
        'APP_TRANSCRIPT_STORE',
        'APP_WEBHOOK_PUBLIC_URL',
        'APP_WORKSPACE_ROOT',
      ].includes(name) || name.startsWith('APP_FEATURE_'),
  },
];

describe('compose.yml gives the app service the environment the server reads (WP-50)', () => {
  it('asks the code for the names, and the derivation is not vacuous', () => {
    const reads = namesServerReads();
    // Rule 42: a recorder that saw nothing would make every comparison below pass.
    expect(reads.size).toBeGreaterThan(50);
    for (const name of ['APP_SECRET_KEY', 'APP_SECRET_KEY_FILE', 'APP_DB_POOL_MAX', 'TZ']) {
      expect([...reads]).toContain(name);
    }
  });

  it.each(PRODUCT_SERVICES)('delivers every variable the server reads to `%s`', (service) => {
    const delivered = new Set(Object.keys(serviceEnvironment(service, projectWith(STOCK_ENV))));
    const missing = [...namesServerReads()].filter((name) => !delivered.has(name)).sort();
    // **No deliberate omission**: every one of the names `loadServerConfig` reads is declared in
    // `.env.example`, so a stock instance delivers all of them. Before WP-50 this list was twenty
    // names long, among them `APP_INTEGRATION_SECRET_ENV`, `APP_METRICS_USERNAME`,
    // `APP_TRUST_PROXY`, every `APP_SSE_*`, every `APP_DB_*` and every `_FILE` variant.
    expect(missing).toEqual([]);
  });

  it.each(PRODUCT_SERVICES)(
    'names every variable `%s` delivers that the server does not read',
    (service) => {
      const reads = namesServerReads();
      const delivered = Object.keys(serviceEnvironment(service, projectWith(STOCK_ENV)));
      const residual = delivered.filter((name) => !reads.has(name));

      const unclassified = residual
        .filter((name) => !RESIDUAL.some((entry) => entry.matches(name)))
        .sort();
      expect(unclassified).toEqual([]);

      // The other direction: a group that matches nothing is a row about a variable that has gone.
      const empty = RESIDUAL.filter((entry) => !residual.some((name) => entry.matches(name))).map(
        (entry) => entry.group,
      );
      expect(empty).toEqual([]);

      // And the three the backlog entry named, so the trade is measured rather than described.
      expect(residual).toContain('POSTGRES_PASSWORD');
      expect(residual).toContain('DOCKER_HOST');
      expect(residual.some((name) => name.startsWith('RUNLET_'))).toBe(true);
    },
  );

  it('keeps the image’s own build metadata out of the container', () => {
    // `docker/app.Dockerfile` bakes `ENV APP_VERSION=…`, and an `env_file` line set to the empty
    // string overrides an image's ENV. So `.env.example` comments these three out: uncommented,
    // `cp .env.example .env` would make a released image report `0.0.0-dev` at `GET /api/version`.
    const stock = appEnvironment(projectWith(STOCK_ENV));
    for (const name of ['APP_VERSION', 'APP_COMMIT', 'APP_BUILT_AT']) {
      expect(Object.keys(stock)).not.toContain(name);
    }
    // They are still build arguments, which is how the image gets them in the first place.
    const build = (
      config(['compose.yml'], {}, projectWith(STOCK_ENV)) as unknown as {
        services: Record<string, { build?: { args?: Record<string, string> } }>;
      }
    ).services['app']?.build?.args;
    expect(Object.keys(build ?? {}).sort()).toEqual([
      'APP_BUILT_AT',
      'APP_COMMIT',
      'APP_VERSION',
      'BASE_IMAGE',
    ]);
  });

  it('gives `migrate` the same `.env` and the computed database URL', () => {
    const result = config(['compose.yml'], {}, projectWith(STOCK_ENV)) as unknown as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    const migrate = result.services['migrate']?.environment ?? {};
    expect(migrate['APP_DB_PARTITION_MONTHS_AHEAD']).toBe('3');
    expect(migrate['APP_JOBS_SCHEMA']).toBe('pgboss');
    expect(migrate['DATABASE_URL']).toBe('postgres://app:app@db:5432/app');
  });

  it('pins what the topology owns, above anything `.env` says', () => {
    // `environment:` wins over `env_file:`; this is the positive that says the computed remainder
    // still works (rule 42), with a `.env` that disagrees with every one of them.
    const hostile = projectWith(
      `${STOCK_ENV}\nPORT=9000\nHOST=127.0.0.1\nDATABASE_URL=postgres://elsewhere/db\nAPP_KNOWLEDGE_MIRROR_ROOT=/tmp/elsewhere\n`,
    );
    const app = appEnvironment(hostile);
    expect(app['PORT']).toBe('8080');
    expect(app['HOST']).toBe('0.0.0.0');
    expect(app['DATABASE_URL']).toBe('postgres://app:app@db:5432/app');
    expect(app['APP_KNOWLEDGE_MIRROR_ROOT']).toBe('/var/lib/app/knowledge');
  });

  /**
   * Criterion 3, the compose half. Before WP-50 this case could not be written: `compose.yml`
   * declared `APP_SECRET_KEY: ${APP_SECRET_KEY:?…}`, and `${VAR:?…}` fails on unset **or empty**,
   * so an operator who did what TD-020 says — Docker secrets, `APP_SECRET_KEY_FILE` and no
   * `APP_SECRET_KEY` — got compose's own error instead of an instance. Measured on the file this
   * replaces: `error while interpolating services.app.environment.APP_SECRET_KEY: required
   * variable APP_SECRET_KEY is missing a value`, twice, exit 1.
   *
   * The server half is `apps/server/src/config.test.ts` (`reads a secret from its _FILE variant`),
   * and rule 18's other half is asserted here too: the refusal did not disappear with the `:?`, it
   * moved to the process, which is the only place that can tell "no key" from "a key in a file".
   */
  it('resolves an instance configured with only `APP_SECRET_KEY_FILE`', () => {
    const app = appEnvironment(
      projectWith(
        'APP_SECRET_KEY_FILE=/run/secrets/app_secret_key\nAPP_BASE_URL=http://localhost:8080\n',
      ),
    );
    expect(app['APP_SECRET_KEY_FILE']).toBe('/run/secrets/app_secret_key');
    expect(Object.keys(app)).not.toContain('APP_SECRET_KEY');

    // And the refusal an operator with neither must still meet, now from the server (rule 18).
    expect(() => loadServerConfig({ DATABASE_URL: 'postgres://app:app@db:5432/app' })).toThrow(
      /APP_SECRET_KEY must be at least 32 characters/,
    );
  });

  it('carries both halves of the /metrics credential, so it can be authenticated', () => {
    // TD-023's both-or-neither check: neither name was in the old eighteen-key map, so `/metrics`
    // on a compose instance was served unauthenticated and could not be made otherwise.
    const app = appEnvironment(
      projectWith(
        `${STOCK_ENV}\nAPP_METRICS_USERNAME=metrics\nAPP_METRICS_PASSWORD=compose-config-test-not-a-real-password\n`,
      ),
    );
    expect(app['APP_METRICS_USERNAME']).toBe('metrics');
    expect(app['APP_METRICS_PASSWORD']).toBe('compose-config-test-not-a-real-password');
    // The config that pair produces is a valid one, rather than the one-sided refusal.
    const loaded = loadServerConfig({
      DATABASE_URL: 'postgres://app:app@db:5432/app',
      APP_SECRET_KEY: 'compose-config-test-not-a-real-secret-at-least-32',
      APP_METRICS_USERNAME: 'metrics',
      APP_METRICS_PASSWORD: 'compose-config-test-not-a-real-password',
    });
    expect(loaded.metricsUsername).toBe('metrics');
  });

  it('does not reintroduce the two variables this build does not read', () => {
    // PROGRESS backlog 54 carried both names as evidence and neither is read by anything here
    // (rule 39: a wrong clause attached to a true finding). Adding either to `.env.example` would
    // now put it in the container, which is why the guard is here rather than in prose.
    const reads = namesServerReads();
    const delivered = Object.keys(appEnvironment(projectWith(STOCK_ENV)));
    for (const name of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'SENTRY_DSN']) {
      expect([...reads]).not.toContain(name);
      expect(delivered).not.toContain(name);
      expect(STOCK_ENV).not.toContain(name);
    }
  });

  it('resolves with no `.env` at all, and then carries no secret', () => {
    // `required: false`: a checkout, a teardown and CI all run `docker compose config` without one.
    const app = appEnvironment(NO_ENV_PROJECT);
    expect(Object.keys(app).sort()).toEqual([
      'APP_KNOWLEDGE_MIRROR_ROOT',
      // The three WP-53 pins **empty** on this service, which is what keeps the API container out
      // of the `stage.execute` queue even when `.env` carries a launcher token (TD-028 decision 5).
      // All three, because `loadServerConfig` reads the `_FILE` variant first (TD-020): blanking
      // only the plain name would leave `APP_LAUNCHER_TOKEN_FILE` switching this container on.
      'APP_LAUNCHER_TOKEN',
      'APP_LAUNCHER_TOKEN_FILE',
      'APP_LAUNCHER_URL',
      'APP_WORKSPACE_EXPORT_DIR',
      'DATABASE_URL',
      'HOST',
      'PORT',
    ]);
    // And they are empty, which is the property the pin exists for rather than their presence.
    expect(app['APP_LAUNCHER_URL']).toBe('');
    expect(app['APP_LAUNCHER_TOKEN']).toBe('');
    expect(app['APP_LAUNCHER_TOKEN_FILE']).toBe('');
  });

  /**
   * WP-53: the pin does its job against the environment it exists for.
   *
   * `app` takes the whole of `.env` (WP-50), so an operator who put the launcher's token there —
   * which is exactly what the `runner` service needs them to do — would otherwise make the API
   * container compose a provisioner and subscribe `stage.execute`, with no `ctl` mount to serve it
   * from. Asserted from a `.env` that *has* the token, because a stock one does not.
   */
  it('keeps the launcher out of the app container even when `.env` carries the token', () => {
    const withToken = `${STOCK_ENV}\nAPP_LAUNCHER_URL=http://launcher:7780\nAPP_LAUNCHER_TOKEN=${'t'.repeat(40)}\n`;
    const result = config(['compose.yml'], {}, projectWith(withToken)) as unknown as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    expect(result.services['app']?.environment['APP_LAUNCHER_URL']).toBe('');
    expect(result.services['app']?.environment['APP_LAUNCHER_TOKEN']).toBe('');
    // The other direction: the service that is supposed to have it, does.
    expect(result.services['runner']?.environment['APP_LAUNCHER_URL']).toBe('http://launcher:7780');
    expect(result.services['runner']?.environment['APP_LAUNCHER_TOKEN']).toBe('t'.repeat(40));
    expect(result.services['launcher']?.environment['APP_LAUNCHER_TOKEN']).toBe('t'.repeat(40));
  });
});
