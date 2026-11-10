import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  /** The worker's page (WP-292): the same tags by default, or its own, or none at all. */
  readonly worker?: { readonly preload?: string } | 'absent';
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

  const page = (head: string) =>
    `<!doctype html>\n<html>\n  <head>\n    ${head}\n  </head>\n  <body><div id="root"></div></body>\n</html>\n`;
  writeFileSync(join(path, 'index.html'), page(tags));
  if (options.worker !== 'absent') {
    const workerPreload = options.worker?.preload;
    if (workerPreload !== undefined) {
      writeFileSync(join(path, 'assets', 'worker-preload.js'), workerPreload);
    }
    writeFileSync(
      join(path, 'worker.html'),
      page(
        options.worker === undefined
          ? tags
          : [
              '<script type="module" crossorigin src="/assets/entry.js"></script>',
              ...(workerPreload === undefined
                ? []
                : ['<link rel="modulepreload" href="/assets/worker-preload.js">']),
              '<link rel="stylesheet" crossorigin href="/assets/styles.css">',
            ].join('\n    '),
      ),
    );
  }

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

  it('refuses React Flow in an initial asset and admits it in a lazy chunk (S-23.5)', () => {
    // The marker is React Flow's class prefix, which its minified code and its stylesheet carry.
    const leaked = buildDist({
      entry: 'a'.repeat(500),
      styles: 'b'.repeat(200),
      preload: 'const c = "react-flow__node";',
    });
    const refused = run(['--dist', leaked.path, '--budget-bytes', '300000']);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('FAIL: bundle:check');
    expect(refused.stderr).toContain('@xyflow/react is in the initial graph (/assets/preload.js)');

    // The same text in the stylesheet `index.html` links is refused too.
    const styled = buildDist({ entry: 'a', styles: '.react-flow__edge{stroke:red}' });
    expect(run(['--dist', styled.path]).stderr).toContain(
      '@xyflow/react is in the initial graph (/assets/styles.css)',
    );

    const lazy = buildDist({
      entry: 'a'.repeat(500),
      styles: 'b'.repeat(200),
      lazy: 'const c = "react-flow__node";',
    });
    const admitted = run(['--dist', lazy.path, '--budget-bytes', '300000']);
    expect(admitted.status).toBe(0);
    expect(admitted.stdout).toContain('PASS: bundle:check');
  });

  it('refuses Base UI’s Menu in an initial asset and admits it in a lazy chunk (S-25.13)', () => {
    // The marker is the `menubar` parent type the Menu's root and positioner compare against.
    const leaked = buildDist({
      entry: 'a'.repeat(500),
      styles: 'b'.repeat(200),
      preload: 'const t = n.type === `menubar`;',
    });
    const refused = run(['--dist', leaked.path, '--budget-bytes', '300000']);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('FAIL: bundle:check');
    expect(refused.stderr).toContain(
      "@base-ui/react's Menu is in the initial graph (/assets/preload.js)",
    );

    const lazy = buildDist({
      entry: 'a'.repeat(500),
      styles: 'b'.repeat(200),
      lazy: 'const t = n.type === `menubar`;',
    });
    const admitted = run(['--dist', lazy.path, '--budget-bytes', '300000']);
    expect(admitted.status).toBe(0);
    expect(admitted.stdout).toContain('PASS: bundle:check');
  });

  it('takes the Menu’s marker from Base UI’s own source, so an upgrade cannot empty the guard', () => {
    // The plant above proves the guard reads the marker; this proves the library still carries it.
    // A Base UI that renamed the parent type would otherwise let the Menu back in unrefused.
    const script = readFileSync(GUARD, 'utf8');
    const marker = /name: "@base-ui\/react's Menu", marker: '([^']+)'/.exec(script)?.[1];
    expect(marker).toBe('menubar');
    const webRequire = createRequire(join(REPOSITORY_ROOT, 'apps', 'web', 'package.json'));
    const baseUi = dirname(webRequire.resolve('@base-ui/react/package.json'));
    const menuRoot = readFileSync(join(baseUi, 'menu', 'root', 'MenuRoot.mjs'), 'utf8');
    expect(menuRoot).toContain(`'${marker as string}'`);
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

  it('measures the worker’s page on its own budget, and fails naming it (WP-292)', () => {
    const dist = buildDist({ entry: 'a'.repeat(5000), styles: 'b'.repeat(2000) });
    const passed = run(['--dist', dist.path, '--budget-bytes', '300000']);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain(
      `worker.html: ${dist.initialBytes} B gzipped over 2 initial assets, budget 125000 B`,
    );
    // Under the SPA's budget, over the worker page's: the worker page's line fails.
    const over = run([
      '--dist',
      dist.path,
      '--budget-bytes',
      '300000',
      '--worker-budget-bytes',
      '10',
    ]);
    expect(over.status).toBe(1);
    expect(over.stdout).toContain('FAIL: bundle:check');
    expect(over.stderr).toContain(
      `worker.html: the initial bundle is ${dist.initialBytes} B gzipped`,
    );
  });

  it('fails when the worker’s page is missing from the build, rather than measuring nothing', () => {
    const dist = buildDist({ entry: 'a', styles: 'b', worker: 'absent' });
    const result = run(['--dist', dist.path, '--budget-bytes', '300000']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker.html does not exist');
  });

  it('refuses the lazy visualisations in the worker page’s initial graph, and admits them in the SPA’s', () => {
    const leaked = buildDist({
      entry: 'a',
      styles: 'b',
      worker: { preload: 'const c = "office-desk office-desk--free";' },
    });
    const refused = run(['--dist', leaked.path, '--budget-bytes', '300000']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'viz/fleet (the office) is in the initial graph (/assets/worker-preload.js)',
    );
    // The SPA preloads what it likes of it: the marker in index.html's graph is no refusal.
    const spa = buildDist({
      entry: 'a',
      styles: 'b',
      preload: 'const c = "office-desk";',
      worker: {},
    });
    expect(run(['--dist', spa.path, '--budget-bytes', '300000']).status).toBe(0);
  });

  it('rejects a budget that is not a positive integer', () => {
    const dist = buildDist({ entry: 'a', styles: 'b' });

    const result = run(['--dist', dist.path, '--budget-bytes', 'lots']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--budget-bytes must be a positive integer');
  });
});
