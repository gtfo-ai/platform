#!/usr/bin/env node
/**
 * `node scripts/command-corpus.mjs [--write]` — the agent-line corpus's verdicts (WP-208, TD-030
 * decision 4).
 *
 * Every `test/fixtures/commands/<name>.txt` is a corpus, one command per line, and
 * `<name>.verdicts.json` beside it records each line's three cells — attended, `auto`, `deny` —
 * as the default policy answers them (`packages/domain/src/testing/command-corpus.ts`). With
 * `--write` it regenerates every verdicts file; without it, it prints the cells that differ from
 * the recorded ones and exits 1 when any does. Refuses a missing corpus, a blank line and a repeated
 * one. Nothing executes: the cells are the policy's answers.
 *
 * A scanner change that moves a cell regenerates the file in the same change and records the three
 * counts this prints (`policies/command-corpus.test.ts` prints the same diff when it is forgotten).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import './ts-source-resolver.mjs';

const { corpusDiff, corpusLines, verdictsText } = await import(
  '../packages/domain/src/testing/command-corpus.ts'
);

const DIRECTORY = new URL('../test/fixtures/commands/', import.meta.url);
const write = process.argv.includes('--write');

const corpora = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith('.txt'))
  .sort();
if (corpora.length === 0) {
  process.stderr.write(`FAIL: command-corpus — no corpus in ${DIRECTORY.pathname}\n`);
  process.exit(1);
}

let changed = 0;
for (const corpus of corpora) {
  const file = `test/fixtures/commands/${corpus}`;
  const lines = corpusLines(readFileSync(new URL(corpus, DIRECTORY), 'utf8'), file);
  const target = new URL(corpus.replace(/\.txt$/, '.verdicts.json'), DIRECTORY);
  if (write) {
    writeFileSync(target, verdictsText(lines));
    process.stdout.write(
      `wrote ${file.replace(/\.txt$/, '.verdicts.json')} (${lines.length} lines)\n`,
    );
    continue;
  }
  const { changes, newlyRefused, newlyAllowed, newlyAsked } = corpusDiff(
    JSON.parse(readFileSync(target, 'utf8')),
    lines,
  );
  for (const { line, cell, before, after } of changes) {
    process.stdout.write(`${JSON.stringify(line)} | ${cell} | ${before} | ${after}\n`);
  }
  process.stdout.write(
    `${file}: ${changes.length} cells changed, ${newlyRefused} newly refused, ${newlyAllowed} newly allowed, ${newlyAsked} newly asked\n`,
  );
  changed += changes.length;
}
process.stdout.write(`${changed === 0 || write ? 'PASS' : 'FAIL'}: command-corpus\n`);
process.exit(changed === 0 || write ? 0 : 1);
