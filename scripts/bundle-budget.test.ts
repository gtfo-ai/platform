import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `bundle-budget.mjs` against built directories this test constructs.
 *
 * The guard ships as a `scripts/*.mjs` verify step, and standing rule 33 is that such a guard has
 * no tier of its own — mutating it passes the whole suite — so it gets a real test. The subject is
 * the same file `pnpm run -s verify` runs, spawned as a subprocess with `--dist`, which is also
 * what keeps the test from having to build the real application.
 *
 * **What each case pins**, because a budget check has three ways to be silently wrong: it can
 * measure the wrong set (a lazy chunk counted, or the entry missed), it can measure nothing at all
 * and pass, and it can measure correctly and not fail. All three are here.
 */
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'bundle-budget.mjs');

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Dist {
  readonly path: string;
  readonly initialBytes: number;
}

/** Builds a `dist/` whose `index.html` requests `entry` and `styles`, plus an unreferenced chunk. */
const buildDist = (options: {
  readonly entry: string;
  readonly styles: string;
  readonly lazy?: string;
  readonly preload?: string;
  readonly missingAsset?: boolean;
  readonly noAssets?: boolean;
}): Dist => {
  const path = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
  temporaryDirectories.push(path);
  mkdirSync(join(path, 'assets'));

  writeFileSync(join(path, 'assets', 'entry.js'), options.entry);
  writeFileSync(join(path, 'assets', 'styles.css'), options.styles);
  if (options.lazy !== undefined) {
    writeFileSync(join(path, 'assets', 'lazy.js'), options.lazy);
  }
  if (options.preload !== undefined) {
    writeFileSync(join(path, 'assets', 'preload.js'), options.preload);
  }

  const tags = options.noAssets
    ? '<meta name="nothing" content="here" />'
    : [
        '<script type="module" crossorigin src="/assets/entry.js"></script>',
        options.preload === undefined
          ? ''
          : '<link rel="modulepreload" crossorigin href="/assets/preload.js">',
        options.missingAsset === true ? '<link rel="modulepreload" href="/assets/gone.js">' : '',
        '<link rel="stylesheet" crossorigin href="/assets/styles.css">',
      ].join('\n    ');

  writeFileSync(
    join(path, 'index.html'),
    `<!doctype html>\n<html>\n  <head>\n    ${tags}\n  </head>\n  <body><div id="root"></div></body>\n</html>\n`,
  );

  const initialBytes =
    gzipSync(Buffer.from(options.entry)).byteLength +
    gzipSync(Buffer.from(options.styles)).byteLength +
    (options.preload === undefined ? 0 : gzipSync(Buffer.from(options.preload)).byteLength);

  return { path, initialBytes };
};

const run = (args: readonly string[]) =>
  spawnSync(process.execPath, [GUARD, ...args], { encoding: 'utf8' });

describe('the bundle budget guard', () => {
  it('passes under budget and reports the gzipped size of the initial graph', () => {
    const dist = buildDist({ entry: 'a'.repeat(5000), styles: 'b'.repeat(2000) });

    const result = run(['--dist', dist.path, '--budget-bytes', '300000']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: bundle:check');
    expect(result.stdout).toContain(`${dist.initialBytes} B gzipped over 2 initial assets`);
  });

  it('counts a preloaded chunk and ignores one only a dynamic import reaches', () => {
    // The lazy chunk is deliberately enormous: if it were counted, the assertion below fails.
    const dist = buildDist({
      entry: 'a'.repeat(5000),
      styles: 'b'.repeat(2000),
      preload: 'c'.repeat(3000),
      lazy: 'd'.repeat(4_000_000),
    });

    const result = run(['--dist', dist.path, '--budget-bytes', '300000']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${dist.initialBytes} B gzipped over 3 initial assets`);
  });

  it('fails over budget, names the overage and does not suggest raising the number', () => {
    const dist = buildDist({ entry: 'a'.repeat(5000), styles: 'b'.repeat(2000) });

    const result = run(['--dist', dist.path, '--budget-bytes', '10']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: bundle:check');
    expect(result.stderr).toContain(`is ${dist.initialBytes} B gzipped, over the 10 B budget`);
    expect(result.stderr).toContain('Make a route lazy');
  });

  it('fails when the page requests nothing, rather than passing on a measurement of zero', () => {
    const dist = buildDist({ entry: 'a', styles: 'b', noAssets: true });

    const result = run(['--dist', dist.path, '--budget-bytes', '300000']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the parser matched nothing');
  });

  it('fails when the page requests an asset that is not in dist', () => {
    const dist = buildDist({ entry: 'a', styles: 'b', missingAsset: true });

    const result = run(['--dist', dist.path, '--budget-bytes', '300000']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/assets/gone.js');
  });

  it('fails when there is no built page at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'bundle-budget-empty-'));
    temporaryDirectories.push(empty);

    const result = run(['--dist', empty, '--budget-bytes', '300000']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not exist');
  });

  it('rejects a budget that is not a positive integer', () => {
    const dist = buildDist({ entry: 'a', styles: 'b' });

    const result = run(['--dist', dist.path, '--budget-bytes', 'lots']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--budget-bytes must be a positive integer');
  });
});
