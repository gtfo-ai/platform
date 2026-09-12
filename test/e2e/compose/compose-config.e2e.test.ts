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
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The variables `compose.yml` refuses to interpolate without. Obviously fake (BD-002). */
const ENV = {
  ...process.env,
  APP_SECRET_KEY: 'compose-config-test-not-a-real-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'compose-config-test-not-a-real-token',
  COMPOSE_PROFILES: '',
};

interface ComposeConfig {
  readonly services: Record<string, { readonly ports?: { published?: string; target?: number }[] }>;
}

const config = (
  files: readonly string[],
  env: Readonly<Record<string, string>> = {},
): ComposeConfig => {
  const args = files.flatMap((file) => ['-f', file]);
  const raw = execFileSync('docker', ['compose', ...args, 'config', '--format', 'json'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...ENV, ...env },
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(raw) as ComposeConfig;
};

const services = (result: ComposeConfig): string[] => Object.keys(result.services).sort();

const publishers = (result: ComposeConfig): string[] =>
  Object.entries(result.services)
    .filter(([, service]) => (service.ports ?? []).length > 0)
    .map(([name, service]) => `${name} ${(service.ports ?? []).map((p) => p.published).join(',')}`)
    .sort();

const BASE_SERVICES = ['app', 'db', 'docker-socket-proxy', 'launcher', 'migrate'];

describe('compose.yml', () => {
  it('starts one instance: five services, one of them publishing a port', () => {
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
    const local = config(['compose.yml', 'compose.local.yml']) as unknown as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    expect(local.services['app']?.environment['APP_PROVIDER_MODE']).toBe('local');
    expect(local.services['app']?.environment['CLAUDE_CODE_OAUTH_TOKEN']).toBe(
      'compose-config-test-not-a-real-token',
    );
    const base = config(['compose.yml']) as unknown as {
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

  it('binds the docker socket into exactly one service, and it is not the app (TD-021)', () => {
    const result = config(['compose.yml']) as unknown as {
      services: Record<
        string,
        { volumes?: { source?: string }[]; environment: Record<string, string> }
      >;
    };
    const withSocket = Object.entries(result.services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) => (volume.source ?? '').includes('docker.sock')),
      )
      .map(([name]) => name);
    expect(withSocket).toEqual(['docker-socket-proxy']);
    // And the variable that would let a process find a daemon another way is set on one service.
    const withDockerHost = Object.entries(result.services)
      .filter(([, service]) => service.environment['DOCKER_HOST'] !== undefined)
      .map(([name]) => name);
    expect(withDockerHost).toEqual(['launcher']);
  });
});
