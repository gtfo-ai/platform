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
 * **Gzip, at the default level.** What this needs is a *comparable* number: `zlib.gzipSync` at its
 * default level, applied the same way on every run, so a change in it is a change in the bundle.
 * It is **close to** the number a user downloads and still not it: since WP-15j's review the app
 * process codes the bundle itself (`apps/server/src/web/encoding.ts`) at gzip level 9, or brotli
 * when the browser offers it, so a real download is smaller than this figure — and a reverse proxy
 * an operator puts in front may recompress at a level of its own. The budget is deliberately the
 * conservative side of all three.
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
 * ## And what must not be in it at all
 *
 * A library TD-033 makes lazy (`LAZY_ONLY`, today `@xyflow/react` — and, since S-25.13, Base UI's
 * Menu) is refused in any initial asset by a marker string of its own, whatever the total — a
 * budget with room to spare would otherwise absorb it silently.
 *
 * ## Two pages, two budgets (WP-292)
 *
 * `apps/web` has a second entry, `worker.html` — the worker's local page, served by a remote worker
 * on `127.0.0.1` (TD-031's worker-UI amendment §3) — with a budget of its own: **≤ 120 kB gz**. Both
 * pages are measured the same way, and **both must exist**: a build that lost the second entry is a
 * failure, not a page with nothing to measure. The worker's page must also carry nothing of the
 * lazy visualisations (`viz/*`) in its initial graph, refused by a marker of their own
 * (`WORKER_FORBIDDEN`), however small the total stays.
 *
 * Usage:
 *   node scripts/bundle-budget.mjs                            build, then measure apps/web/dist
 *   node scripts/bundle-budget.mjs --no-build                 measure whatever is already in dist
 *   node scripts/bundle-budget.mjs --dist <dir>               measure a directory (used by the test)
 *   node scripts/bundle-budget.mjs --budget-bytes <n>         override the SPA's budget (the test)
 *   node scripts/bundle-budget.mjs --worker-budget-bytes <n>  override the worker page's (the test)
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

/** The worker's local page (TD-031's worker-UI amendment §3, WP-292), in SI kilobytes. */
export const WORKER_BUDGET_BYTES = 120_000;

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

/**
 * Libraries that must never be in the initial graph, however small the total stays (TD-033
 * decision 10: the flow canvas is a lazy chunk). Each is named by a string its **own** code carries
 * — React Flow's class prefix is in every component it renders and in its stylesheet — so a static
 * import that pulled it into a chunk `index.html` requests fails here by name, even while the
 * budget still holds. A marker that stopped matching would make this check pass vacuously, which
 * `scripts/bundle-budget.test.ts` covers by planting it.
 */
export const LAZY_ONLY = [
  { name: '@xyflow/react', marker: 'react-flow__' },
  // Base UI's Menu (S-25.13): 21 kB of the initial graph until `ui/action-menu.tsx` loaded it with
  // `import()` (`ui/action-menu-base.tsx`). Its root and positioner ask whether the parent is a
  // `menubar`, a word nothing else in the application's built code carries (measured over every
  // chunk) — so a static import of `@base-ui/react/menu` from an eager module fails here by name.
  { name: "@base-ui/react's Menu", marker: 'menubar' },
];

/** `[library, asset]` for every lazy-only library found in an initial asset. */
export const lazyOnlyViolations = (contents) => {
  const found = [];
  for (const { href, text } of contents) {
    for (const { name, marker } of LAZY_ONLY) {
      if (text.includes(marker)) {
        found.push([name, href]);
      }
    }
  }
  return found;
};

/**
 * What must never be in the worker page's initial graph (WP-292): the lazy visualisations of
 * `viz/*` — named by a class their own code carries (the office's desk) — and React Flow.
 */
export const WORKER_FORBIDDEN = [
  { name: 'viz/fleet (the office)', marker: 'office-desk' },
  ...LAZY_ONLY,
];

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
const budgetOf = (flag, fallback) => {
  const raw = argument(flag, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    fail(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};
const pages = [
  {
    file: 'index.html',
    budget: budgetOf('--budget-bytes', BUDGET_BYTES),
    decision: 'TD-013',
    forbidden: LAZY_ONLY,
    advice: 'Make a route lazy (see routes/tree.tsx) rather than raising the number.',
  },
  {
    file: 'worker.html',
    budget: budgetOf('--worker-budget-bytes', WORKER_BUDGET_BYTES),
    decision: 'TD-031’s worker-UI amendment',
    forbidden: WORKER_FORBIDDEN,
    advice:
      'The worker’s page imports ui/* only: find what pulled more in rather than raising the number.',
  },
];
const shouldBuild = !process.argv.includes('--no-build') && process.argv.indexOf('--dist') === -1;

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

/** One page's initial graph: its total and its assets' contents. */
const measure = (page) => {
  const html = join(dist, page.file);
  if (!existsSync(html)) {
    fail(`${html} does not exist; run the build first (or pass --dist)`);
  }
  const assets = initialAssets(readFileSync(html, 'utf8'));
  if (assets.length === 0) {
    // A budget computed over nothing is not a budget (standing rule 4).
    fail(`no module script and no stylesheet was found in ${html}; the parser matched nothing`);
  }
  let total = 0;
  const rows = [];
  const contents = [];
  for (const href of assets) {
    const path = assetPath(dist, href);
    if (!existsSync(path)) {
      fail(`${html} references ${href}, which is not in ${dist}`);
    }
    const body = readFileSync(path);
    const bytes = gzipSync(body).byteLength;
    total += bytes;
    rows.push(`  ${page.file} ${href}  ${bytes} B gz`);
    contents.push({ href, text: body.toString('utf8') });
  }
  process.stderr.write(`${rows.join('\n')}\n`);
  const leaked = [];
  for (const { href, text } of contents) {
    for (const { name, marker } of page.forbidden) {
      if (text.includes(marker)) leaked.push([name, href]);
    }
  }
  if (leaked.length > 0) {
    fail(
      `${leaked.map(([name, href]) => `${name} is in the initial graph (${href})`).join('; ')}.\n` +
        'It must stay in a lazy chunk: import it only from a module loaded with import().',
    );
  }
  if (total > page.budget) {
    fail(
      `${page.file}: the initial bundle is ${total} B gzipped, over the ${page.budget} B budget of ${page.decision} by ${total - page.budget} B.\n` +
        page.advice,
    );
  }
  return `${page.file}: ${total} B gzipped over ${assets.length} initial assets, budget ${page.budget} B`;
};

const lines = pages.map(measure);
process.stdout.write(`PASS: ${TARGET} (${lines.join('; ')})\n`);
