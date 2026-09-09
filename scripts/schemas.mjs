#!/usr/bin/env node
/**
 * `pnpm schemas` — regenerate the published JSON Schemas under `schemas/` from the zod
 * definitions in `packages/contracts` (technical/12).
 *
 *   node scripts/schemas.mjs            write the documents, reporting what changed
 *   node scripts/schemas.mjs --check    exit 1 if the committed output is stale (used by verify)
 *
 * The rendering itself lives in `packages/contracts/src/schemas.ts` so that it is covered by the
 * test suite; this file is only the CLI and the filesystem half.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import './ts-source-resolver.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'schemas');

const { renderAllJsonSchemas, renderJsonSchemaIndex, SCHEMA_INDEX_FILE } = await import(
  '../packages/contracts/src/schemas.ts'
);

const check = process.argv.includes('--check');

/** Every `.json` file currently under `schemas/`, as paths relative to that directory. */
const listCommitted = async (dir, prefix = '') => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listCommitted(path.join(dir, entry.name), rel)));
    else if (entry.name.endsWith('.json')) files.push(rel);
  }
  return files.sort();
};

const expected = renderAllJsonSchemas();
expected.set(SCHEMA_INDEX_FILE, renderJsonSchemaIndex());

const committed = await listCommitted(outDir);
const changed = [];
const added = [];

for (const [file, contents] of expected) {
  const absolute = path.join(outDir, file);
  let current = null;
  try {
    current = await readFile(absolute, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current === contents) continue;
  (current === null ? added : changed).push(file);
  if (!check) {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }
}

const removed = committed.filter((file) => !expected.has(file));
if (!check) {
  for (const file of removed) await rm(path.join(outDir, file));
}

const stale = [...added, ...changed, ...removed];

if (check) {
  if (stale.length > 0) {
    process.stderr.write(
      `schemas/ is stale — run \`pnpm run -s schemas\` and commit the result.\n${stale
        .map((file) => `  ${file}`)
        .join('\n')}\n`,
    );
    process.stdout.write('FAIL: schemas:check\n');
    process.exit(1);
  }
  process.stdout.write(`PASS: schemas:check (${expected.size} documents up to date)\n`);
} else if (stale.length === 0) {
  process.stdout.write(`schemas: ${expected.size} documents already up to date.\n`);
} else {
  process.stdout.write(
    `schemas: wrote ${added.length} new, ${changed.length} changed, removed ${removed.length}.\n`,
  );
}
