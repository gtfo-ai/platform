#!/usr/bin/env node
/**
 * `node scripts/assert-runlet-bundle.mjs <file>` — the bundle is what TD-025 §1 asked for.
 *
 * TD-025 says the shim is "a single file … must have no runtime deps", and TD-021 says the run
 * container carries "no platform code". Both are properties of the *output*, so they are checked
 * against the output rather than against the config that produced it: a bundler option that stops
 * inlining a dependency (or a `ssr.noExternal` that gets narrowed) leaves a file that still builds,
 * still imports by name, and fails at `docker run` in a container with no `node_modules`.
 *
 * What it checks, and why each is the honest form of the claim:
 *
 *  - **every static import is a `node:` builtin.** A bare specifier is a runtime dependency; a
 *    relative one is a second file. This is the whole of "no runtime deps" as it is observable.
 *  - **no dynamic `import(` of a non-literal, and no `require(`.** A bundle that defers a
 *    dependency to run time passes the first check and fails in production, which is the failure
 *    mode this file exists for.
 *  - **the shebang survived.** The image copies this to `/usr/local/bin/agentic-runlet` and git
 *    invokes it by name (`credential.helper=!agentic-runlet credential`), so a lost `#!` line is a
 *    credential helper that cannot start.
 *
 * What it cannot check, stated rather than implied: that the bundle *behaves*. That is
 * `scripts/runlet-container-check.mjs` against the real image, and the conformance contract suite
 * against the source.
 *
 * It runs inside `docker/runtime.Dockerfile`'s build, so the check is part of producing the image
 * rather than a step somebody remembers to run.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write('usage: assert-runlet-bundle.mjs <file>\n');
  process.exit(2);
}

const source = readFileSync(file, 'utf8');
const failures = [];

if (!source.startsWith('#!/usr/bin/env node\n')) {
  failures.push(`${file} does not begin with the "#!/usr/bin/env node" line`);
}

/** Every static `import … from '<specifier>'` and bare `import '<specifier>'`, at line start. */
const specifiers = [
  ...source.matchAll(/^import\s+[^;]*?from\s*["']([^"']+)["']/gm),
  ...source.matchAll(/^import\s*["']([^"']+)["']/gm),
].map((match) => match[1]);
const external = [...new Set(specifiers.filter((name) => !name.startsWith('node:')))];
if (external.length > 0) {
  failures.push(`${file} imports ${external.length} non-builtin module(s): ${external.join(', ')}`);
}

// A dynamic import of a literal `node:` builtin is fine; anything else defers a dependency to run
// time, where the container has no `node_modules` to resolve it in.
const dynamic = [...source.matchAll(/\bimport\(\s*(["'`])?([^)"'`]*)/g)]
  .filter((match) => match[1] === undefined || !String(match[2]).startsWith('node:'))
  .map((match) => `import(${String(match[2]).slice(0, 40)})`);
const required = [...source.matchAll(/\brequire\(\s*["']([^"']+)["']/g)].map(
  (match) => `require(${match[1]})`,
);
if (dynamic.length > 0 || required.length > 0) {
  failures.push(
    `${file} resolves modules at run time: ${[...dynamic, ...required].slice(0, 5).join(', ')}`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`FAIL: ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `PASS: ${file} is a standalone bundle (${source.length} bytes, ${specifiers.length} builtin imports)\n`,
);
