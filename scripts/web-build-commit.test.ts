/**
 * **The image build carries its commit into the SPA bundle** — WP-154 criterion (4), PROGRESS
 * backlog 487.
 *
 * The SPA tells an upgraded server from a contract defect by comparing the commit compiled into its
 * bundle with the server's `GET /api/version` `commit` (`apps/web/src/app/build-commit.ts`). Both
 * must come from **one** value, or the comparison says "updated" for every page of a fresh install
 * (two different values) or never (no value in the bundle). The chain, link by link:
 *
 * 1. `image.yml`'s `meta` step writes `GITHUB_SHA` as `commit`, and the build step hands it to
 *    `scripts/build-images.mjs` as `APP_COMMIT`;
 * 2. the script passes it as a build argument to the `platform` image (`versioned`);
 * 3. `docker/app.Dockerfile` declares `ARG APP_COMMIT` in the **`web` stage**, before the build
 *    runs (an `ARG` is per stage: the final stage's declaration does not reach the bundle), and in
 *    the final stage for the server;
 * 4. `apps/web/vite.config.ts` compiles it in — asserted on a **real build's output** here, not on
 *    the config's text, so a `define` that stopped reaching the bundle fails this test.
 *
 * Nothing here needs a Docker daemon; the image itself is built by `image.yml` (rule 66).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundleCommitFrom, DEV_BUILD } from '../apps/web/src/app/build-commit.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The lines of one `FROM … AS <name>` stage of a Dockerfile, up to the next `FROM`. */
const stage = (dockerfile: string, name: string): readonly string[] => {
  const lines = dockerfile.split('\n');
  const start = lines.findIndex((line) =>
    new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\b`).test(line),
  );
  expect(start, `docker/app.Dockerfile has a "${name}" stage`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^FROM\s/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
};

describe('the build commit, from the image build into the bundle (WP-154 (d), criterion (4))', () => {
  it('is written by image.yml and handed to build-images as APP_COMMIT', () => {
    const workflow = read('.github/workflows/image.yml');
    expect(workflow).toMatch(/echo "commit=\$\{GITHUB_SHA\}"/);
    expect(workflow).toMatch(/APP_COMMIT: \$\{\{ steps\.meta\.outputs\.commit \}\}/);
  });

  it('is passed as a build argument to the platform image', () => {
    const script = read('scripts/build-images.mjs');
    expect(script).toMatch(/const BUILD_METADATA = \[[^\]]*'APP_COMMIT'/);
    expect(script).toMatch(
      /name: 'platform',\s*dockerfile: 'app\.Dockerfile',[^}]*versioned: true/,
    );
  });

  it('is declared in the web stage before the bundle is built, and in the final stage', () => {
    const dockerfile = read('docker/app.Dockerfile');
    const web = stage(dockerfile, 'web');
    const declared = web.findIndex((line) => /^ARG APP_COMMIT=?$/.test(line.trim()));
    const built = web.findIndex((line) =>
      /^RUN .*pnpm --filter @platform\/web run build/.test(line),
    );
    expect(declared, 'ARG APP_COMMIT in the web stage').toBeGreaterThanOrEqual(0);
    expect(built, 'the web build').toBeGreaterThan(declared);
    expect(web[built]).toContain('APP_COMMIT');
    const app = stage(dockerfile, 'app');
    expect(app.some((line) => /^ARG APP_COMMIT=?$/.test(line.trim()))).toBe(true);
    expect(app.join('\n')).toMatch(/APP_COMMIT=\$\{APP_COMMIT\}/);
  });

  it('reads an empty or absent commit as dev, and trims a real one', () => {
    expect(bundleCommitFrom(undefined)).toBe(DEV_BUILD);
    expect(bundleCommitFrom('  ')).toBe(DEV_BUILD);
    expect(bundleCommitFrom(' 0123abc\n')).toBe('0123abc');
  });

  it('is compiled into the bundle by the Vite build', { timeout: 120_000 }, () => {
    const commit = 'feedface0123456789abcdef0123456789abcdef';
    const outDir = mkdtempSync(join(tmpdir(), 'wp154-bundle-'));
    try {
      const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      const build = spawnSync(
        pnpm,
        ['--filter', '@platform/web', 'exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, NODE_ENV: 'production', APP_COMMIT: commit },
        },
      );
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      const assets = join(outDir, 'assets');
      const bundle = readdirSync(assets)
        .filter((name) => name.endsWith('.js'))
        .map((name) => readFileSync(join(assets, name), 'utf8'))
        .join('\n');
      // The literal, whichever quote the minifier chose for it.
      // Booleans with a message, so a failure names the fact rather than printing the bundle.
      expect(
        new RegExp(`["'\`]${commit}["'\`]`).test(bundle),
        'the commit literal is in the bundle',
      ).toBe(true);
      // The global's name is gone: Vite replaced every read of it with the literal.
      expect(
        bundle.includes('__PLATFORM_BUILD_COMMIT__'),
        'the global is still read in the bundle',
      ).toBe(false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
