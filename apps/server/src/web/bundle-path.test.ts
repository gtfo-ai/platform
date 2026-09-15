/**
 * One constant, not two: the directory the image writes the bundle to and the one the server reads
 * (WP-15j criterion 5).
 *
 * `docker/app.Dockerfile` copies the Vite output into the image and `apps/server/src/web/bundle.ts`
 * states where the process looks for it. If those two drift, every test in this repository stays
 * green and `/` answers 404 **only inside the image** — a failure that shows up after a release, in
 * somebody else's `docker compose up`. So the Dockerfile is read here and the two are compared,
 * the shape `apps/launcher/src/docker-access.test.ts` uses for a claim about a file no test tier
 * executes.
 *
 * The third place the path could drift is the operator's configuration. Until WP-50 that was a line
 * on the `app` service (`APP_WEB_ROOT: ${APP_WEB_ROOT:-}`); since WP-50 `.env` **is** the container's
 * environment, so the variable reaches the process from `.env.example`'s own declaration and the
 * compose file names it nowhere. Either way the property is the same and is what this file checks:
 * **no second copy of the path**, in compose or in `.env.example`, because an empty value means "the
 * directory the image carries". A declaration that named a *different* directory is still refused.
 */
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUNDLED_WEB_ROOT } from './bundle.js';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path: string): string => readFileSync(join(repositoryRoot, path), 'utf8');

interface WebCopy {
  readonly stage: string;
  readonly workdir: string;
  readonly source: string;
  readonly destination: string;
}

/** The `COPY --from=web …` instruction, with the `WORKDIR` in force where it appears. */
const webCopy = (dockerfile: string): WebCopy | null => {
  let stage = '';
  let workdir = '/';
  for (const line of dockerfile.split('\n').map((entry) => entry.trim())) {
    const from = /^FROM\s+\S+\s+AS\s+(\S+)/i.exec(line);
    if (from?.[1] !== undefined) {
      stage = from[1];
      workdir = '/';
      continue;
    }
    const cwd = /^WORKDIR\s+(\S+)/i.exec(line);
    if (cwd?.[1] !== undefined) {
      workdir = cwd[1];
      continue;
    }
    const copy = /^COPY\s+--from=web\s+(?:--\S+\s+)*(\S+)\s+(\S+)\s*$/i.exec(line);
    if (copy?.[1] !== undefined && copy[2] !== undefined) {
      return { stage, workdir, source: copy[1], destination: copy[2] };
    }
  }
  return null;
};

describe('the bundle directory the image writes and the one the server reads', () => {
  it('are the same path', () => {
    const copy = webCopy(read('docker/app.Dockerfile'));
    // The scope, before anything is concluded from it (standing rule 4): a parse that found no
    // COPY would compare nothing and pass.
    expect(copy).not.toBeNull();
    expect(copy?.stage).toBe('app');
    expect(copy?.workdir).toBe('/app');
    expect(copy?.source).toBe('/src/apps/web/dist');

    // The server's constant, as the image would express it: `<WORKDIR>/<relative path>`.
    const fromRepositoryRoot = relative(repositoryRoot, BUNDLED_WEB_ROOT).split(sep).join('/');
    expect(fromRepositoryRoot).toBe('apps/web/dist');
    expect(`${copy?.workdir}/${(copy?.destination ?? '').replace(/^\.\//, '')}`).toBe(
      `/app/${fromRepositoryRoot}`,
    );
  });

  it('are configured without a second copy of the path', () => {
    // TD-020: a variable the server reads is a variable the operator can set. What the operator's
    // configuration must not do is name a *different* directory — an empty value (the image's own)
    // is the shape it ships with.
    const compose = read('compose.yml');
    // Since WP-50 the service does not list the variable at all, so the load-bearing half is that
    // compose carries no bundle path anywhere; the `if` below keeps a future declaration honest
    // rather than assuming there is none.
    expect(compose).not.toContain('apps/web/dist');
    const declaration = /^\s*APP_WEB_ROOT:\s*\$\{APP_WEB_ROOT(:-([^}]*))?\}\s*$/m.exec(compose);
    const fallbackValue = declaration?.[2] ?? '';
    if (fallbackValue !== '') {
      expect(fallbackValue).toBe('/app/apps/web/dist');
    }

    // What the container actually gets on a stock instance: `.env.example`'s own line, which is
    // where every other variable now comes from too. Non-vacuous — an absent line fails here.
    const stock = /^APP_WEB_ROOT=(.*)$/m.exec(read('.env.example'));
    expect(stock).not.toBeNull();
    expect(stock?.[1]).toBe('');
  });

  it('is documented for the operator, with the same variable name', () => {
    // `.env.example` lists every variable with a safe default (CLAUDE.md), and an absent entry is
    // how an operator finds out a knob exists only by reading the source.
    expect(read('.env.example')).toContain('\nAPP_WEB_ROOT=\n');
    expect(read('docs/technical/12-configuration-and-schemas.md')).toContain('`APP_WEB_ROOT`');
  });
});
