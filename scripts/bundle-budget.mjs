#!/usr/bin/env node
/**
 * The bundle budget of TD-013, enforced rather than remembered.
 *
 * > "Bundle budget ≤ 300 kB gz initial; diff and editor routes lazy." — TD-013, repeated in
 * > technical/09 § Testing.
 *
 * It is an **acceptance criterion of WP-20**, so it fails the build rather than warning: a budget
 * that prints a yellow line is a budget nobody notices being crossed. It is a step of
 * `verify:bundle`, which is a group of `pnpm run -s verify` and therefore a CI job of its own
 * (`scripts/verify-targets.ts` — a step cannot be in `verify` and missing from CI, standing rule
 * 34).
 *
 * ## What is measured, and why that is the honest quantity
 *
 * The **initial graph**: everything a browser must fetch before it can render the first screen.
 * That is exactly the set Vite writes into `dist/index.html` — the entry `<script type="module">`,
 * every `<link rel="modulepreload">` it emits beside it, and every `<link rel="stylesheet">`. A
 * chunk reached only by a dynamic `import()` (the run route) is *not* in that set and is not
 * counted, which is the whole point of making it lazy.
 *
 * Reading `index.html` rather than summing `dist/assets/**` is deliberate: summing the directory
 * would count the lazy chunks and make the budget indifferent to whether anything is lazy at all.
 * Reading the manifest instead would measure what Vite *recorded* rather than what the page
 * *requests*, and the page is what a user waits for.
 *
 * **Gzip, at the default level.** The bytes on the wire depend on the reverse proxy's compressor
 * and its level, so no number computed here is the number a user downloads. What this needs is a
 * *comparable* one: `zlib.gzipSync` at its default level, applied the same way on every run, so a
 * change in the number is a change in the bundle. Brotli would be smaller and equally arbitrary.
 *
 * **300 kB means 300 000 bytes.** "kB" is the SI kilobyte and TD-013 writes it that way; reading it
 * as 300 × 1024 would grant 7 168 bytes the decision did not. The stricter reading is the one that
 * cannot be accused of moving the goalposts, so it is the one taken, and it is stated here because
 * the same ambiguity cost `sse/hub.ts` a corrected figure.
 *
 * ## Why an empty measurement is a failure
 *
 * A regex that matched nothing would report 0 bytes and pass for ever (standing rule 4). So: no
 * `index.html`, no assets found in it, or an asset the parser named that is not on disk are all
 * failures with their own message.
 *
 * Usage:
 *   node scripts/bundle-budget.mjs                     build, then measure apps/web/dist
 *   node scripts/bundle-budget.mjs --no-build          measure whatever is already in dist
 *   node scripts/bundle-budget.mjs --dist <dir>        measure a directory (used by the test)
 *   node scripts/bundle-budget.mjs --budget-bytes <n>  override the budget (used by the test)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const TARGET = 'bundle:check';

/** TD-013, in SI kilobytes. */
export const BUDGET_BYTES = 300_000;

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every asset `index.html` makes the browser fetch before first render.
 *
 * Exported and pure so the parse can be tested against fixed HTML: the thing that silently breaks
 * a budget check is a pattern that stops matching, and a pattern that stops matching reports a
 * smaller number rather than an error.
 */
export const initialAssets = (html) => {
  const found = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    // Only module scripts: a classic `<script>` Vite did not emit is not part of the graph it
    // controls, and there are none today.
    if (/\btype\s*=\s*["']module["']/i.test(match[0])) {
      found.push(match[1]);
    }
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'](modulepreload|stylesheet)["']/i.test(tag)) {
      continue;
    }
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (href !== null) {
      found.push(href[1]);
    }
  }
  return [...new Set(found)];
};

/** `/assets/index-abc.js` in a built page is `<dist>/assets/index-abc.js` on disk. */
export const assetPath = (dist, href) => join(dist, normalize(href.replace(/^\/+/, '')));

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.stdout.write(`FAIL: ${TARGET}\n`);
  process.exit(1);
};

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const dist = resolve(repositoryRoot, argument('--dist', 'apps/web/dist'));
const budget = Number.parseInt(argument('--budget-bytes', String(BUDGET_BYTES)), 10);
const shouldBuild = !process.argv.includes('--no-build') && process.argv.indexOf('--dist') === -1;

if (!Number.isInteger(budget) || budget <= 0) {
  fail(
    `--budget-bytes must be a positive integer, got ${JSON.stringify(argument('--budget-bytes'))}`,
  );
}

if (shouldBuild) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const build = spawnSync(pnpm, ['--filter', '@platform/web', 'run', 'build'], {
    cwd: repositoryRoot,
    stdio: ['ignore', 2, 'inherit'],
    env: process.env,
  });
  if (build.error) {
    fail(`the web build could not be started: ${build.error.message}`);
  }
  if (build.status !== 0) {
    fail(`the web build failed with ${build.status ?? `signal ${build.signal}`}`);
  }
}

const indexHtml = join(dist, 'index.html');
if (!existsSync(indexHtml)) {
  fail(`${indexHtml} does not exist; run the build first (or pass --dist)`);
}

const assets = initialAssets(readFileSync(indexHtml, 'utf8'));
if (assets.length === 0) {
  // A budget computed over nothing is not a budget (standing rule 4).
  fail(`no module script and no stylesheet was found in ${indexHtml}; the parser matched nothing`);
}

let total = 0;
const rows = [];
for (const href of assets) {
  const path = assetPath(dist, href);
  if (!existsSync(path)) {
    fail(`${indexHtml} references ${href}, which is not in ${dist}`);
  }
  const bytes = gzipSync(readFileSync(path)).byteLength;
  total += bytes;
  rows.push(`  ${href}  ${bytes} B gz`);
}

process.stderr.write(`${rows.join('\n')}\n`);

if (total > budget) {
  fail(
    `the initial bundle is ${total} B gzipped, over the ${budget} B budget of TD-013 by ${total - budget} B.\n` +
      'Make a route lazy (see routes/tree.tsx) rather than raising the number.',
  );
}

process.stdout.write(
  `PASS: ${TARGET} (${total} B gzipped over ${assets.length} initial assets, budget ${budget} B)\n`,
);
